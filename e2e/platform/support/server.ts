import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command,
  PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { v7 as uuidv7 } from "uuid";
import { startPlatformWebServer, type PlatformWebServer } from "../../../src/server/platform/startPlatformWebServer.ts";
import { loadPlatformConfig } from "../../../src/server/platform/config/loadPlatformConfig.ts";
import { createStorage as createStorageAdapter } from "../../../src/server/platform/storage/createStorage.ts";
import { createCleanupIntent, type CleanupIntentPublisher } from
  "../../../src/server/platform/storage/cleanupIntentPublisher.ts";
import type { QueryExecutor } from "../../../src/server/platform/database/queryExecutor.ts";
import type { CreateStagingStorageObject, ReadyStorageObjectContent, StorageObject } from
  "../../../src/server/platform/storage/storageObjectRepository.ts";
import { PostgresStorageObjectRepository } from
  "../../../src/server/platform/storage/postgres/PostgresStorageObjectRepository.ts";
import { createStorageKey } from "../../../src/server/platform/storage/storageKey.ts";
import { CleanupIntentOutboxPublisher, PostgresOutboxPublisher } from
  "../../../src/server/platform/jobs/outboxPublisher.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from
  "../../../src/server/platform/testing/postgresHarness.ts";
import { acquireLocalMailpitCleanupLock, createPlatformMailpit } from "./mailpit.ts";
import { assertLocalPlatformE2EEnvironment, createPlatformE2ERunEnvironment } from "./localEnvironment.ts";
import { platformStateFile, publishPlatformE2EState, publishStateBeforeStart,
  type PlatformE2EState } from "./fixtures.ts";
import { seedPlatformE2E } from "./seed.ts";
import { createPrefixedStorage } from "./storage.ts";
import { startPlatformE2EWorker, type PlatformE2EWorker } from "./worker.ts";
import { runWorkerPrefixCleanupProbe } from "./workerPrefixProbe.ts";

const API_PORT = 28080;
const WEB_PORT = 24173;
const apiUrl = `http://127.0.0.1:${API_PORT}`;
const webUrl = `http://127.0.0.1:${WEB_PORT}`;
const mailpitUrl = "http://127.0.0.1:58025";

