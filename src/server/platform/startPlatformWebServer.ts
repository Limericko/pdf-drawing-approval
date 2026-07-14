import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { Express } from "express";
import type { QueryConfig, QueryResultRow } from "pg";
import { v7 as uuidv7 } from "uuid";
import { createAuthenticationService } from "../modules/identity/authenticationService.ts";
import { createAuthorizationService } from "../modules/identity/authorizationService.ts";
import { createInvitationService } from "../modules/identity/invitationService.ts";
import { createApprovalService } from "../modules/approvals/approvalService.ts";
import { createTaskService } from "../modules/tasks/taskService.ts";
import { createPdmService } from "../modules/pdm/pdmService.ts";
import { createSignatureService } from "../modules/signatures/signatureService.ts";
import { createIssueService } from "../modules/issues/issueService.ts";
import { createAdministrationService } from "../modules/administration/administrationService.ts";
import { createPrintArchiveService } from "../modules/approvals/printArchiveService.ts";
import { createWebDavSyncService } from "../modules/sync/webDavSyncService.ts";
import { createWebDavEndpointPolicy } from "../modules/sync/webDavEndpointPolicy.ts";
import { createSessionService } from "./security/sessionService.ts";
import { loadPlatformConfig } from "./config/loadPlatformConfig.ts";
import type { WebPlatformConfig } from "./config/types.ts";
import { loadMigrationFiles, type MigrationFile } from "./database/migrationFiles.ts";
import { createPlatformPool, type PlatformPool } from "./database/pool.ts";
import type { QueryExecutor } from "./database/queryExecutor.ts";
import { withTransaction } from "./database/transaction.ts";
import { PostgresOutboxPublisher } from "./jobs/outboxPublisher.ts";
import { assertExpectedSchema } from "./database/schemaVersion.ts";
import { createStorage } from "./storage/createStorage.ts";
import { StorageObjectService } from "./storage/storageObjectService.ts";
import { PostgresStorageObjectRepository } from "./storage/postgres/PostgresStorageObjectRepository.ts";
import { createStorageAccessService } from "./storage/storageAccessService.ts";
import type { StorageAdapter } from "./storage/storageAdapter.ts";
import { createPlatformEmergencySink, createPlatformSecurityLogger, createPlatformServer,
  type CreatePlatformServerOptions } from "./server.ts";
import { publicBasePath } from "./health.ts";

const passwordHashOptions = Object.freeze({ memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });
const STARTUP_GATE_TIMEOUT_MS = 2_000;
const STARTUP_QUERY_TIMEOUT_MS = STARTUP_GATE_TIMEOUT_MS + 100;
const STARTUP_ABORT_SETTLE_TIMEOUT_MS = 500;
const HTTP_GRACEFUL_CLOSE_TIMEOUT_MS = 1_000;
const HTTP_FORCE_CLOSE_TIMEOUT_MS = 2_000;
const RESOURCE_CLEANUP_TIMEOUT_MS = 2_000;
const WORKER_HEALTH_FRESHNESS_SECONDS = 120;
const publicLifecycleErrorCodes = new Set([
  "PLATFORM_HTTP_CLOSE_FAILED",
  "PLATFORM_HTTP_CLOSE_TIMEOUT",
  "PLATFORM_POOL_CLOSE_TIMEOUT",
  "PLATFORM_POOL_CLOSE_FAILED",
  "PLATFORM_STORAGE_CLOSE_FAILED",
  "PLATFORM_STORAGE_CLOSE_TIMEOUT",
  "PLATFORM_STARTUP_SCHEMA_TIMEOUT",
  "PLATFORM_STARTUP_STORAGE_TIMEOUT",
  "PLATFORM_WEB_CLOSE_FAILED",
  "PLATFORM_WEB_PORT_INVALID",
  "PLATFORM_WEB_RESOURCE_CLEANUP_FAILED",
  "SCHEMA_VERSION_AHEAD",
  "SCHEMA_VERSION_BEHIND",
  "SCHEMA_VERSION_METADATA_MISSING",
  "SCHEMA_VERSION_MISMATCH",
  "STORAGE_HEALTH_CHECK_FAILED"
]);

type PlatformServices = CreatePlatformServerOptions["services"];
type PlatformLogger = CreatePlatformServerOptions["logger"];

