import { Readable } from "node:stream";
import type { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import { runMigrations } from "../database/migrationRunner.ts";
import { withTransaction } from "../database/transaction.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import type { StorageAdapter, StorageDriver } from "./storageAdapter.ts";
import { StorageError } from "./storageErrors.ts";
import { PostgresStorageObjectRepository } from "./postgres/PostgresStorageObjectRepository.ts";
import { deleteStorageObjectBytes, StorageObjectService } from "./storageObjectService.ts";

let database: PlatformTestDatabase;
let migration: Pool;
let web: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  web = createPlatformPool({
    connectionString: database.urls.web, poolMax: 4, connectTimeoutMs: 2_000,
    queryTimeoutMs: 2_000, lockTimeoutMs: 1_000, transactionTimeoutMs: 5_000
  }, "storage-object-service-test");
});

afterAll(async () => {
  await web?.end();
  await database?.dispose();
});

const transactionRunner = <T>(callback: Parameters<typeof withTransaction<T>>[1]) => withTransaction(web, callback);

class MemoryStorage implements StorageAdapter {
  readonly calls: string[] = [];
  readonly objects = new Map<string, Buffer>();
  writeFailure?: Error;
  deleteFailure?: Error;
  headSizeDelta = 0;
  constructor(readonly driver: StorageDriver = "filesystem") {}
  async write(key: string, body: Readable) {
    this.calls.push("write");
    if (this.writeFailure) throw this.writeFailure;
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks);
    this.objects.set(key, content);
    return { sizeBytes: content.length, sha256: Buffer.alloc(32, 3) };
  }
  async head(key: string) {
    this.calls.push("head");
    const content = this.objects.get(key);
    return content ? { sizeBytes: content.length + this.headSizeDelta } : null;
  }
  async openRead(key: string) {
    this.calls.push("openRead");
    const content = this.objects.get(key);
    if (!content) throw new StorageError("OBJECT_NOT_FOUND", "missing");
    return Readable.from(content);
  }
  async delete(key: string) {
    if (this.deleteFailure) throw this.deleteFailure;
    this.objects.delete(key);
  }
  async checkHealth() {}
}

function service(storage: StorageAdapter, runner = transactionRunner) {
  return new StorageObjectService({
    storage,
    transactionRunner: runner,
    createRepository: (executor) => new PostgresStorageObjectRepository(executor)
  });
}

describe("StorageObjectService", () => {
  it("stages, writes, heads, finalizes and only then opens a ready object", async () => {
    const storage = new MemoryStorage();
    const created = await service(storage).create({ body: Readable.from("pdf"), mediaType: "application/pdf" });

    expect(created.status).toBe("ready");
    expect(storage.calls).toEqual(["write", "head"]);
    const stream = await service(storage).openRead(created.id);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("pdf");
  });

  it("keeps staging diagnostic state when object write fails", async () => {
    const storage = new MemoryStorage();
    storage.writeFailure = new StorageError("STORAGE_IO_ERROR", "write failed");
    const objectService = service(storage);

    await expect(objectService.create({ body: Readable.from("pdf"), mediaType: "application/pdf" }))
      .rejects.toMatchObject({ code: "STORAGE_IO_ERROR" });

    const rows = await web.query<{ status: string }>("SELECT status FROM platform.storage_objects ORDER BY created_at DESC LIMIT 1");
    expect(rows.rows[0]?.status).toBe("staging");
  });

  it("rejects a head mismatch without reporting ready", async () => {
    const storage = new MemoryStorage();
    storage.headSizeDelta = 1;
    await expect(service(storage).create({ body: Readable.from("pdf"), mediaType: "application/pdf" }))
      .rejects.toMatchObject({ code: "STORAGE_OBJECT_HEAD_MISMATCH" });
    const rows = await web.query<{ status: string }>("SELECT status FROM platform.storage_objects ORDER BY created_at DESC LIMIT 1");
    expect(rows.rows[0]?.status).toBe("staging");
  });

  it("preserves the remote object and staging row when final database update fails", async () => {
    const storage = new MemoryStorage();
    let calls = 0;
    const failingFinalRunner = async <T>(callback: Parameters<typeof withTransaction<T>>[1]) => {
      calls += 1;
      if (calls === 2) throw new Error("FINAL_UPDATE_UNAVAILABLE");
      return transactionRunner(callback);
    };

    await expect(service(storage, failingFinalRunner).create({ body: Readable.from("pdf"), mediaType: "application/pdf" }))
      .rejects.toThrow("FINAL_UPDATE_UNAVAILABLE");
    expect(storage.objects.size).toBe(1);
    const rows = await web.query<{ status: string }>("SELECT status FROM platform.storage_objects ORDER BY created_at DESC LIMIT 1");
    expect(rows.rows[0]?.status).toBe("staging");
  });

  it("refuses reads for staging records, including an interrupted process window", async () => {
    const storage = new MemoryStorage();
    const id = uuidv7();
    await transactionRunner(async (tx) => new PostgresStorageObjectRepository(tx).createStaging({
      id, driver: storage.driver, objectKey: `objects/original/${id}`, createdAt: new Date()
    }));

    await expect(service(storage).openRead(id)).rejects.toMatchObject({ code: "STORAGE_OBJECT_NOT_READY" });
    expect(storage.calls).toEqual([]);
  });

  it("does not fall back when metadata driver differs from the configured adapter", async () => {
    const storage = new MemoryStorage("filesystem");
    const id = uuidv7();
    await migration.query(
      `INSERT INTO platform.storage_objects
        (id, status, driver, object_key, size_bytes, sha256, media_type, ready_at)
       VALUES ($1, 'ready', 's3', $2, 1, $3, 'application/pdf', clock_timestamp())`,
      [id, `objects/original/${id}`, Buffer.alloc(32)]
    );
    await expect(service(storage).openRead(id)).rejects.toMatchObject({ code: "STORAGE_OBJECT_DRIVER_MISMATCH" });
    expect(storage.calls).toEqual([]);
  });

  it("treats an already missing physical object as successful cleanup", async () => {
    const storage = new MemoryStorage();
    storage.deleteFailure = new StorageError("OBJECT_NOT_FOUND", "missing");
    await expect(deleteStorageObjectBytes(storage, {
      driver: "filesystem", objectKey: `objects/original/${uuidv7()}`
    })).resolves.toEqual({ outcome: "already_missing" });
  });

  it("preserves retryable storage failure details for the future worker handler", async () => {
    const storage = new MemoryStorage();
    const failure = new StorageError("STORAGE_IO_ERROR", "dependency unavailable");
    storage.deleteFailure = failure;
    await expect(deleteStorageObjectBytes(storage, {
      driver: "filesystem", objectKey: `objects/original/${uuidv7()}`
    })).rejects.toBe(failure);
  });
});