async function main() {
  const runId = randomUUID().replaceAll("-", "");
  const storageLayout = createStorageOwnershipLayout(runId);
  const storagePrefix = storageLayout.storagePrefix;
  let mailpit: ReturnType<typeof createPlatformMailpit> | undefined;
  let mailpitLock: Awaited<ReturnType<typeof acquireLocalMailpitCleanupLock>> | undefined;
  let database: PlatformTestDatabase | undefined;
  let storage: S3PrefixLease | undefined;
  let worker: PlatformE2EWorker | undefined;
  let web: PlatformWebServer | undefined;
  let client: ChildProcess | undefined;
  let mailpitOwned = false;
  let shutdownInFlight: Promise<void> | undefined;
  let startupSettled = false;
  let settleStartup!: () => void;
  const startupFinished = new Promise<void>((resolve) => { settleStartup = resolve; });

  const shutdown = (exitCode: number) => {
    shutdownInFlight ??= (async () => {
      if (!startupSettled) await startupFinished;
      const errors: unknown[] = [];
      await capture(() => stopChild(client), errors);
      await capture(() => web?.closeAsync(), errors);
      await capture(() => worker?.stop(), errors);
      await capture(() => storage?.dispose(), errors);
      if (mailpitOwned) await capture(() => mailpit?.clearLocalTestInstance(), errors);
      await capture(() => mailpitLock?.release(), errors);
      await capture(() => database?.dispose(), errors);
      await capture(() => rm(platformStateFile, { force: true }), errors);
      await capture(() => assertPortReleased(API_PORT), errors);
      await capture(() => assertPortReleased(WEB_PORT), errors);
      if (errors.length > 0) {
        process.stderr.write(`${formatCleanupFailures(errors)}\n`);
        process.exitCode = 1;
      } else {
        process.exitCode = exitCode;
      }
    })();
    return shutdownInFlight;
  };

  const processControl = installPlatformE2EProcessControl({ target: process, shutdown });
  let startupFailure: unknown;

  try {
    await prepareLocalPlatformE2EStartup(process.env, () => rm(platformStateFile, { force: true }));
    assertStartupActive(processControl);
    mailpit = createPlatformMailpit({ baseUrl: mailpitUrl });
    mailpitLock = await acquireLocalMailpitCleanupLock();
    assertStartupActive(processControl);
    await mailpit.clearLocalTestInstance();
    mailpitOwned = true;
    assertStartupActive(processControl);
    database = await createPlatformTestDatabase(process.env);
    assertStartupActive(processControl);
    const env = createPlatformE2ERunEnvironment(process.env, database, { apiPort: API_PORT, webUrl });
    const seed = await seedPlatformE2E(database, env);
    assertStartupActive(processControl);
    storage = await createS3PrefixLease(env, storageLayout.cleanupRoot);
    assertStartupActive(processControl);
    await verifyWorkerPrefixCleanupWiring(database, env, storagePrefix, storageLayout.sentinelPrefix, async () => {
      worker = startPlatformE2EWorker(env, { storagePrefix });
      await waitForWorkerHeartbeat(database!);
    });
    assertStartupActive(processControl);
    web = await startPlatformWebServer({ env, host: "127.0.0.1", port: API_PORT,
      dependencies: { createStorage: (config) => createPrefixedStorage(createStorageAdapter(config), storagePrefix) } });
    assertStartupActive(processControl);
    const state: PlatformE2EState = { runId, databaseName: database.databaseName,
      storageCleanupRoot: storageLayout.cleanupRoot, storagePrefix,
      webUrl, apiUrl, mailpitUrl, seed };
    client = await publishStateBeforeStart(state, publishPlatformE2EState, () => startViteClient(env));
    assertStartupActive(processControl);
    await waitForHttp(webUrl, client);
    assertStartupActive(processControl);
    process.stdout.write(`PLATFORM_E2E_READY ${webUrl}\n`);
  } catch (error) {
    startupFailure = error;
  } finally {
    startupSettled = true;
    settleStartup();
  }
  if (startupFailure !== undefined) {
    if (!processControl.shutdownRequested) {
      process.stderr.write(`${formatStartupFailure(startupFailure)}\n`);
      await processControl.startupFailed();
    } else {
      await processControl.fail();
    }
  }
}

type PlatformE2EProcessTarget = {
  on(event: string | symbol, listener: (...args: any[]) => void): unknown;
  once(event: string | symbol, listener: (...args: any[]) => void): unknown;
  removeListener(event: string | symbol, listener: (...args: any[]) => void): unknown;
  readonly connected?: boolean;
  readonly send?: (...args: any[]) => any;
  readonly disconnect?: () => void;
  exitCode?: string | number | null;
};

export function installPlatformE2EProcessControl(options: {
  readonly target: PlatformE2EProcessTarget;
  readonly shutdown: (exitCode: number) => Promise<void>;
}) {
  let shutdownRequested = false;
  let completion: Promise<void> | undefined;
  const target = options.target;
  const removeListeners = () => {
    target.removeListener("message", onMessage);
    target.removeListener("SIGINT", onSigint);
    target.removeListener("SIGTERM", onSigterm);
  };
  const complete = (exitCode: number, acknowledge: boolean) => {
    shutdownRequested = true;
    completion ??= (async () => {
      await options.shutdown(exitCode);
      removeListeners();
      if (acknowledge && target.connected && target.send) {
        await sendProcessMessage(target, {
          type: "shutdown-complete",
          exitCode: typeof target.exitCode === "number" ? target.exitCode : exitCode
        });
      }
      if (target.connected && target.disconnect) target.disconnect();
    })();
    return completion;
  };
  const onMessage = (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "shutdown") {
      void complete(0, true);
    }
  };
  const onSigint = () => { void complete(0, false); };
  const onSigterm = () => { void complete(0, false); };
  const startupFailed = async () => {
    if (target.connected && target.send) {
      try {
        await sendProcessMessage(target, { type: "startup-failed" });
        return;
      } catch { /* the runner is gone, so this process must own cleanup */ }
    }
    await complete(1, false);
  };
  target.on("message", onMessage);
  target.once("SIGINT", onSigint);
  target.once("SIGTERM", onSigterm);
  return Object.freeze({
    get shutdownRequested() { return shutdownRequested; },
    fail: () => complete(1, false),
    startupFailed
  });
}

