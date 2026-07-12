import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { v7 as uuidv7 } from "uuid";
import { loadPlatformConfig } from "../config/loadPlatformConfig.ts";
import type { WorkerPlatformConfig } from "../config/types.ts";
import { loadMigrationFiles } from "../database/migrationFiles.ts";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import { assertExpectedSchema } from "../database/schemaVersion.ts";
import { withTransaction } from "../database/transaction.ts";
import { createPlatformMailTransport } from "../mail/platformMailTransport.ts";
import { createStorage } from "../storage/createStorage.ts";
import type { StorageAdapter } from "../storage/storageAdapter.ts";
import { CleanupIntentOutboxPublisher, PostgresOutboxPublisher } from "./outboxPublisher.ts";
import { OutboxDispatcher } from "./dispatcher.ts";
import { createDeleteStorageObjectHandler } from "./handlers/deleteStorageObject.ts";
import { createSendInvitationEmailHandler } from "./handlers/sendInvitationEmail.ts";
import { invitationEmailEventRegistration, JobRegistry, storageCleanupEventRegistration } from "./jobRegistry.ts";
import { PostgresJobRepository } from "./postgres/PostgresJobRepository.ts";
import { PostgresOutboxRepository } from "./postgres/PostgresOutboxRepository.ts";
import { createRetryPolicy } from "./retryPolicy.ts";
import { StorageReconciler } from "../storage/storageReconciler.ts";
import { createStorageTombstoneReaper } from "../storage/storageTombstoneReaper.ts";
import { PostgresStorageObjectRepository } from "../storage/postgres/PostgresStorageObjectRepository.ts";
import { WorkerHeartbeatRepository } from "./workerHeartbeatRepository.ts";
import { runWorker } from "./worker.ts";

const DISPATCH_BATCH_SIZE = 100;
const RECONCILE_BATCH_SIZE = 100;
const RECONCILE_INTERVAL_MS = 60_000;
const IDLE_SLEEP_MS = 250;
const MAX_STAGING_CLEANUP_VERIFICATION_MS = 1_000;

export async function workerMain(env: NodeJS.ProcessEnv = process.env) {
  const config = loadPlatformConfig(env, "worker");
  return runWorkerResourceLifecycle({
    createPool: () => createPlatformPool(config.database, "pdf-approval-worker"),
    createStorage: () => createStorage(config.storage),
    assertReady: async (pool) => {
      assertWorkerCapacity(config);
      await assertExpectedSchema(pool, await loadMigrationFiles());
    },
    run: (pool, storage) => runConfiguredWorkers(config, pool, storage)
  });
}

export function assertWorkerCapacity(config: Pick<WorkerPlatformConfig, "database" | "worker">) {
  if (!config || !config.database || !config.worker || !Number.isSafeInteger(config.database.poolMax) ||
      !Number.isSafeInteger(config.worker.concurrency) || config.database.poolMax < config.worker.concurrency * 2) {
    throw new Error("WORKER_POOL_CAPACITY_INSUFFICIENT");
  }
}

