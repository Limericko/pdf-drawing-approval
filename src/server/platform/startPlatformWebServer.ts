import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { Express } from "express";
import { createAuthenticationService } from "../modules/identity/authenticationService.ts";
import { createAuthorizationService } from "../modules/identity/authorizationService.ts";
import { createInvitationService } from "../modules/identity/invitationService.ts";
import { createSessionService } from "./security/sessionService.ts";
import { loadPlatformConfig } from "./config/loadPlatformConfig.ts";
import type { WebPlatformConfig } from "./config/types.ts";
import { loadMigrationFiles, type MigrationFile } from "./database/migrationFiles.ts";
import { createPlatformPool, type PlatformPool } from "./database/pool.ts";
import { assertExpectedSchema } from "./database/schemaVersion.ts";
import { createStorage } from "./storage/createStorage.ts";
import type { StorageAdapter } from "./storage/storageAdapter.ts";
import { createPlatformEmergencySink, createPlatformSecurityLogger, createPlatformServer,
  type CreatePlatformServerOptions } from "./server.ts";

const passwordHashOptions = Object.freeze({ memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });

type PlatformServices = CreatePlatformServerOptions["services"];
type PlatformLogger = CreatePlatformServerOptions["logger"];

type StartPlatformDependencies = {
  readonly loadConfig: (env: NodeJS.ProcessEnv, target: "web") => WebPlatformConfig;
  readonly createPool: (config: WebPlatformConfig["database"], applicationName: string) => PlatformPool;
  readonly loadMigrations: () => Promise<MigrationFile[]>;
  readonly assertSchema: (pool: PlatformPool, migrations: readonly MigrationFile[]) => Promise<void>;
  readonly createStorage: (config: WebPlatformConfig["storage"]) => StorageAdapter;
  readonly createServices: (config: WebPlatformConfig, pool: PlatformPool, logger: PlatformLogger) => PlatformServices;
  readonly createApp: (options: CreatePlatformServerOptions) => Express;
};

export type StartPlatformWebServerOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly port?: number;
  readonly clientDist?: string;
  readonly dependencies?: Partial<StartPlatformDependencies>;
};

export interface PlatformWebServer extends HttpServer {
  closeAsync(): Promise<void>;
}

export async function startPlatformWebServer(
  options: StartPlatformWebServerOptions = {}
): Promise<PlatformWebServer> {
  const dependencies: StartPlatformDependencies = { ...defaultDependencies, ...options.dependencies };
  const env = options.env ?? process.env;
  const config = dependencies.loadConfig(env, "web");
  const logger = createPlatformSecurityLogger();
  const emergencySink = createPlatformEmergencySink();
  let pool: PlatformPool;
  try {
    pool = dependencies.createPool(config.database, "pdf-approval-platform-web");
  } catch (error) {
    throw sanitizeLifecycleError(error, "PLATFORM_POOL_CREATE_FAILED");
  }
  let storage: StorageAdapter | undefined;
  let server: HttpServer | undefined;
  try {
    const migrations = await dependencies.loadMigrations();
    await dependencies.assertSchema(pool, migrations);
    storage = dependencies.createStorage(config.storage);
    await storage.checkHealth();
    const services = dependencies.createServices(config, pool, logger);
    const app = dependencies.createApp({
      config,
      services,
      logger,
      emergencySink,
      clientDist: options.clientDist,
      health: {
        core: {
          postgres: async () => { await pool.query("SELECT 1"); },
          schema: () => dependencies.assertSchema(pool, migrations),
          storage: () => storage!.checkHealth()
        }
      }
    });
    server = await listen(app, options.port ?? resolvePort(env.PORT), options.host ?? "0.0.0.0");
    return attachLifecycle(server, () => closeResources(storage, pool), logger, emergencySink);
  } catch (primaryError) {
    const sanitizedPrimary = sanitizeLifecycleError(primaryError, "PLATFORM_WEB_START_FAILED");
    const cleanupError = await captureCleanup(storage, pool);
    if (cleanupError) {
      const sanitizedCleanup = sanitizeLifecycleError(cleanupError, "PLATFORM_WEB_RESOURCE_CLEANUP_FAILED");
      throw new AggregateError([sanitizedPrimary, sanitizedCleanup], "PLATFORM_WEB_STARTUP_CLEANUP_FAILED", {
        cause: sanitizedPrimary
      });
    }
    throw sanitizedPrimary;
  }
}

const defaultDependencies: StartPlatformDependencies = {
  loadConfig: loadPlatformConfig,
  createPool: createPlatformPool,
  loadMigrations: loadMigrationFiles,
  assertSchema: assertExpectedSchema,
  createStorage,
  createServices: createServices,
  createApp: createPlatformServer
};