function sendProcessMessage(target: PlatformE2EProcessTarget, message: unknown) {
  return new Promise<void>((resolve, reject) => {
    target.send!(message, (error: Error | null) => error ? reject(error) : resolve());
  });
}

function assertStartupActive(control: { readonly shutdownRequested: boolean }) {
  if (control.shutdownRequested) throw new Error("PLATFORM_E2E_SHUTDOWN_REQUESTED");
}

export async function prepareLocalPlatformE2EStartup(
  env: NodeJS.ProcessEnv,
  removeState: () => Promise<unknown>
) {
  await removeState();
  assertLocalPlatformE2EEnvironment(env);
}

function startViteClient(env: NodeJS.ProcessEnv) {
  return spawn(process.execPath, [path.resolve("node_modules/vite/bin/vite.js"), "--host", "127.0.0.1",
    "--port", String(WEB_PORT), "--strictPort"], {
    env: { ...env, PDF_APPROVAL_VITE_TARGET: "platform-e2e", PDF_APPROVAL_PLATFORM_TEST_API_TARGET: apiUrl },
    stdio: ["ignore", "inherit", "inherit"]
  });
}

async function waitForWorkerHeartbeat(database: PlatformTestDatabase) {
  const pool = database.createPool("migration");
  const deadline = Date.now() + 10_000;
  do {
    const result = await pool.query<{ healthy: boolean }>(
      "SELECT coalesce(last_heartbeat_at > clock_timestamp() - interval '30 seconds', false) AS healthy FROM platform.worker_health"
    );
    if (result.rows[0]?.healthy) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("PLATFORM_E2E_WORKER_START_TIMEOUT");
}

type S3PrefixLease = { dispose(): Promise<void> };
async function createS3PrefixLease(env: NodeJS.ProcessEnv, prefix: string): Promise<S3PrefixLease> {
  const bucket = required(env, "PDF_APPROVAL_STORAGE_S3_BUCKET");
  const client = createLocalS3Client(env);
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}/lease`, Body: "platform-e2e" }));
  return Object.freeze({
    async dispose() {
      try {
        await deleteS3Prefix(client, bucket, prefix);
      } finally { client.destroy(); }
    }
  });
}

async function verifyWorkerPrefixCleanupWiring(
  database: PlatformTestDatabase,
  env: NodeJS.ProcessEnv,
  storagePrefix: string,
  sentinelPrefix: string,
  startWorker: () => Promise<void>
) {
  const id = uuidv7();
  const logicalKey = createStorageKey("worker-prefix-probe", id);
  const sentinelKey = `${sentinelPrefix}/${id}`;
  const bucket = required(env, "PDF_APPROVAL_STORAGE_S3_BUCKET");
  const rawClient = createLocalS3Client(env);
  const workerConfig = loadPlatformConfig(env, "worker");
  const prefixedStorage = createPrefixedStorage(createStorageAdapter(workerConfig.storage), storagePrefix);
  const pool = database.createPool("migration");
  const probeContent = Buffer.from("worker-prefix-probe");
  try {
    await runWorkerPrefixCleanupProbe({
      writePrefixedProbe: async () => {
        await prefixedStorage.write(logicalKey, Readable.from(probeContent), "application/octet-stream");
      },
      writeOutsideSentinel: async () => {
        await rawClient.send(new PutObjectCommand({
          Bucket: bucket, Key: sentinelKey, Body: "outside-prefix-sentinel", IfNoneMatch: "*"
        }));
      },
      enqueueCleanup: async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const publisher = new CleanupIntentOutboxPublisher(new PostgresOutboxPublisher({
            createId: uuidv7, clock: () => new Date()
          }));
          await enqueueReadyStorageCleanupProbe({
            repository: new PostgresStorageObjectRepository(client),
            publisher,
            executor: client,
            clock: () => new Date(),
            payload: {
              id,
              driver: "s3",
              objectKey: logicalKey,
              sizeBytes: probeContent.byteLength,
              sha256: createHash("sha256").update(probeContent).digest(),
              mediaType: "application/octet-stream"
            }
          });
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally { client.release(); }
      },
      startWorker,
      isPrefixedProbeDeleted: async () => {
        const [metadata, stored] = await Promise.all([
          prefixedStorage.head(logicalKey),
          new PostgresStorageObjectRepository(pool).findById(id)
        ]);
        return metadata === null && stored?.status === "deleted";
      },
      isOutsideSentinelPresent: async () => {
        try {
          await rawClient.send(new HeadObjectCommand({ Bucket: bucket, Key: sentinelKey }));
          return true;
        } catch (error) {
          if (s3Status(error) === 404) return false;
          throw error;
        }
      },
      removeOutsideSentinel: async () => {
        await rawClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: sentinelKey }));
      }
    });
  } finally {
    prefixedStorage.destroy();
    rawClient.destroy();
  }
}

type ReadyStorageCleanupProbeRepository = {
  createStaging(input: CreateStagingStorageObject): Promise<unknown>;
  markReady(id: string, content: ReadyStorageObjectContent): Promise<unknown>;
  markDeletePending(id: string, requestedAt: Date): Promise<Pick<StorageObject,
    "id" | "driver" | "objectKey" | "cleanupTombstone" | "cleanupGeneration">>;
};

type ReadyStorageCleanupProbePayload = Pick<CreateStagingStorageObject, "id" | "driver" | "objectKey"> &
  Pick<ReadyStorageObjectContent, "sizeBytes" | "sha256" | "mediaType">;

export async function enqueueReadyStorageCleanupProbe(options: {
  readonly repository: ReadyStorageCleanupProbeRepository;
  readonly publisher: CleanupIntentPublisher;
  readonly executor: QueryExecutor;
  readonly clock: () => Date;
  readonly payload: ReadyStorageCleanupProbePayload;
}) {
  const deleteRequestedAt = options.clock();
  const readyAt = new Date(deleteRequestedAt.getTime() - 1);
  const createdAt = new Date(deleteRequestedAt.getTime() - 2);
  await options.repository.createStaging({
    id: options.payload.id,
    driver: options.payload.driver,
    objectKey: options.payload.objectKey,
    createdAt,
    uploadExpiresAt: new Date(deleteRequestedAt.getTime() + 60_000)
  });
  await options.repository.markReady(options.payload.id, {
    sizeBytes: options.payload.sizeBytes,
    sha256: options.payload.sha256,
    mediaType: options.payload.mediaType,
    readyAt
  });
  const pending = await options.repository.markDeletePending(options.payload.id, deleteRequestedAt);
  await options.publisher.publish(options.executor, createCleanupIntent(pending, "delete_pending"));
}

export function createStorageOwnershipLayout(runId: string) {
  const cleanupRoot = `phase1-e2e/${runId}`;
  return Object.freeze({
    cleanupRoot,
    storagePrefix: `${cleanupRoot}/objects`,
    sentinelPrefix: `${cleanupRoot}/sentinel`
  });
}

function createLocalS3Client(env: NodeJS.ProcessEnv) {
  return new S3Client({
    endpoint: required(env, "PDF_APPROVAL_STORAGE_S3_ENDPOINT"),
    region: required(env, "PDF_APPROVAL_STORAGE_S3_REGION"),
    forcePathStyle: required(env, "PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE") === "true",
    credentials: {
      accessKeyId: required(env, "PDF_APPROVAL_STORAGE_S3_ACCESS_KEY"),
      secretAccessKey: required(env, "PDF_APPROVAL_STORAGE_S3_SECRET_KEY")
    }
  });
}

function s3Status(error: unknown) {
  return error && typeof error === "object" && "$metadata" in error && error.$metadata &&
    typeof error.$metadata === "object" && "httpStatusCode" in error.$metadata
    ? error.$metadata.httpStatusCode : undefined;
}

type S3PrefixClient = {
  send(command: ListObjectsV2Command | DeleteObjectsCommand): Promise<{
    readonly IsTruncated?: boolean;
    readonly NextContinuationToken?: string;
    readonly Contents?: readonly { readonly Key?: string }[];
    readonly Errors?: readonly unknown[];
  }>;
};

export async function deleteS3Prefix(client: S3PrefixClient, bucket: string, prefix: string) {
  let continuationToken: string | undefined;
  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${prefix}/`,
      ContinuationToken: continuationToken
    }));
    const objects = listed.Contents?.flatMap(({ Key }) => Key ? [{ Key }] : []) ?? [];
    if (objects.length > 0) {
      const deleted = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
      if (deleted.Errors?.length) throw new Error("PLATFORM_E2E_S3_PREFIX_DELETE_FAILED");
    }
    if (listed.IsTruncated && !listed.NextContinuationToken) {
      throw new Error("PLATFORM_E2E_S3_PAGINATION_INVALID");
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

async function waitForHttp(url: string, child: ChildProcess) {
  const deadline = Date.now() + 15_000;
  do {
    if (child.exitCode !== null) throw new Error("PLATFORM_E2E_CLIENT_EXITED");
    try { if ((await fetch(url)).ok) return; } catch { /* readiness polling */ }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("PLATFORM_E2E_CLIENT_START_TIMEOUT");
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await Promise.race([exit, delay(5_000).then(() => { throw new Error("PLATFORM_E2E_CLIENT_STOP_TIMEOUT"); })]);
}

async function assertPortReleased(port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1_000);
    socket.once("connect", () => { socket.destroy(); reject(new Error(`PLATFORM_E2E_PORT_STILL_BOUND:${port}`)); });
    socket.once("error", () => { socket.destroy(); resolve(); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`PLATFORM_E2E_PORT_CHECK_TIMEOUT:${port}`)); });
  });
}

