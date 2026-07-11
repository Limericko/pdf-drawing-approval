import { Readable } from "node:stream";
import type { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import { runMigrations } from "../database/migrationRunner.ts";
import { withTransaction } from "../database/transaction.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import type { CleanupIntent, CleanupIntentPublisher } from "./cleanupIntentPublisher.ts";
import type { StorageAdapter, StorageDriver } from "./storageAdapter.ts";
import { StorageError } from "./storageErrors.ts";
import { PostgresStorageObjectRepository } from "./postgres/PostgresStorageObjectRepository.ts";
import { deleteStorageObjectBytes, StorageObjectService } from "./storageObjectService.ts";
import { StorageReconciler } from "./storageReconciler.ts";

const WRITE_FAILURE_ID = "019f524e-d487-71a9-9853-199234c29b91";
const HEAD_MISMATCH_ID = "019f524e-d487-71a9-9853-199234c29b92";
const FINAL_UPDATE_FAILURE_ID = "019f524e-d487-71a9-9853-199234c29b93";
const INTERRUPTED_UPLOAD_ID = "019f524e-d487-71a9-9853-199234c29b94";

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
  async write(key: string, body: Readable, _contentType: string) {
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

function service(storage: StorageAdapter, runner = transactionRunner, createId?: () => string) {
  return new StorageObjectService({
    storage,
    transactionRunner: runner,
    createRepository: (executor) => new PostgresStorageObjectRepository(executor),
    createId
  });
}

async function findStoredObject(id: string) {
  const result = await web.query<{ status: string; driver: string; object_key: string }>(
    "SELECT status, driver, object_key FROM platform.storage_objects WHERE id = $1",
    [id]
  );
  return result.rows[0];
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
    const objectService = service(storage, transactionRunner, () => WRITE_FAILURE_ID);

    await expect(objectService.create({ body: Readable.from("pdf"), mediaType: "application/pdf" }))
      .rejects.toMatchObject({ code: "STORAGE_IO_ERROR" });

    const objectKey = `objects/original/${WRITE_FAILURE_ID}`;
    await expect(findStoredObject(WRITE_FAILURE_ID)).resolves.toEqual({
      status: "staging", driver: "filesystem", object_key: objectKey
    });
    expect(storage.objects.has(objectKey)).toBe(false);
  });

  it("rejects a head mismatch without reporting ready", async () => {
    const storage = new MemoryStorage();
    storage.headSizeDelta = 1;
    await expect(service(storage, transactionRunner, () => HEAD_MISMATCH_ID)
      .create({ body: Readable.from("pdf"), mediaType: "application/pdf" }))
      .rejects.toMatchObject({ code: "STORAGE_OBJECT_HEAD_MISMATCH" });
    const objectKey = `objects/original/${HEAD_MISMATCH_ID}`;
    await expect(findStoredObject(HEAD_MISMATCH_ID)).resolves.toEqual({
      status: "staging", driver: "filesystem", object_key: objectKey
    });
    expect(storage.objects.get(objectKey)?.toString()).toBe("pdf");
  });

  it("preserves the remote object and staging row when final database update fails", async () => {
    const storage = new MemoryStorage();
    let calls = 0;
    const failingFinalRunner = async <T>(callback: Parameters<typeof withTransaction<T>>[1]) => {
      calls += 1;
      if (calls === 2) throw new Error("FINAL_UPDATE_UNAVAILABLE");
      return transactionRunner(callback);
    };

    await expect(service(storage, failingFinalRunner, () => FINAL_UPDATE_FAILURE_ID)
      .create({ body: Readable.from("pdf"), mediaType: "application/pdf" }))
      .rejects.toThrow("FINAL_UPDATE_UNAVAILABLE");
    const objectKey = `objects/original/${FINAL_UPDATE_FAILURE_ID}`;
    await expect(findStoredObject(FINAL_UPDATE_FAILURE_ID)).resolves.toEqual({
      status: "staging", driver: "filesystem", object_key: objectKey
    });
    expect(storage.objects.get(objectKey)?.toString()).toBe("pdf");
  });

  it("reconciles an interrupted staging-write-head window without deleting bytes", async () => {
    const storage = new MemoryStorage();
    const id = INTERRUPTED_UPLOAD_ID;
    const objectKey = `objects/original/${id}`;
    await transactionRunner(async (tx) => new PostgresStorageObjectRepository(tx).createStaging({
      id, driver: storage.driver, objectKey, createdAt: new Date("2026-01-01T00:00:00.000Z")
    }));
    const written = await storage.write(objectKey, Readable.from("interrupted-pdf"), "application/pdf");
    const head = await storage.head(objectKey);

    expect(head).toEqual({ sizeBytes: written.sizeBytes });
    await expect(findStoredObject(id)).resolves.toEqual({
      status: "staging", driver: "filesystem", object_key: objectKey
    });
    expect(storage.objects.get(objectKey)?.toString()).toBe("interrupted-pdf");

    await expect(service(storage).openRead(id)).rejects.toMatchObject({ code: "STORAGE_OBJECT_NOT_READY" });
    expect(storage.calls).toEqual(["write", "head"]);

    const intents: CleanupIntent[] = [];
    const publisher: CleanupIntentPublisher = {
      async publish(_executor, intent) { intents.push(intent); }
    };
    const reconciler = new StorageReconciler({
      transactionRunner,
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      publisher,
      clock: () => new Date("2026-07-12T00:00:00.000Z"),
      stagingMaxAgeMs: 60_000,
      batchSize: 100
    });
    await reconciler.runOnce();

    expect(intents).toContainEqual(expect.objectContaining({
      storageObjectId: id,
      expectedStatus: "staging",
      idempotencyKey: `storage-object-cleanup:${id}:staging`
    }));
    expect(storage.objects.get(objectKey)?.toString()).toBe("interrupted-pdf");
    await expect(findStoredObject(id)).resolves.toEqual({
      status: "staging", driver: "filesystem", object_key: objectKey
    });
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