function createServices(config: WebPlatformConfig, pool: PlatformPool, logger: PlatformLogger): PlatformServices {
  return Object.freeze({
    authentication: createAuthenticationService({
      pool,
      keyrings: { totpEncryption: config.keyrings.totpEncryption, recoveryHmac: config.keyrings.recoveryHmac },
      passwordHashOptions,
      logger
    }),
    sessions: createSessionService({ pool, passwordHashOptions }),
    invitations: createInvitationService({
      pool,
      keyrings: {
        totpEncryption: config.keyrings.totpEncryption,
        invitationHmac: config.keyrings.invitationHmac,
        recoveryHmac: config.keyrings.recoveryHmac
      },
      passwordHashOptions
    }),
    authorization: createAuthorizationService({ pool })
  });
}

function listen(app: Express, port: number, host: string) {
  return new Promise<HttpServer>((resolve, reject) => {
    let server: HttpServer;
    try {
      server = app.listen(port, host);
    } catch (error) {
      reject(error);
      return;
    }
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function attachLifecycle(
  server: HttpServer,
  closeResourcesOnce: () => Promise<void>,
  logger: PlatformLogger,
  emergencySink: CreatePlatformServerOptions["emergencySink"]
): PlatformWebServer {
  const platformServer = server as PlatformWebServer;
  const originalClose = server.close.bind(server);
  let closeInFlight: Promise<void> | undefined;
  const closeAsync = () => {
    if (!closeInFlight) {
      closeInFlight = (async () => {
        let httpFailure: Error | undefined;
        let resourceFailure: Error | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            if (!server.listening) {
              resolve();
              return;
            }
            originalClose((error) => error ? reject(error) : resolve());
          });
        } catch (error) {
          httpFailure = sanitizeLifecycleError(error, "PLATFORM_HTTP_CLOSE_FAILED");
        }
        try {
          await closeResourcesOnce();
        } catch (error) {
          resourceFailure = sanitizeLifecycleError(error, "PLATFORM_WEB_RESOURCE_CLEANUP_FAILED");
        }
        if (httpFailure && resourceFailure) {
          throw new AggregateError([httpFailure, resourceFailure], "PLATFORM_WEB_CLOSE_FAILED", {
            cause: httpFailure
          });
        }
        if (httpFailure) throw httpFailure;
        if (resourceFailure) throw resourceFailure;
      })();
    }
    return closeInFlight;
  };
  platformServer.closeAsync = closeAsync;
  platformServer.close = ((callback?: (error?: Error) => void) => {
    void closeAsync().then(
      () => callback?.(),
      (error: unknown) => {
        const owned = error instanceof Error ? error : new Error("PLATFORM_WEB_CLOSE_FAILED");
        if (callback) callback(owned);
        else reportLifecycleFailure(logger, emergencySink);
      }
    );
    return platformServer;
  }) as PlatformWebServer["close"];
  return platformServer;
}

async function closeResources(storage: StorageAdapter | undefined, pool: PlatformPool) {
  const failures: Error[] = [];
  try {
    await destroyStorage(storage);
  } catch {
    failures.push(new Error("PLATFORM_STORAGE_CLOSE_FAILED"));
  }
  try {
    await pool.end();
  } catch {
    failures.push(new Error("PLATFORM_POOL_CLOSE_FAILED"));
  }
  if (failures.length > 0) throw new AggregateError(failures, "PLATFORM_WEB_RESOURCE_CLEANUP_FAILED");
}

async function captureCleanup(storage: StorageAdapter | undefined, pool: PlatformPool) {
  try {
    await closeResources(storage, pool);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function destroyStorage(storage: StorageAdapter | undefined) {
  if (storage && "destroy" in storage && typeof storage.destroy === "function") await storage.destroy();
}

function reportLifecycleFailure(
  logger: PlatformLogger,
  emergencySink: CreatePlatformServerOptions["emergencySink"]
) {
  const requestId = randomUUID();
  try {
    logger.error({ requestId, code: "PLATFORM_WEB_CLOSE_FAILED" });
  } catch {
    emergencySink({ requestId, code: "LOGGER_FAILURE" });
  }
}

function resolvePort(raw: string | undefined) {
  if (raw === undefined || raw === "") return 8080;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new Error("PLATFORM_WEB_PORT_INVALID");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new Error("PLATFORM_WEB_PORT_INVALID");
  return port;
}

function sanitizeLifecycleError(error: unknown, fallbackCode: string): Error & { readonly code?: string } {
  if (error instanceof AggregateError) {
    const message = safeErrorToken(error.message) ?? fallbackCode;
    const errors = Array.from(error.errors, (entry) => sanitizeLifecycleError(entry, fallbackCode));
    const cause = error.cause === undefined || error.cause === error
      ? undefined
      : sanitizeLifecycleError(error.cause, fallbackCode);
    return new AggregateError(errors, message, cause ? { cause } : undefined);
  }
  const code = safeErrorToken(error && typeof error === "object" && "code" in error ? error.code : undefined) ??
    safeErrorToken(error instanceof Error ? error.message : undefined) ?? fallbackCode;
  const sanitized = new Error(code) as Error & { readonly code?: string };
  sanitized.name = "PlatformLifecycleError";
  Object.defineProperty(sanitized, "code", { configurable: false, enumerable: true, value: code });
  return sanitized;
}

function safeErrorToken(value: unknown) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : undefined;
}