async function capture(operation: () => unknown | Promise<unknown>, errors: unknown[]) {
  try { await operation(); } catch (error) { errors.push(error); }
}
function required(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`PLATFORM_E2E_CONFIG_MISSING:${key}`);
  return value;
}
function delay(milliseconds: number) { return new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }

export function formatCleanupFailures(errors: readonly unknown[]) {
  const codes = errors.flatMap(flattenCleanupFailure).map((error) => {
    const message = error instanceof Error ? error.message : String(error);
    return /^[A-Z][A-Z0-9_]*(?::[A-Za-z0-9_.-]+)*$/.test(message)
      ? message
      : "PLATFORM_E2E_CLEANUP_STEP_FAILED";
  });
  return `PLATFORM_E2E_CLEANUP_FAILED:${codes.join(",")}`;
}

const STARTUP_FAILURE_CODES = new Set([
  "PLATFORM_E2E_DEPENDENCY_NOT_LOCAL",
  "PLATFORM_E2E_MAILPIT_NOT_LOCAL",
  "PLATFORM_E2E_MAILPIT_CLEAR_FAILED",
  "PLATFORM_E2E_WORKER_START_TIMEOUT",
  "PLATFORM_E2E_CLIENT_EXITED",
  "PLATFORM_E2E_CLIENT_START_TIMEOUT",
  "PLATFORM_E2E_STORAGE_PREFIX_INVALID"
]);

export function formatStartupFailure(error: unknown) {
  const candidate = error instanceof Error ? error.message : undefined;
  const code = candidate && STARTUP_FAILURE_CODES.has(candidate) ? candidate : "PLATFORM_E2E_START_STEP_FAILED";
  return `PLATFORM_E2E_START_FAILED:${code}`;
}

function flattenCleanupFailure(error: unknown): unknown[] {
  return error instanceof AggregateError ? Array.from(error.errors).flatMap(flattenCleanupFailure) : [error];
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isMainModule()) void main();