type StartPlatformDependencies = {
  readonly loadConfig: (env: NodeJS.ProcessEnv, target: "web") => WebPlatformConfig;
  readonly createPool: (config: WebPlatformConfig["database"], applicationName: string) => PlatformPool;
  readonly loadMigrations: () => Promise<MigrationFile[]>;
  readonly assertSchema: (pool: PlatformPool, migrations: readonly MigrationFile[], gate?: {
    readonly signal: AbortSignal;
    readonly queryTimeoutMs: number;
  }) => Promise<void>;
  readonly createStorage: (config: WebPlatformConfig["storage"]) => StorageAdapter;
  readonly createServices: (config: WebPlatformConfig, pool: PlatformPool, logger: PlatformLogger,
    storage: StorageAdapter) => PlatformServices;
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
    await runStartupGate(
      (signal) => dependencies.assertSchema(pool, migrations, { signal, queryTimeoutMs: STARTUP_QUERY_TIMEOUT_MS }),
      "PLATFORM_STARTUP_SCHEMA_TIMEOUT"
    );
    storage = dependencies.createStorage(config.storage);
    await runStartupGate((signal) => storage!.checkHealth({ signal }), "PLATFORM_STARTUP_STORAGE_TIMEOUT");
    const services = dependencies.createServices(config, pool, logger, storage);
    const app = dependencies.createApp({
      config,
      services,
      logger,
      emergencySink,
      clientDist: options.clientDist,
      health: {
        basePath: publicBasePath(config.publicBaseUrl),
        core: {
          postgres: async () => { await pool.query("SELECT 1"); },
          schema: () => dependencies.assertSchema(pool, migrations, {
            signal: AbortSignal.timeout(STARTUP_GATE_TIMEOUT_MS),
            queryTimeoutMs: STARTUP_GATE_TIMEOUT_MS
          }),
          storage: () => storage!.checkHealth()
        },
        advisory: {
          worker: () => probePersistedWorkerHealth(pool, "worker"),
          smtp: () => probePersistedWorkerHealth(pool, "smtp")
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
  assertSchema: (pool, migrations, gate) => assertExpectedSchema(
    boundedQueryExecutor(pool, gate?.queryTimeoutMs ?? STARTUP_QUERY_TIMEOUT_MS),
    migrations
  ),
  createStorage,
  createServices: createServices,
  createApp: createPlatformServer
};

function createServices(config: WebPlatformConfig, pool: PlatformPool, logger: PlatformLogger,
  storage: StorageAdapter): PlatformServices {
  const storageObjects = new StorageObjectService({
    storage,
    transactionRunner: (callback) => withTransaction(pool, callback),
    createRepository: (executor) => new PostgresStorageObjectRepository(executor)
  });
  return Object.freeze({
    approvals: createApprovalService({ pool }),
    tasks: createTaskService({ pool }),
    pdm: createPdmService({ pool }),
    signatures: createSignatureService({ pool }),
    issues: createIssueService({ pool }),
    administration: createAdministrationService({ pool, storageHealth: () => storage.checkHealth() }),
    printArchive: createPrintArchiveService({ pool }),
    webDavSync: createWebDavSyncService({ pool,
      publisher: new PostgresOutboxPublisher({ createId: uuidv7, clock: () => new Date() }),
      allowEndpoint: createWebDavEndpointPolicy({ environment: config.environment,
        allowedHosts: config.webdavAllowedHosts }) }),
    storageObjects,
    storageAccess: createStorageAccessService({ pool, storageObjects }),
    authentication: createAuthenticationService({
      pool,
      keyrings: { totpEncryption: config.keyrings.totpEncryption, recoveryHmac: config.keyrings.recoveryHmac },
      passwordHashOptions,
      session: config.session,
      logger
    }),
    sessions: createSessionService({ pool, passwordHashOptions, session: config.session }),
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

async function probePersistedWorkerHealth(pool: PlatformPool, dependency: "worker" | "smtp") {
  const result = await pool.query<{ worker_healthy: boolean; smtp_healthy: boolean }>(
    `SELECT
       coalesce(last_heartbeat_at >= clock_timestamp() - ($1::integer * interval '1 second'), false)
         AS worker_healthy,
       coalesce(
         smtp_healthy_at >= clock_timestamp() - ($1::integer * interval '1 second')
         AND (smtp_unhealthy_at IS NULL OR smtp_healthy_at > smtp_unhealthy_at),
         false
       ) AS smtp_healthy
     FROM platform.worker_health`,
    [WORKER_HEALTH_FRESHNESS_SECONDS]
  );
  const row = result.rows[0];
  if (!row?.[`${dependency}_healthy`]) throw new Error("PLATFORM_ADVISORY_UNHEALTHY");
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
          await closeHttpServer(server, originalClose);
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

function closeHttpServer(server: HttpServer, originalClose: HttpServer["close"]): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const gracefulTimer = setTimeout(forceClose, HTTP_GRACEFUL_CLOSE_TIMEOUT_MS);
    const hardTimer = setTimeout(() => finish(Object.assign(
      new Error("PLATFORM_HTTP_CLOSE_TIMEOUT"),
      { code: "PLATFORM_HTTP_CLOSE_TIMEOUT" }
    )), HTTP_FORCE_CLOSE_TIMEOUT_MS);
    gracefulTimer.unref?.();
    hardTimer.unref?.();
    try {
      originalClose((error) => finish(error));
    } catch (error) {
      finish(error instanceof Error ? error : new Error("PLATFORM_HTTP_CLOSE_FAILED"));
    }

    function forceClose() {
      try { server.closeIdleConnections(); } catch { /* hard deadline remains authoritative */ }
      try { server.closeAllConnections(); } catch { /* hard deadline remains authoritative */ }
    }

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(gracefulTimer);
      clearTimeout(hardTimer);
      if (error) reject(error);
      else resolve();
    }
  });
}

async function closeResources(storage: StorageAdapter | undefined, pool: PlatformPool) {
  const failures: Error[] = [];
  try {
    await runCleanupGate(() => destroyStorage(storage), "PLATFORM_STORAGE_CLOSE_TIMEOUT");
  } catch (error) {
    failures.push(cleanupFailure(error, "PLATFORM_STORAGE_CLOSE_FAILED", "PLATFORM_STORAGE_CLOSE_TIMEOUT"));
  }
  try {
    await runCleanupGate(() => pool.end().then(() => undefined), "PLATFORM_POOL_CLOSE_TIMEOUT");
  } catch (error) {
    failures.push(cleanupFailure(error, "PLATFORM_POOL_CLOSE_FAILED", "PLATFORM_POOL_CLOSE_TIMEOUT"));
  }
  if (failures.length > 0) throw new AggregateError(failures, "PLATFORM_WEB_RESOURCE_CLEANUP_FAILED");
}

function cleanupFailure(error: unknown, failureCode: string, timeoutCode: string) {
  return error instanceof Error && "code" in error && error.code === timeoutCode
    ? error
    : new Error(failureCode);
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

async function runStartupGate(operation: (signal: AbortSignal) => Promise<void>, timeoutCode: string) {
  const controller = new AbortController();
  let dependency: Promise<void>;
  try {
    dependency = Promise.resolve(operation(controller.signal));
  } catch (error) {
    dependency = Promise.reject(error);
  }
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(Object.assign(new Error(timeoutCode), { code: timeoutCode }));
      controller.abort();
    }, STARTUP_GATE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([dependency, timeout]);
  } catch (error) {
    if (timedOut) await waitForAbortSettlement(dependency);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForAbortSettlement(dependency: Promise<void>) {
  let timer: NodeJS.Timeout | undefined;
  const boundedWait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STARTUP_ABORT_SETTLE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([dependency.catch(() => undefined), boundedWait]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runCleanupGate(operation: () => void | Promise<void>, timeoutCode: string) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(timeoutCode), { code: timeoutCode })),
      RESOURCE_CLEANUP_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedQueryExecutor(pool: PlatformPool, queryTimeoutMs: number): QueryExecutor {
  return Object.freeze({
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) {
      const query: QueryConfig & { readonly query_timeout: number } = {
        text,
        ...(values ? { values: [...values] } : {}),
        query_timeout: queryTimeoutMs
      };
      return pool.query<R>(query);
    }
  });
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
  return typeof value === "string" && publicLifecycleErrorCodes.has(value) ? value : undefined;
}