async function runConfiguredWorkers(config: WorkerPlatformConfig, pool: PlatformPool, storage: StorageAdapter) {
  const controller = new AbortController();
  const mail = createPlatformMailTransport({ config: config.smtp });
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const transactionRunner = <T>(callback: Parameters<typeof withTransaction<T>>[1]) => withTransaction(pool, callback);
    const clock = () => new Date();
    const outboxPublisher = new CleanupIntentOutboxPublisher(new PostgresOutboxPublisher({ createId: uuidv7, clock }));
    const cleanupHandler = createDeleteStorageObjectHandler({
      transactionRunner,
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      adapter: storage,
      clock,
      verificationDelayMs: Math.min(MAX_STAGING_CLEANUP_VERIFICATION_MS, Math.max(1, Math.floor(config.worker.leaseMs / 3)))
    });
    const invitationHandler = createSendInvitationEmailHandler({
      pool, transport: mail, keyring: config.keyrings.invitationHmac, publicBaseUrl: config.publicBaseUrl
    });
    const registry = new JobRegistry(
      [storageCleanupEventRegistration(config.worker.maxAttempts), invitationEmailEventRegistration(config.worker.maxAttempts)],
      [
        { jobType: "storage_object_cleanup", payloadVersion: 1, handler: cleanupHandler },
        { jobType: "invitation.email", payloadVersion: 1, handler: invitationHandler }
      ]
    );
    const startedAt = clock();
    const processIdentity = `${safeHost(hostname())}-${process.pid}-${uuidv7()}`;
    const workers = Array.from({ length: config.worker.concurrency }, (_, index) => {
      const workerId = `${processIdentity}-${index + 1}`;
      const tombstoneReaper = createStorageTombstoneReaper({
        workerId,
        leaseMs: config.worker.leaseMs,
        transactionRunner,
        createRepository: (executor) => new PostgresStorageObjectRepository(executor),
        adapter: storage,
        clock,
        verificationDelayMs: Math.min(MAX_STAGING_CLEANUP_VERIFICATION_MS, Math.max(1, Math.floor(config.worker.leaseMs / 3))),
        reapIntervalMs: config.worker.storageCleanupReapIntervalMs
      });
      const dispatcher = new OutboxDispatcher({
        transactionRunner,
        createOutboxRepository: (executor) => new PostgresOutboxRepository(executor),
        createJobRepository: (executor) => new PostgresJobRepository(executor),
        mapEvent: registry.mapEvent,
        createId: uuidv7,
        clock
      });
      const reconciler = new StorageReconciler({
        transactionRunner,
        createRepository: (executor) => new PostgresStorageObjectRepository(executor),
        publisher: outboxPublisher,
        reapTombstone: (signal) => tombstoneReaper.reap({ signal }),
        clock,
        batchSize: RECONCILE_BATCH_SIZE
      });
      const promise = runWorker({
        workerId,
        startedAt,
        state: { nextReconcileAt: new Date(0) },
        repository: new PostgresJobRepository(pool),
        registry,
        dispatcher,
        dispatchBatchSize: DISPATCH_BATCH_SIZE,
        reconciler,
        reconcileIntervalMs: RECONCILE_INTERVAL_MS,
        heartbeat: new WorkerHeartbeatRepository(pool),
        retryPolicy: createRetryPolicy({ baseDelayMs: config.worker.retryBaseMs, maxDelayMs: config.worker.retryMaxMs, random: Math.random, clock }),
        clock,
        leaseMs: config.worker.leaseMs,
        renewIntervalMs: Math.max(1, Math.floor(config.worker.leaseMs / 3)),
        idleSleepMs: IDLE_SLEEP_MS,
        signal: controller.signal
      }).catch((error) => {
        controller.abort();
        throw error;
      });
      return promise;
    });
    const outcomes = await Promise.allSettled(workers);
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected").map((outcome) => outcome.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "WORKER_LOOPS_FAILED");
  } finally {
    controller.abort();
    mail.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

type ClosablePool = { end(): Promise<unknown> };
export async function runWorkerResourceLifecycle<TPool extends ClosablePool, TStorage>(options: {
  readonly createPool: () => TPool;
  readonly createStorage: () => TStorage;
  readonly assertReady: (pool: TPool) => Promise<void>;
  readonly run: (pool: TPool, storage: TStorage) => Promise<void>;
}) {
  if (!options || typeof options.createPool !== "function" || typeof options.createStorage !== "function" ||
      typeof options.assertReady !== "function" || typeof options.run !== "function") throw new Error("INVALID_WORKER_LIFECYCLE_OPTIONS");
  const pool = options.createPool();
  let storage: TStorage | undefined;
  let primaryError: unknown;
  try {
    await options.assertReady(pool);
    storage = options.createStorage();
    await options.run(pool, storage);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  try { destroyStorage(storage); } catch (error) { cleanupErrors.push(error); }
  try { await pool.end(); } catch (error) { cleanupErrors.push(error); }
  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], "WORKER_RUN_AND_CLEANUP_FAILED", { cause: primaryError });
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "WORKER_RESOURCE_CLEANUP_FAILED");
}

function destroyStorage(storage: unknown) {
  if (storage && typeof storage === "object" && "destroy" in storage && typeof storage.destroy === "function") storage.destroy();
}

function safeHost(value: string) {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return sanitized || "worker";
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isMainModule()) {
  workerMain().catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "WORKER_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
