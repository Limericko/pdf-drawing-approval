import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import type { QueryExecutor } from "../database/queryExecutor.ts";
import { withTransaction } from "../database/transaction.ts";
import { CleanupIntentOutboxPublisher, PostgresOutboxPublisher } from "./outboxPublisher.ts";
import { OutboxDispatcher } from "./dispatcher.ts";
import { JobDiagnostics } from "./jobDiagnostics.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import { PostgresJobRepository } from "./postgres/PostgresJobRepository.ts";
import { PostgresOutboxRepository } from "./postgres/PostgresOutboxRepository.ts";
import { PostgresStorageObjectRepository } from "../storage/postgres/PostgresStorageObjectRepository.ts";
import { createStorageKey } from "../storage/storageKey.ts";
import { StorageReconciler } from "../storage/storageReconciler.ts";
import { JobHandlerError, JobRegistry, storageCleanupEventRegistration } from "./jobRegistry.ts";
import { runWorker, runWorkerIteration, type WorkerState } from "./worker.ts";
import { WorkerHeartbeatRepository } from "./workerHeartbeatRepository.ts";

let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let worker: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  worker = createPlatformPool({ connectionString: database.urls.worker, poolMax: 4, connectTimeoutMs: 2_000, queryTimeoutMs: 2_000, lockTimeoutMs: 1_000, transactionTimeoutMs: 5_000 }, "worker-loop-test");
});

afterAll(async () => {
  await worker?.end();
  await database?.dispose();
});

beforeEach(async () => {
  await migration.query("TRUNCATE platform.jobs, platform.outbox_events, platform.worker_heartbeats, platform.storage_objects, platform.audit_events");
});

