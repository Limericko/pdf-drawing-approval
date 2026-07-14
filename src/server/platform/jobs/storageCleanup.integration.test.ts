import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import { withTransaction } from "../database/transaction.ts";
import type { StorageAdapter } from "../storage/storageAdapter.ts";
import { StorageError } from "../storage/storageErrors.ts";
import { PostgresStorageObjectRepository } from "../storage/postgres/PostgresStorageObjectRepository.ts";
import { S3Storage } from "../storage/s3Storage.ts";
import { createStorageKey } from "../storage/storageKey.ts";
import { StorageObjectService } from "../storage/storageObjectService.ts";
import { StorageReconciler } from "../storage/storageReconciler.ts";
import { createStorageTombstoneReaper } from "../storage/storageTombstoneReaper.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import { OutboxDispatcher } from "./dispatcher.ts";
import { createDeleteStorageObjectHandler } from "./handlers/deleteStorageObject.ts";
import { JobRegistry, storageCleanupEventRegistration } from "./jobRegistry.ts";
import { CleanupIntentOutboxPublisher, PostgresOutboxPublisher } from "./outboxPublisher.ts";
import { PostgresJobRepository } from "./postgres/PostgresJobRepository.ts";
import { PostgresOutboxRepository } from "./postgres/PostgresOutboxRepository.ts";

let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let worker: PlatformPool;
let web: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  worker = createPlatformPool({ connectionString: database.urls.worker, poolMax: 2, connectTimeoutMs: 2_000, queryTimeoutMs: 2_000, lockTimeoutMs: 1_000, transactionTimeoutMs: 5_000 }, "cleanup-handler-test");
  web = createPlatformPool({ connectionString: database.urls.web, poolMax: 2, connectTimeoutMs: 2_000, queryTimeoutMs: 2_000, lockTimeoutMs: 1_000, transactionTimeoutMs: 5_000 }, "late-upload-test");
});
afterAll(async () => { await web?.end(); await worker?.end(); await database?.dispose(); });
beforeEach(async () => { await migration.query("TRUNCATE platform.storage_objects CASCADE"); });

