import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import { withTransaction } from "../database/transaction.ts";
import type { StorageAdapter } from "../storage/storageAdapter.ts";
import { StorageError } from "../storage/storageErrors.ts";
import { PostgresStorageObjectRepository } from "../storage/postgres/PostgresStorageObjectRepository.ts";
import { createStorageKey } from "../storage/storageKey.ts";
import { StorageObjectService } from "../storage/storageObjectService.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import { createDeleteStorageObjectHandler } from "./handlers/deleteStorageObject.ts";

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
beforeEach(async () => { await migration.query("TRUNCATE platform.storage_objects"); });

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
});

function fakeAdapter(driver: "filesystem" | "s3"): StorageAdapter {
  return { driver, write: vi.fn(), openRead: vi.fn(), head: vi.fn(async () => null), delete: vi.fn(async () => undefined), checkHealth: vi.fn() } as unknown as StorageAdapter;
}
import { Readable } from "node:stream";