describe("leased worker", () => {
  it("lets concurrent workers execute a job once without holding a database transaction", async () => {
    const now = new Date("2026-07-12T08:00:00.000Z");
    const repository = new PostgresJobRepository(worker);
    const id = uuidv7();
    await repository.create({ id, jobType: "test", payloadVersion: 1, payload: {}, idempotencyKey: `test:${id}`, maxAttempts: 3, nextRunAt: now, createdAt: now });
    let calls = 0;
    const handler = vi.fn(async () => {
      calls += 1;
      const result = await worker.query<{ active: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND state = 'idle in transaction') AS active");
      expect(result.rows[0]?.active).toBe(false);
    });
    const registry = new JobRegistry([], [{ jobType: "test", payloadVersion: 1, handler }]);
    await Promise.all([
      runWorkerIteration(deps("worker-a", now, repository, registry)),
      runWorkerIteration(deps("worker-b", now, repository, registry))
    ]);
    expect(calls).toBe(1);
    await expect(repository.findById(id)).resolves.toMatchObject({ status: "succeeded", attemptCount: 1 });
  });

  it("recovers an expired lease and fences the crashed worker", async () => {
    const now = new Date("2026-07-12T08:10:00.000Z");
    const repository = new PostgresJobRepository(worker);
    const id = uuidv7();
    await repository.create({ id, jobType: "test", payloadVersion: 1, payload: {}, idempotencyKey: `test:${id}`, maxAttempts: 3, nextRunAt: now, createdAt: now });
    const abandoned = await repository.claim({ workerId: "crashed", now, leaseDurationMs: 100 });
    const recoveredAt = new Date(now.getTime() + 101);
    const registry = new JobRegistry([], [{ jobType: "test", payloadVersion: 1, handler: async () => undefined }]);
    await runWorkerIteration(deps("replacement", recoveredAt, repository, registry));
    await expect(repository.findById(id)).resolves.toMatchObject({ status: "succeeded", attemptCount: 2 });
    await expect(repository.succeed({ id, workerId: "crashed", leaseToken: abandoned!.leaseToken!, completedAt: recoveredAt })).rejects.toMatchObject({ code: "STALE_LEASE" });
  });

  it("backs off transient failures and sends permanent and exhausted failures to dead", async () => {
    const now = new Date("2026-07-12T08:20:00.000Z");
    const repository = new PostgresJobRepository(worker);
    const transientId = uuidv7();
    await repository.create({ id: transientId, jobType: "transient", payloadVersion: 1, payload: {}, idempotencyKey: `test:${transientId}`, maxAttempts: 2, nextRunAt: now, createdAt: now });
    const transientRegistry = new JobRegistry([], [{ jobType: "transient", payloadVersion: 1, handler: async () => { throw new JobHandlerError("transient", "TEMPORARY", "Temporary dependency failure"); } }]);
    await runWorkerIteration(deps("retry", now, repository, transientRegistry));
    await expect(repository.findById(transientId)).resolves.toMatchObject({ status: "pending", nextRunAt: new Date(now.getTime() + 50) });
    await runWorkerIteration(deps("retry", new Date(now.getTime() + 50), repository, transientRegistry));
    await expect(repository.findById(transientId)).resolves.toMatchObject({ status: "dead", attemptCount: 2, lastErrorCode: "TEMPORARY" });

    const permanentId = uuidv7();
    const later = new Date(now.getTime() + 100);
    await repository.create({ id: permanentId, jobType: "unknown", payloadVersion: 1, payload: {}, idempotencyKey: `test:${permanentId}`, maxAttempts: 3, nextRunAt: later, createdAt: later });
    await runWorkerIteration(deps("permanent", later, repository, transientRegistry));
    await expect(repository.findById(permanentId)).resolves.toMatchObject({ status: "dead", attemptCount: 1, lastErrorCode: "UNKNOWN_JOB_HANDLER" });
  });

  it("stops before dispatcher, reconciler and claim when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const repository = { claim: vi.fn() } as never;
    const dispatcher = { dispatchBatch: vi.fn() };
    const reconciler = { runOnce: vi.fn() };
    const result = await runWorkerIteration({ ...deps("abort", new Date(), repository, new JobRegistry([], [])), dispatcher, reconciler, signal: controller.signal });
    expect(result).toEqual({ status: "stopped" });
    expect(dispatcher.dispatchBatch).not.toHaveBeenCalled();
    expect(reconciler.runOnce).not.toHaveBeenCalled();
    expect((repository as { claim: ReturnType<typeof vi.fn> }).claim).not.toHaveBeenCalled();
  });

  it("requeues a claim that returns after abort without starting its handler", async () => {
    const now = new Date("2026-07-12T08:25:00.000Z");
    const repository = new PostgresJobRepository(worker);
    const id = uuidv7();
    await repository.create({ id, jobType: "abort-window", payloadVersion: 1, payload: {}, idempotencyKey: `abort-window:${id}`, maxAttempts: 3, nextRunAt: now, createdAt: now });
    let claimed!: () => void;
    let releaseClaim!: () => void;
    const claimObserved = new Promise<void>((resolve) => { claimed = resolve; });
    const barrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const delayedRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "claim") return async (...args: Parameters<typeof repository.claim>) => {
          const job = await target.claim(...args);
          claimed();
          await barrier;
          return job;
        };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const handler = vi.fn(async () => undefined);
    const controller = new AbortController();
    const running = runWorkerIteration({ ...deps("abort-window", now, delayedRepository, new JobRegistry([], [{ jobType: "abort-window", payloadVersion: 1, handler }])), signal: controller.signal });
    await claimObserved;
    controller.abort();
    releaseClaim();
    await expect(running).resolves.toEqual({ status: "stopped" });
    expect(handler).not.toHaveBeenCalled();
    await expect(repository.findById(id)).resolves.toMatchObject({ status: "pending", attemptCount: 0, workerId: null, startedAt: now });
  });

  it("lets an in-flight short job finish after abort and does not claim another job", async () => {
    const now = new Date("2026-07-12T08:30:00.000Z");
    const realRepository = new PostgresJobRepository(worker);
    for (let index = 0; index < 2; index += 1) {
      const id = uuidv7();
      await realRepository.create({ id, jobType: "short", payloadVersion: 1, payload: {}, idempotencyKey: `short:${id}`, maxAttempts: 3, nextRunAt: now, createdAt: now });
    }
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    const controller = new AbortController();
    const claim = vi.spyOn(realRepository, "claim");
    const registry = new JobRegistry([], [{ jobType: "short", payloadVersion: 1, handler: async () => { entered(); await barrier; } }]);
    const running = runWorker({ ...deps("graceful", now, realRepository, registry), idleSleepMs: 1, sleep: async () => undefined, signal: controller.signal });
    await started;
    controller.abort();
    finish();
    await running;
    expect(claim).toHaveBeenCalledTimes(1);
    const statuses = await worker.query<{ status: string }>("SELECT status FROM platform.jobs ORDER BY id");
    expect(statuses.rows.map((row) => row.status).sort()).toEqual(["pending", "succeeded"]);
  });

  it("renews a lease during a long handler and stops the renewal pump before returning", async () => {
    const now = new Date("2026-07-12T08:40:00.000Z");
    const repository = new PostgresJobRepository(worker);
    const id = uuidv7();
    await repository.create({ id, jobType: "long", payloadVersion: 1, payload: {}, idempotencyKey: `long:${id}`, maxAttempts: 3, nextRunAt: now, createdAt: now });
    const renew = vi.spyOn(repository, "renewLease");
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    const registry = new JobRegistry([], [{ jobType: "long", payloadVersion: 1, handler: async () => barrier }]);
    let sleeps = 0;
    const leaseSleep = async (_ms: number, signal: AbortSignal) => {
      sleeps += 1;
      if (sleeps === 1) return;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    const running = runWorkerIteration({ ...deps("renewing", now, repository, registry), leaseSleep });
    while (renew.mock.calls.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    finish();
    await running;
    expect(renew).toHaveBeenCalledTimes(1);
    expect(sleeps).toBe(1);
  });

  it("surfaces a renewal dependency failure and leaves the job for lease recovery", async () => {
    const now = new Date("2026-07-12T08:45:00.000Z");
    const repository = new PostgresJobRepository(worker);
    const id = uuidv7();
    await repository.create({ id, jobType: "long", payloadVersion: 1, payload: {}, idempotencyKey: `renew-fail:${id}`, maxAttempts: 3, nextRunAt: now, createdAt: now });
    vi.spyOn(repository, "renewLease").mockRejectedValue(new Error("RENEW_DEPENDENCY_FAILED"));
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    const registry = new JobRegistry([], [{ jobType: "long", payloadVersion: 1, handler: async () => barrier }]);
    const running = runWorkerIteration({ ...deps("renew-failure", now, repository, registry), leaseSleep: async () => undefined });
    while ((repository.renewLease as ReturnType<typeof vi.fn>).mock.calls.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    finish();
    await expect(running).rejects.toThrow("RENEW_DEPENDENCY_FAILED");
    await expect(repository.findById(id)).resolves.toMatchObject({ status: "running", workerId: "renew-failure" });
  });

  it("runs reconciliation on the injected schedule and dispatches stale cleanup through outbox", async () => {
    const now = new Date("2026-07-12T08:50:00.000Z");
    const staleId = uuidv7();
    await new PostgresStorageObjectRepository(migration).createStaging({ id: staleId, driver: "filesystem", objectKey: createStorageKey("original", staleId), createdAt: new Date(now.getTime() - 10_000), uploadExpiresAt: new Date(now.getTime() - 1) });
    const transactionRunner = <T>(callback: (executor: QueryExecutor) => Promise<T>) => withTransaction(worker, callback);
    const handler = vi.fn(async () => undefined);
    const registry = new JobRegistry([storageCleanupEventRegistration(3)], [{ jobType: "storage_object_cleanup", payloadVersion: 1, handler }]);
    const dispatcher = new OutboxDispatcher({ transactionRunner, createOutboxRepository: (executor) => new PostgresOutboxRepository(executor), createJobRepository: (executor) => new PostgresJobRepository(executor), mapEvent: registry.mapEvent, createId: uuidv7, clock: () => now });
    const reconciler = new StorageReconciler({ transactionRunner, createRepository: (executor) => new PostgresStorageObjectRepository(executor), publisher: new CleanupIntentOutboxPublisher(new PostgresOutboxPublisher({ createId: uuidv7, clock: () => now })), clock: () => now, batchSize: 10 });
    const state = { nextReconcileAt: new Date(0) };
    const base = { ...deps("scheduled", now, new PostgresJobRepository(worker), registry), state, dispatcher, reconciler, reconcileIntervalMs: 60_000 };
    await runWorkerIteration(base);
    await expect(worker.query<{ count: string }>("SELECT count(*)::text AS count FROM platform.outbox_events WHERE dispatched_at IS NULL")).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await runWorkerIteration(base);
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(worker.query<{ count: string }>("SELECT count(*)::text AS count FROM platform.outbox_events WHERE dispatched_at IS NULL")).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("deduplicates concurrent reconcilers to one cleanup outbox event and one job", async () => {
    const now = new Date("2026-07-12T08:55:00.000Z");
    const staleId = uuidv7();
    await new PostgresStorageObjectRepository(migration).createStaging({ id: staleId, driver: "filesystem", objectKey: createStorageKey("original", staleId), createdAt: new Date(now.getTime() - 10_000), uploadExpiresAt: new Date(now.getTime() - 1) });
    const transactionRunner = <T>(callback: (executor: QueryExecutor) => Promise<T>) => withTransaction(worker, callback);
    const publisher = new CleanupIntentOutboxPublisher(new PostgresOutboxPublisher({ createId: uuidv7, clock: () => now }));
    const createReconciler = () => new StorageReconciler({ transactionRunner, createRepository: (executor) => new PostgresStorageObjectRepository(executor), publisher, clock: () => now, batchSize: 10 });
    await Promise.all([createReconciler().runOnce(), createReconciler().runOnce()]);
    await expect(worker.query<{ count: string }>("SELECT count(*)::text AS count FROM platform.outbox_events")).resolves.toMatchObject({ rows: [{ count: "1" }] });
    const registry = new JobRegistry([storageCleanupEventRegistration(3)], []);
    const dispatcher = new OutboxDispatcher({ transactionRunner, createOutboxRepository: (executor) => new PostgresOutboxRepository(executor), createJobRepository: (executor) => new PostgresJobRepository(executor), mapEvent: registry.mapEvent, createId: uuidv7, clock: () => now });
    await expect(dispatcher.dispatchBatch(10)).resolves.toBe(1);
    await expect(worker.query<{ count: string }>("SELECT count(*)::text AS count FROM platform.jobs")).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("keeps heartbeat start stable and diagnostics retry one dead job once with an audit", async () => {
    const startedAt = new Date("2026-07-12T09:00:00.000Z");
    const heartbeats = new WorkerHeartbeatRepository(worker);
    await heartbeats.record({ workerId: "diagnostic-worker", startedAt, heartbeatAt: startedAt, metadata: { state: "starting" } });
    const heartbeatAt = new Date(startedAt.getTime() + 10);
    await expect(heartbeats.record({ workerId: "diagnostic-worker", startedAt: new Date(startedAt.getTime() + 5), heartbeatAt, metadata: { state: "active" } })).resolves.toMatchObject({ startedAt, heartbeatAt, metadata: { state: "active" } });
    await expect(heartbeats.record({ workerId: "diagnostic-worker", startedAt, heartbeatAt: new Date(startedAt.getTime() + 1), metadata: {} })).rejects.toMatchObject({ code: "HEARTBEAT_TIME_CONFLICT" });

    const repository = new PostgresJobRepository(worker);
    const jobId = uuidv7();
    await repository.create({ id: jobId, jobType: "dead", payloadVersion: 1, payload: { secret: "not-listed" }, idempotencyKey: `dead:${jobId}`, maxAttempts: 3, nextRunAt: heartbeatAt, createdAt: heartbeatAt });
    const lease = await repository.claim({ workerId: "diagnostic-worker", now: heartbeatAt, leaseDurationMs: 1_000 });
    await repository.fail({ id: jobId, workerId: "diagnostic-worker", leaseToken: lease!.leaseToken!, failedAt: heartbeatAt, kind: "permanent", errorCode: "PERMANENT", errorMessage: "safe summary" });
    const ids = [uuidv7(), uuidv7()];
    const diagnostics = new JobDiagnostics({ executor: worker, transactionRunner: (callback) => withTransaction(worker, callback), clock: () => new Date(heartbeatAt.getTime() + 100), createId: () => ids.shift()! });
    await expect(diagnostics.summary()).resolves.toMatchObject({ queueDepth: 0, deadCount: 1, workers: [expect.objectContaining({ workerId: "diagnostic-worker", startedAt })] });
    const deadJobs = await diagnostics.listDead();
    expect(deadJobs).toEqual([expect.objectContaining({ id: jobId, errorCode: "PERMANENT" })]);
    expect(deadJobs[0]).not.toHaveProperty("payload");
    expect(deadJobs[0]).not.toHaveProperty("errorMessage");
    const retries = await Promise.allSettled([
      diagnostics.retryDead({ jobId, reason: "dependency restored", actor: "operator-a", requestId: "request-a" }),
      diagnostics.retryDead({ jobId, reason: "duplicate request", actor: "operator-b", requestId: "request-b" })
    ]);
    expect(retries.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(retries.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(repository.findById(jobId)).resolves.toMatchObject({ status: "pending", attemptCount: 0, lastErrorCode: null, completedAt: null });
    const audits = await migration.query<{ metadata: { reason: string; oldAttemptCount: number } }>("SELECT metadata FROM platform.audit_events WHERE target_id = $1 AND action = 'job.dead.retry'", [jobId]);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.metadata).toMatchObject({ oldAttemptCount: 1 });
  });
});

function deps(workerId: string, now: Date, repository: PostgresJobRepository, registry: JobRegistry) {
  const state: WorkerState = { nextReconcileAt: new Date(0) };
  return {
    workerId, state, repository, registry, clock: () => new Date(now), leaseMs: 1_000, renewIntervalMs: 250,
    dispatcher: { dispatchBatch: async () => 0 }, dispatchBatchSize: 10,
    reconciler: { runOnce: async () => ({ published: 0 }) }, reconcileIntervalMs: 60_000,
    heartbeat: { record: async () => undefined },
    retryPolicy: { next: () => ({ delayMs: 50, nextRunAt: new Date(now.getTime() + 50) }) },
    leaseSleep: async (_ms: number, signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    signal: new AbortController().signal
  };
}