describe("storage cleanup handler", () => {
  it("moves stale staging to delete_pending before external delete and is reentrant when the object is missing", async () => {
    const id = uuidv7();
    const key = createStorageKey("objects/original", id);
    const createdAt = new Date("2026-07-12T09:00:00.000Z");
    await new PostgresStorageObjectRepository(migration).createStaging({ id, driver: "filesystem", objectKey: key, createdAt, uploadExpiresAt: new Date(createdAt.getTime() + 500) });
    const adapter = fakeAdapter("filesystem");
    adapter.delete = vi.fn(async () => {
      const row = await new PostgresStorageObjectRepository(worker).findById(id);
      expect(row?.status).toBe("delete_pending");
    });
    const handler = createDeleteStorageObjectHandler({
      transactionRunner: (callback) => withTransaction(worker, callback),
      createRepository: (executor) => new PostgresStorageObjectRepository(executor), adapter,
      clock: () => new Date(createdAt.getTime() + 1_000), verificationDelayMs: 1, sleep: async () => undefined
    });
    const payload = { idempotencyKey: `storage-object-cleanup:${id}:staging`, storageObjectId: id, expectedStatus: "staging", driver: "filesystem", objectKey: key } as const;
    await handler({ payload } as never);
    await handler({ payload } as never);
    expect(adapter.delete).toHaveBeenCalledTimes(2);
    await expect(new PostgresStorageObjectRepository(worker).findById(id)).resolves.toMatchObject({ status: "deleted" });
  });

  it("does not delete when an old staging intent observes ready metadata", async () => {
    const id = uuidv7();
    const key = createStorageKey("original", id);
    const createdAt = new Date("2026-07-12T09:10:00.000Z");
    const repository = new PostgresStorageObjectRepository(migration);
    await repository.createStaging({ id, driver: "filesystem", objectKey: key, createdAt, uploadExpiresAt: new Date(createdAt.getTime() + 500) });
    await repository.markReady(id, { sizeBytes: 1, sha256: Buffer.alloc(32), mediaType: "application/pdf", readyAt: new Date(createdAt.getTime() + 1) });
    const adapter = fakeAdapter("filesystem");
    const handler = createDeleteStorageObjectHandler({ transactionRunner: (callback) => withTransaction(worker, callback), createRepository: (executor) => new PostgresStorageObjectRepository(executor), adapter, clock: () => new Date(createdAt.getTime() + 2) });
    await handler({ payload: { idempotencyKey: `storage-object-cleanup:${id}:staging`, storageObjectId: id, expectedStatus: "staging", driver: "filesystem", objectKey: key } } as never);
    expect(adapter.delete).not.toHaveBeenCalled();
    await expect(repository.findById(id)).resolves.toMatchObject({ status: "ready" });
  });

  it("treats an object missing on the first delete as success and completes metadata", async () => {
    const id = uuidv7();
    const key = createStorageKey("original", id);
    const createdAt = new Date("2026-07-12T09:15:00.000Z");
    await new PostgresStorageObjectRepository(migration).createStaging({ id, driver: "filesystem", objectKey: key, createdAt, uploadExpiresAt: new Date(createdAt.getTime() + 500) });
    const adapter = fakeAdapter("filesystem");
    adapter.delete = vi.fn(async () => { throw new StorageError("OBJECT_NOT_FOUND", "Object does not exist"); });
    const handler = createDeleteStorageObjectHandler({ transactionRunner: (callback) => withTransaction(worker, callback), createRepository: (executor) => new PostgresStorageObjectRepository(executor), adapter, clock: () => new Date(createdAt.getTime() + 1_000), verificationDelayMs: 1, sleep: async () => undefined });
    await handler({ payload: { idempotencyKey: `storage-object-cleanup:${id}:staging`, storageObjectId: id, expectedStatus: "staging", driver: "filesystem", objectKey: key } } as never);
    expect(adapter.delete).toHaveBeenCalledTimes(2);
    await expect(new PostgresStorageObjectRepository(worker).findById(id)).resolves.toMatchObject({ status: "deleted" });
  });

  it("leaves delete_pending after final DB failure and completes on a missing-object retry", async () => {
    const id = uuidv7();
    const key = createStorageKey("original", id);
    const createdAt = new Date("2026-07-12T09:17:00.000Z");
    await new PostgresStorageObjectRepository(migration).createStaging({ id, driver: "filesystem", objectKey: key, createdAt, uploadExpiresAt: new Date(createdAt.getTime() + 500) });
    const adapter = fakeAdapter("filesystem");
    let failComplete = true;
    const handler = createDeleteStorageObjectHandler({
      transactionRunner: (callback) => withTransaction(worker, callback),
      createRepository: (executor) => {
        const repository = new PostgresStorageObjectRepository(executor);
        return new Proxy(repository, {
          get(target, property, receiver) {
            if (property === "completeCleanup" && failComplete) return async () => { throw new Error("FINAL_DB_FAILED"); };
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      },
      adapter,
      clock: () => new Date(createdAt.getTime() + 1_000), verificationDelayMs: 1, sleep: async () => undefined
    });
    const payload = { idempotencyKey: `storage-object-cleanup:${id}:staging`, storageObjectId: id, expectedStatus: "staging", driver: "filesystem", objectKey: key } as const;
    await expect(handler({ payload } as never)).rejects.toThrow("FINAL_DB_FAILED");
    await expect(new PostgresStorageObjectRepository(worker).findById(id)).resolves.toMatchObject({ status: "delete_pending" });
    failComplete = false;
    adapter.delete = vi.fn(async () => { throw new StorageError("OBJECT_NOT_FOUND", "Object does not exist"); });
    await handler({ payload } as never);
    await expect(new PostgresStorageObjectRepository(worker).findById(id)).resolves.toMatchObject({ status: "deleted" });
  });

  it("rejects driver or key mismatch without touching storage", async () => {
    const id = uuidv7();
    const key = createStorageKey("original", id);
    const createdAt = new Date("2026-07-12T09:20:00.000Z");
    await new PostgresStorageObjectRepository(migration).createStaging({ id, driver: "filesystem", objectKey: key, createdAt, uploadExpiresAt: new Date(createdAt.getTime() + 500) });
    const adapter = fakeAdapter("s3");
    const handler = createDeleteStorageObjectHandler({ transactionRunner: (callback) => withTransaction(worker, callback), createRepository: (executor) => new PostgresStorageObjectRepository(executor), adapter, clock: () => new Date(createdAt.getTime() + 1) });
    await expect(handler({ payload: { idempotencyKey: `storage-object-cleanup:${id}:staging`, storageObjectId: id, expectedStatus: "staging", driver: "filesystem", objectKey: key } } as never)).rejects.toMatchObject({ kind: "permanent", code: "STORAGE_DRIVER_MISMATCH" });
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it("keeps metadata delete_pending when bytes remain after staging verification", async () => {
    const id = uuidv7();
    const key = createStorageKey("original", id);
    const createdAt = new Date("2026-07-12T09:30:00.000Z");
    await new PostgresStorageObjectRepository(migration).createStaging({ id, driver: "filesystem", objectKey: key, createdAt, uploadExpiresAt: new Date(createdAt.getTime() + 500) });
    const adapter = fakeAdapter("filesystem");
    adapter.head = vi.fn(async () => ({ sizeBytes: 1 }));
    const handler = createDeleteStorageObjectHandler({ transactionRunner: (callback) => withTransaction(worker, callback), createRepository: (executor) => new PostgresStorageObjectRepository(executor), adapter, clock: () => new Date(createdAt.getTime() + 1_000), verificationDelayMs: 1, sleep: async () => undefined });
    await expect(handler({ payload: { idempotencyKey: `storage-object-cleanup:${id}:staging`, storageObjectId: id, expectedStatus: "staging", driver: "filesystem", objectKey: key } } as never))
      .rejects.toMatchObject({ kind: "transient", code: "STORAGE_DELETE_NOT_VERIFIED" });
    await expect(new PostgresStorageObjectRepository(worker).findById(id)).resolves.toMatchObject({ status: "delete_pending", deletedAt: null });
  });

  it("removes bytes from a write that commits after staging cleanup and converges metadata", async () => {
    const id = uuidv7();
    const key = createStorageKey("objects/original", id);
    const createdAt = new Date("2026-07-12T10:00:00.000Z");
    let now = createdAt;
    let fireDeadline!: () => void;
    let writeEntered!: () => void;
    let releaseWrite!: () => void;
    let firstDelete!: () => void;
    let lateWritten!: () => void;
    const writeStarted = new Promise<void>((resolve) => { writeEntered = resolve; });
    const writeBarrier = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const deleteObserved = new Promise<void>((resolve) => { firstDelete = resolve; });
    const lateWriteCompleted = new Promise<void>((resolve) => { lateWritten = resolve; });
    const bytes = new Map<string, Buffer>();
    let deletes = 0;
    const adapter: StorageAdapter = {
      driver: "filesystem",
      async write(objectKey, _body, _mediaType, _options) {
        writeEntered();
        await writeBarrier;
        bytes.set(objectKey, Buffer.from("late-pdf"));
        lateWritten();
        return { sizeBytes: 8, sha256: Buffer.alloc(32) };
      },
      async head(objectKey) { const value = bytes.get(objectKey); return value ? { sizeBytes: value.length } : null; },
      async delete(objectKey) { deletes += 1; bytes.delete(objectKey); if (deletes === 1) firstDelete(); },
      async openRead() { throw new Error("UNUSED"); },
      async checkHealth() {}
    };
    const uploading = new StorageObjectService({
      storage: adapter,
      transactionRunner: (callback) => withTransaction(web, callback),
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      createId: () => id,
      clock: () => new Date(now),
      uploadTimeoutMs: 1_000,
      scheduleTimeout: (callback) => { fireDeadline = callback; return () => undefined; }
    }).create({ body: Readable.from("pdf"), mediaType: "application/pdf" });
    await writeStarted;
    now = new Date(createdAt.getTime() + 1_001);
    fireDeadline();
    const handler = createDeleteStorageObjectHandler({
      transactionRunner: (callback) => withTransaction(worker, callback),
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      adapter,
      clock: () => new Date(now),
      verificationDelayMs: 10,
      sleep: async () => lateWriteCompleted
    });
    const cleaning = handler({ payload: { idempotencyKey: `storage-object-cleanup:${id}:staging`, storageObjectId: id, expectedStatus: "staging", driver: "filesystem", objectKey: key } } as never);
    await deleteObserved;
    releaseWrite();
    await expect(uploading).rejects.toMatchObject({ code: "STORAGE_UPLOAD_EXPIRED" });
    await cleaning;
    expect(bytes.has(key)).toBe(false);
    expect(deletes).toBeGreaterThanOrEqual(2);
    await expect(new PostgresStorageObjectRepository(worker).findById(id)).resolves.toMatchObject({ status: "deleted" });
  });

  it("keeps an S3 tombstone and removes a Put that commits after the first verified cleanup", async () => {
    const id = uuidv7();
    const key = createStorageKey("objects/original", id);
    const createdAt = new Date("2026-07-12T11:00:00.000Z");
    let now = new Date(createdAt.getTime() + 1_000);
    let activeSleeps = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    const storage = new S3Storage(readS3Config());
    const repository = new PostgresStorageObjectRepository(migration);
    await repository.createStaging({
      id,
      driver: "s3",
      objectKey: key,
      createdAt,
      uploadExpiresAt: new Date(createdAt.getTime() + 500)
    });
    const handler = createDeleteStorageObjectHandler({
      transactionRunner: (callback) => withTransaction(worker, callback),
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      adapter: storage,
      clock: () => new Date(now),
      verificationDelayMs: 1,
      sleep: async () => undefined
    });
    const reaper = createStorageTombstoneReaper({
      workerId: "late-commit-reaper",
      leaseMs: 10_000,
      transactionRunner: (callback) => withTransaction(worker, callback),
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      adapter: storage,
      clock: () => new Date(now),
      verificationDelayMs: 1,
      reapIntervalMs: 60_000,
      sleep: async () => {
        activeSleeps += 1;
        await Promise.resolve();
        activeSleeps -= 1;
      }
    });
    try {
      await storage.delete(key);
      await handler({ payload: {
        idempotencyKey: `storage-object-cleanup:${id}:staging`,
        storageObjectId: id,
        expectedStatus: "staging",
        driver: "s3",
        objectKey: key
      } } as never);
      await reaper.reap({ id, signal: new AbortController().signal });
      const firstTombstone = await repository.findById(id);
      expect(firstTombstone).toMatchObject({
        status: "delete_pending",
        deletedAt: null,
        cleanupTombstone: true,
        cleanupGeneration: 1,
        cleanupNotBefore: new Date(now.getTime() + 60_000)
      });

      const lateBody = Readable.from(["late remote commit"]);
      await storage.write(key, lateBody, "application/pdf");
      await expect(storage.head(key)).resolves.toEqual({ sizeBytes: 18 });
      expect(lateBody.readableEnded).toBe(true);

      now = new Date(firstTombstone!.cleanupNotBefore!);
      await reaper.reap({ id, signal: new AbortController().signal });

      await expect(storage.head(key)).resolves.toBeNull();
      await expect(repository.findById(id)).resolves.toMatchObject({
        status: "delete_pending",
        deletedAt: null,
        cleanupTombstone: true,
        cleanupGeneration: 2,
        cleanupNotBefore: new Date(now.getTime() + 60_000)
      });
      expect(activeSleeps).toBe(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      await storage.delete(key);
      storage.destroy();
    }
  });

  it("reaps repeated S3 tombstone generations without growing outbox or job history", async () => {
    const id = uuidv7();
    const key = createStorageKey("objects/original", id);
    const createdAt = new Date("2026-07-12T12:00:00.000Z");
    let now = new Date(createdAt.getTime() + 1_000);
    let transactionActive = false;
    const transactionRunner = <T>(callback: Parameters<typeof withTransaction<T>>[1]) => withTransaction(worker, async (executor) => {
      transactionActive = true;
      try { return await callback(executor); }
      finally { transactionActive = false; }
    });
    const storage = new S3Storage(readS3Config());
    const originalDelete = storage.delete.bind(storage);
    const originalHead = storage.head.bind(storage);
    const deleteSpy = vi.spyOn(storage, "delete").mockImplementation(async (objectKey) => {
      expect(transactionActive).toBe(false);
      await originalDelete(objectKey);
    });
    const headSpy = vi.spyOn(storage, "head").mockImplementation(async (objectKey) => {
      expect(transactionActive).toBe(false);
      return originalHead(objectKey);
    });
    const repository = new PostgresStorageObjectRepository(worker);
    const publisher = new CleanupIntentOutboxPublisher(new PostgresOutboxPublisher({ createId: uuidv7, clock: () => new Date(now) }));
    const createReaper = () => createStorageTombstoneReaper({
      workerId: "history-reaper",
      leaseMs: 10_000,
      transactionRunner,
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      adapter: storage,
      clock: () => new Date(now),
      verificationDelayMs: 1,
      reapIntervalMs: 60_000,
      sleep: async () => undefined
    });
    const createReconciler = () => new StorageReconciler({
      transactionRunner,
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      publisher,
      reapTombstone: (signal) => createReaper().reap({ signal }),
      clock: () => new Date(now),
      batchSize: 10
    });
    try {
      await new PostgresStorageObjectRepository(web).createStaging({
        id,
        driver: "s3",
        objectKey: key,
        createdAt,
        uploadExpiresAt: new Date(createdAt.getTime() + 500)
      });
      await expect(createReconciler().runOnce()).resolves.toEqual({ published: 1 });

      const registry = new JobRegistry([storageCleanupEventRegistration(5)], []);
      const dispatcher = new OutboxDispatcher({
        transactionRunner,
        createOutboxRepository: (executor) => new PostgresOutboxRepository(executor),
        createJobRepository: (executor) => new PostgresJobRepository(executor),
        mapEvent: registry.mapEvent,
        createId: uuidv7,
        clock: () => new Date(now)
      });
      await expect(dispatcher.dispatchBatch(10)).resolves.toBe(1);
      const jobRepository = new PostgresJobRepository(worker);
      const job = await jobRepository.claim({ workerId: "tombstone-history", now, leaseDurationMs: 10_000 });
      const handler = createDeleteStorageObjectHandler({
        transactionRunner,
        createRepository: (executor) => new PostgresStorageObjectRepository(executor),
        adapter: storage,
        clock: () => new Date(now),
        verificationDelayMs: 1,
        sleep: async () => undefined
      });
      await handler(job!);
      await jobRepository.succeed({
        id: job!.id,
        workerId: "tombstone-history",
        leaseToken: job!.leaseToken!,
        completedAt: now
      });
      const initialCounts = await worker.query<{ outbox: string; jobs: string }>(
        `SELECT (SELECT count(*) FROM platform.outbox_events)::text AS outbox,
          (SELECT count(*) FROM platform.jobs)::text AS jobs`
      );
      expect(initialCounts.rows).toEqual([{ outbox: "1", jobs: "1" }]);

      let state = await repository.findById(id);
      now = new Date(state!.cleanupNotBefore!);
      await createReconciler().runOnce();
      state = await repository.findById(id);
      expect(state).toMatchObject({ cleanupGeneration: 1 });

      await storage.write(key, Readable.from("late remote commit"), "application/pdf");
      await expect(originalHead(key)).resolves.toEqual({ sizeBytes: 18 });
      now = new Date(state!.cleanupNotBefore!);
      await createReconciler().runOnce();
      await expect(originalHead(key)).resolves.toBeNull();

      state = await repository.findById(id);
      now = new Date(state!.cleanupNotBefore!);
      await createReconciler().runOnce();
      await expect(repository.findById(id)).resolves.toMatchObject({ cleanupGeneration: 3 });
      await expect(worker.query<{ outbox: string; jobs: string }>(
        `SELECT (SELECT count(*) FROM platform.outbox_events)::text AS outbox,
          (SELECT count(*) FROM platform.jobs)::text AS jobs`
      )).resolves.toMatchObject({ rows: [{ outbox: "1", jobs: "1" }] });
      expect(deleteSpy).toHaveBeenCalled();
      expect(headSpy).toHaveBeenCalled();
    } finally {
      deleteSpy.mockRestore();
      headSpy.mockRestore();
      await originalDelete(key);
      storage.destroy();
    }
  });

  it("lets concurrent reapers perform one delete-delete-head sequence for one tombstone", async () => {
    const id = uuidv7();
    const key = createStorageKey("objects/original", id);
    const createdAt = new Date("2026-07-12T13:00:00.000Z");
    const now = new Date(createdAt.getTime() + 1_000);
    const repository = new PostgresStorageObjectRepository(worker);
    await new PostgresStorageObjectRepository(web).createStaging({
      id, driver: "s3", objectKey: key, createdAt,
      uploadExpiresAt: new Date(createdAt.getTime() + 500)
    });
    await repository.prepareCleanup({
      id, expectedStatus: "staging", driver: "s3", objectKey: key,
      requestedAt: now, cleanupGeneration: 0
    });

    let releaseDelete!: () => void;
    let firstDelete!: () => void;
    const deleteEntered = new Promise<void>((resolve) => { firstDelete = resolve; });
    const deleteBarrier = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const operations: string[] = [];
    const adapter: StorageAdapter = {
      driver: "s3",
      async write() { throw new Error("UNUSED"); },
      async openRead() { throw new Error("UNUSED"); },
      async delete() {
        operations.push("delete");
        if (operations.length === 1) { firstDelete(); await deleteBarrier; }
      },
      async head() { operations.push("head"); return null; },
      async checkHealth() {}
    };
    const createReaper = (workerId: string) => createStorageTombstoneReaper({
      workerId, leaseMs: 10_000, transactionRunner: (callback) => withTransaction(worker, callback),
      createRepository: (executor) => new PostgresStorageObjectRepository(executor), adapter,
      clock: () => new Date(now), verificationDelayMs: 1, reapIntervalMs: 60_000,
      sleep: async () => undefined
    });
    const signal = new AbortController().signal;
    const first = createReaper("reaper-a").reap({ id, signal });
    await deleteEntered;
    const second = createReaper("reaper-b").reap({ id, signal });
    releaseDelete();
    const outcomes = await Promise.all([first, second]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["idle", "processed"]);
    expect(operations).toEqual(["delete", "delete", "head"]);
  });

  it("aborts a claimed reap promptly, releases it, and starts no later I/O", async () => {
    const id = uuidv7();
    const key = createStorageKey("objects/original", id);
    const createdAt = new Date("2026-07-12T13:10:00.000Z");
    const now = new Date(createdAt.getTime() + 1_000);
    const repository = new PostgresStorageObjectRepository(worker);
    await new PostgresStorageObjectRepository(web).createStaging({
      id, driver: "s3", objectKey: key, createdAt,
      uploadExpiresAt: new Date(createdAt.getTime() + 500)
    });
    await repository.prepareCleanup({
      id, expectedStatus: "staging", driver: "s3", objectKey: key,
      requestedAt: now, cleanupGeneration: 0
    });
    const operations: string[] = [];
    const adapter: StorageAdapter = {
      driver: "s3",
      async write() { throw new Error("UNUSED"); },
      async openRead() { throw new Error("UNUSED"); },
      async delete() { operations.push("delete"); },
      async head() { operations.push("head"); return null; },
      async checkHealth() {}
    };
    const reaper = createStorageTombstoneReaper({
      workerId: "abort-reaper", leaseMs: 10_000,
      transactionRunner: (callback) => withTransaction(worker, callback),
      createRepository: (executor) => new PostgresStorageObjectRepository(executor), adapter,
      clock: () => new Date(now), verificationDelayMs: 20_000, reapIntervalMs: 60_000
    });
    const controller = new AbortController();
    const startedAt = Date.now();
    const running = reaper.reap({ id, signal: controller.signal });
    while (operations.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    setTimeout(() => controller.abort(), 10);
    await expect(running).resolves.toMatchObject({ status: "stopped" });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(operations).toEqual(["delete"]);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(operations).toEqual(["delete"]);
    await expect(repository.findById(id)).resolves.toMatchObject({
      cleanupLeaseOwner: null, cleanupLeaseToken: null, cleanupLeaseExpiresAt: null
    });
  });
});

function fakeAdapter(driver: "filesystem" | "s3"): StorageAdapter {
  return { driver, write: vi.fn(), openRead: vi.fn(), head: vi.fn(async () => null), delete: vi.fn(async () => undefined), checkHealth: vi.fn() } as unknown as StorageAdapter;
}

function readS3Config() {
  return {
    driver: "s3" as const,
    endpoint: process.env.PDF_APPROVAL_STORAGE_S3_ENDPOINT!,
    region: process.env.PDF_APPROVAL_STORAGE_S3_REGION!,
    bucket: process.env.PDF_APPROVAL_STORAGE_S3_BUCKET!,
    accessKey: process.env.PDF_APPROVAL_STORAGE_S3_ACCESS_KEY!,
    secretKey: process.env.PDF_APPROVAL_STORAGE_S3_SECRET_KEY!,
    forcePathStyle: process.env.PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE === "true"
  };
}
import { Readable } from "node:stream";
