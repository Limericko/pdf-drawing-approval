import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import { withTransaction } from "../database/transaction.ts";
import type { StorageAdapter } from "../storage/storageAdapter.ts";
import { StorageError } from "../storage/storageErrors.ts";
import { PostgresStorageObjectRepository } from "../storage/postgres/PostgresStorageObjectRepository.ts";
import { createStorageKey } from "../storage/storageKey.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import { createDeleteStorageObjectHandler } from "./handlers/deleteStorageObject.ts";

let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let worker: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  worker = createPlatformPool({ connectionString: database.urls.worker, poolMax: 2, connectTimeoutMs: 2_000, queryTimeoutMs: 2_000, lockTimeoutMs: 1_000, transactionTimeoutMs: 5_000 }, "cleanup-handler-test");
});
afterAll(async () => { await worker?.end(); await database?.dispose(); });
beforeEach(async () => { await migration.query("TRUNCATE platform.storage_objects"); });

describe("storage cleanup handler", () => {
  it("moves stale staging to delete_pending before external delete and is reentrant when the object is missing", async () => {
    const id = uuidv7();
    const key = createStorageKey("original", id);
    const createdAt = new Date("2026-07-12T09:00:00.000Z");
    await new PostgresStorageObjectRepository(migration).createStaging({ id, driver: "filesystem", objectKey: key, createdAt });
    const adapter = fakeAdapter("filesystem");
    adapter.delete = vi.fn(async () => {
      const row = await new PostgresStorageObjectRepository(worker).findById(id);
      expect(row?.status).toBe("delete_pending");
    });
    const handler = createDeleteStorageObjectHandler({
      transactionRunner: (callback) => withTransaction(worker, callback),
      createRepository: (executor) => new PostgresStorageObjectRepository(executor), adapter,
      clock: () => new Date(createdAt.getTime() + 1_000)
    });
    const payload = { idempotencyKey: `storage-object-cleanup:${id}:staging`, storageObjectId: id, expectedStatus: "staging", driver: "filesystem", objectKey: key } as const;
    await handler({ payload } as never);
    await handler({ payload } as never);
    expect(adapter.delete).toHaveBeenCalledTimes(1);
    await expect(new PostgresStorageObjectRepository(worker).findById(id)).resolves.toMatchObject({ status: "deleted" });
  });

  it("does not delete when an old staging intent observes ready metadata", async () => {
    const id = uuidv7();
    const key = createStorageKey("original", id);
    const createdAt = new Date("2026-07-12T09:10:00.000Z");
    const repository = new PostgresStorageObjectRepository(migration);
    await repository.createStaging({ id, driver: "filesystem", objectKey: key, createdAt });
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
    await new PostgresStorageObjectRepository(migration).createStaging({ id, driver: "filesystem", objectKey: key, createdAt });
    const adapter = fakeAdapter("filesystem");
    adapter.delete = vi.fn(async () => { throw new StorageError("OBJECT_NOT_FOUND", "Object does not exist"); });
    const handler = createDeleteStorageObjectHandler({ transactionRunner: (callback) => withTransaction(worker, callback), createRepository: (executor) => new PostgresStorageObjectRepository(executor), adapter, clock: () => new Date(createdAt.getTime() + 1) });
    await handler({ payload: { idempotencyKey: `storage-object-cleanup:${id}:staging`, storageObjectId: id, expectedStatus: "staging", driver: "filesystem", objectKey: key } } as never);
    expect(adapter.delete).toHaveBeenCalledTimes(1);
    await expect(new PostgresStorageObjectRepository(worker).findById(id)).resolves.toMatchObject({ status: "deleted" });
  });

  it("leaves delete_pending after final DB failure and completes on a missing-object retry", async () => {
    const id = uuidv7();
    const key = createStorageKey("original", id);
    const createdAt = new Date("2026-07-12T09:17:00.000Z");
    await new PostgresStorageObjectRepository(migration).createStaging({ id, driver: "filesystem", objectKey: key, createdAt });
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
      clock: () => new Date(createdAt.getTime() + 1)
    });
    const payload = { idempotencyKey: `storage-object-cleanup:${id}:staging`, storageObjectId: id, expectedStatus: "staging", driver: "filesystem", objectKey: key } as const;
    await expect(handler({ payload } as never)).rejects.toThrow("FINAL_DB_FAILED");
    await expect(new PostgresStorageObjectRepository(worker).findById(id)).resolves.toMatchObject({ status: "delete_pending" });
    failComplete = false;
    adapter.delete = vi.fn(async () => { throw new StorageError("OBJECT_NOT_FOUND", "Object does not exist"); });
    await handler({ payload: { ...payload, idempotencyKey: `storage-object-cleanup:${id}:delete_pending`, expectedStatus: "delete_pending" } } as never);
    await expect(new PostgresStorageObjectRepository(worker).findById(id)).resolves.toMatchObject({ status: "deleted" });
  });

  it("rejects driver or key mismatch without touching storage", async () => {
    const id = uuidv7();
    const key = createStorageKey("original", id);
    const createdAt = new Date("2026-07-12T09:20:00.000Z");
    await new PostgresStorageObjectRepository(migration).createStaging({ id, driver: "filesystem", objectKey: key, createdAt });
    const adapter = fakeAdapter("s3");
    const handler = createDeleteStorageObjectHandler({ transactionRunner: (callback) => withTransaction(worker, callback), createRepository: (executor) => new PostgresStorageObjectRepository(executor), adapter, clock: () => new Date(createdAt.getTime() + 1) });
    await expect(handler({ payload: { idempotencyKey: `storage-object-cleanup:${id}:staging`, storageObjectId: id, expectedStatus: "staging", driver: "filesystem", objectKey: key } } as never)).rejects.toMatchObject({ kind: "permanent", code: "STORAGE_DRIVER_MISMATCH" });
    expect(adapter.delete).not.toHaveBeenCalled();
  });
});

function fakeAdapter(driver: "filesystem" | "s3"): StorageAdapter {
  return { driver, write: vi.fn(), openRead: vi.fn(), head: vi.fn(), delete: vi.fn(async () => undefined), checkHealth: vi.fn() } as unknown as StorageAdapter;
}
