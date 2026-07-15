import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import { runMigrations } from "../database/migrationRunner.ts";
import type { QueryExecutor } from "../database/queryExecutor.ts";
import { withTransaction } from "../database/transaction.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import type { CleanupIntent, CleanupIntentPublisher } from "./cleanupIntentPublisher.ts";
import type { StorageAdapter, StorageDriver } from "./storageAdapter.ts";
import { StorageError } from "./storageErrors.ts";
import { FilesystemStorage } from "./filesystemStorage.ts";
import { PostgresStorageObjectRepository } from "./postgres/PostgresStorageObjectRepository.ts";
import { S3Storage } from "./s3Storage.ts";
import { createStorageKey } from "./storageKey.ts";
import {
  deleteStorageObjectBytes,
  requestStorageObjectDeletion,
  StorageObjectService
} from "./storageObjectService.ts";
import { StorageReconciler } from "./storageReconciler.ts";

const WRITE_FAILURE_ID = "019f524e-d487-71a9-9853-199234c29b91";
const HEAD_MISMATCH_ID = "019f524e-d487-71a9-9853-199234c29b92";
const FINAL_UPDATE_FAILURE_ID = "019f524e-d487-71a9-9853-199234c29b93";
const INTERRUPTED_UPLOAD_ID = "019f524e-d487-71a9-9853-199234c29b94";
const OWNERSHIP_ID = "019f524e-d487-71a9-9853-199234c29b95";
const execFileAsync = promisify(execFile);
const asyncCleanupFixture = fileURLToPath(
  new URL("./__fixtures__/storageAsyncCleanupFixture.ts", import.meta.url)
);
const cleanupRaceFixture = fileURLToPath(
  new URL("./__fixtures__/storageCleanupRaceFixture.ts", import.meta.url)
);
const handoffFixture = fileURLToPath(
  new URL("./__fixtures__/storageHandoffFixture.ts", import.meta.url)
);

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
  readonly contentTypes: string[] = [];
  writeFailure?: Error;
  deleteFailure?: Error;
  headSizeDelta = 0;
  constructor(readonly driver: StorageDriver = "filesystem") {}
  async write(key: string, body: Readable, _contentType: string) {
    this.calls.push("write");
    this.contentTypes.push(_contentType);
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
    this.calls.push("delete");
    if (this.deleteFailure) throw this.deleteFailure;
    this.objects.delete(key);
  }
  async checkHealth() {}
}

function service(
  storage: StorageAdapter,
  runner = transactionRunner,
  createId?: () => string,
  clock?: () => Date
) {
  return new StorageObjectService({
    storage,
    transactionRunner: runner,
    createRepository: (executor) => new PostgresStorageObjectRepository(executor),
    createId,
    clock
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

  it("owns body and normalized media type before awaiting the staging transaction", async () => {
    const storage = new MemoryStorage();
    let release!: () => void;
    let entered!: () => void;
    const stagingEntered = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const barrierRunner = async <T>(callback: Parameters<typeof withTransaction<T>>[1]) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await barrier;
      }
      return transactionRunner(callback);
    };
    const input = { body: Readable.from("original"), mediaType: "  application/pdf  " };

    const creating = service(storage, barrierRunner, () => OWNERSHIP_ID).create(input);
    await stagingEntered;
    input.body = Readable.from("replacement");
    input.mediaType = "text/plain";
    release();
    const created = await creating;

    expect(storage.objects.get(created.objectKey)?.toString()).toBe("original");
    expect(storage.contentTypes).toEqual(["application/pdf"]);
    const metadata = await web.query<{ media_type: string }>(
      "SELECT media_type FROM platform.storage_objects WHERE id = $1", [OWNERSHIP_ID]
    );
    expect(metadata.rows[0]?.media_type).toBe("application/pdf");
  });

  it("rejects control characters in media type and destroys the unowned body", async () => {
    const storage = new MemoryStorage();
    const body = Readable.from("pdf");
    let transactionCalls = 0;
    const runner = async <T>(_callback: Parameters<typeof withTransaction<T>>[1]) => {
      transactionCalls += 1;
      throw new Error("SHOULD_NOT_RUN");
    };

    await expect(service(storage, runner).create({
      body,
      mediaType: "application/pdf\ntext/plain"
    })).rejects.toMatchObject({ code: "INVALID_STORAGE_OBJECT_MEDIA_TYPE" });
    expect(body.destroyed).toBe(true);
    expect(transactionCalls).toBe(0);
  });

  it.each([
    {
      name: "id generation",
      create: (storage: MemoryStorage, body: Readable, failure: Error) =>
        service(storage, transactionRunner, () => { throw failure; }).create({ body, mediaType: "application/pdf" })
    },
    {
      name: "clock validation",
      create: (storage: MemoryStorage, body: Readable, _failure: Error) =>
        service(storage, transactionRunner, () => uuidv7(), () => new Date(Number.NaN))
          .create({ body, mediaType: "application/pdf" })
    },
    {
      name: "staging database write",
      create: (storage: MemoryStorage, body: Readable, failure: Error) =>
        service(storage, async () => { throw failure; }).create({ body, mediaType: "application/pdf" })
    }
  ])("destroys the unowned body when $name fails before storage.write", async ({ create }) => {
    const storage = new MemoryStorage();
    const body = Readable.from("pdf");
    const failure = new Error("PREWRITE_FAILED");

    await expect(create(storage, body, failure)).rejects.toSatisfy(
      (error: unknown) => error === failure || (error as { code?: string }).code === "INVALID_STORAGE_OBJECT_CLOCK"
    );
    expect(body.destroyed).toBe(true);
    expect(storage.calls).toEqual([]);
  });

  it("awaits asynchronous stream cleanup errors and leaves no unmanaged process event", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", asyncCleanupFixture],
      { cwd: process.cwd(), timeout: 5_000, windowsHide: true }
    );

    expect(JSON.parse(stdout)).toEqual({
      aggregate: true,
      primaryCode: "INVALID_STORAGE_OBJECT_MEDIA_TYPE",
      causeIsPrimary: true,
      cleanupIsExpected: true,
      uncaughtCount: 0,
      unhandledCount: 0,
      errorListeners: 0,
      closeListeners: 0,
      destroyed: true
    });
  });

  it.each([
    ["already-destroying", ["ASYNC_STREAM_CLEANUP_FAILED"]],
    ["early-error", ["EARLY_STREAM_ERROR", "ASYNC_STREAM_CLEANUP_FAILED"]],
    ["early-close", ["ASYNC_STREAM_CLEANUP_FAILED"]],
    ["super-then-throw", ["DESTROY_AFTER_SUPER_FAILED", "ASYNC_STREAM_CLEANUP_FAILED"]]
  ] as const)("closes the %s cleanup race without losing failures", async (scenario, cleanupMessages) => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cleanupRaceFixture, scenario],
      { cwd: process.cwd(), timeout: 5_000, windowsHide: true }
    );

    expect(JSON.parse(stdout)).toEqual({
      aggregate: true,
      primaryCode: "INVALID_STORAGE_OBJECT_MEDIA_TYPE",
      causeIsPrimary: true,
      cleanupMessages,
      uncaughtMessages: [],
      unhandledCount: 0,
      errorListeners: 0,
      closeListeners: 0,
      destroyed: true,
      closed: true
    });
  });

  it("does not hand a body that failed during staging to the storage adapter", async () => {
    const storage = new MemoryStorage();
    const bodyFailure = new Error("BODY_FAILED_DURING_STAGING");
    const body = Readable.from("pdf");
    const observedByCaller: unknown[] = [];
    const callerErrorListener = (error: unknown) => { observedByCaller.push(error); };
    body.on("error", callerErrorListener);
    let release!: () => void;
    let entered!: () => void;
    const stagingEntered = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const barrierRunner = async <T>(callback: Parameters<typeof withTransaction<T>>[1]) => {
      entered();
      await barrier;
      return transactionRunner(callback);
    };

    const creating = service(storage, barrierRunner).create({ body, mediaType: "application/pdf" });
    await stagingEntered;
    body.destroy(bodyFailure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();

    await expect(creating).rejects.toBe(bodyFailure);
    expect(storage.calls).toEqual([]);
    expect(observedByCaller).toEqual([bodyFailure]);
    expect(body.listenerCount("error")).toBe(1);
    body.removeListener("error", callerErrorListener);
  });

  it.each([
    ["reject", {
      rejectionIsAdapterError: true,
      rejectionCode: "OBJECT_EXISTS",
      rejectionMessage: "adapter rejected the object"
    }],
    ["resolve", {
      rejectionIsAdapterError: false,
      rejectionCode: "STORAGE_IO_ERROR",
      rejectionMessage: "Storage input stream failed",
      causeName: "StorageCauseError",
      causeCode: "HANDOFF_GAP",
      causeMessage: "Storage dependency failed"
    }]
  ] as const)("bridges a body error while the adapter write will %s", async (mode, rejection) => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", handoffFixture, mode],
      { cwd: process.cwd(), timeout: 5_000, windowsHide: true }
    );

    expect(JSON.parse(stdout)).toEqual({
      result: "rejected",
      readyCalls: 0,
      headCalls: 0,
      uncaughtCodes: [],
      unhandledCount: 0,
      errorListeners: 0,
      destroyed: true,
      closed: true,
      ...rejection
    });
  });

  it("preserves primary and synchronous destroy errors in one AggregateError", async () => {
    const primary = new Error("INVALID_ID");
    const cleanup = new Error("SYNC_STREAM_CLEANUP_FAILED");
    class SyncThrowDestroyReadable extends Readable {
      override _read() {}
      override destroy(): this { throw cleanup; }
    }
    const body = new SyncThrowDestroyReadable();
    let rejection: unknown;
    try {
      await service(new MemoryStorage(), transactionRunner, () => { throw primary; })
        .create({ body, mediaType: "application/pdf" });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(AggregateError);
    const aggregate = rejection as AggregateError;
    expect(aggregate.errors).toEqual([primary, cleanup]);
    expect(aggregate.cause).toBe(primary);
    expect(body.listenerCount("error")).toBe(0);
    expect(body.listenerCount("close")).toBe(0);
  });

  it("waits for clean destroy completion when the stream has emitClose disabled", async () => {
    const primary = new Error("INVALID_ID");
    let cleanupCompleted = false;
    class NoCloseReadable extends Readable {
      constructor() { super({ emitClose: false }); }
      override _read() {}
      override _destroy(_error: Error | null, callback: (error?: Error | null) => void) {
        setImmediate(() => {
          cleanupCompleted = true;
          callback();
        });
      }
    }
    const body = new NoCloseReadable();

    await expect(service(new MemoryStorage(), transactionRunner, () => { throw primary; })
      .create({ body, mediaType: "application/pdf" })).rejects.toBe(primary);
    expect(cleanupCompleted).toBe(true);
    expect(body.listenerCount("error")).toBe(0);
    expect(body.listenerCount("close")).toBe(0);
  });

  it("keeps staging diagnostic state when object write fails", async () => {
    const storage = new MemoryStorage();
    storage.writeFailure = new StorageError("STORAGE_IO_ERROR", "write failed");
    const objectService = service(storage, transactionRunner, () => WRITE_FAILURE_ID);
    const body = Readable.from("pdf");

    await expect(objectService.create({ body, mediaType: "application/pdf" }))
      .rejects.toMatchObject({ code: "STORAGE_IO_ERROR" });

    const objectKey = `objects/original/${WRITE_FAILURE_ID}`;
    await expect(findStoredObject(WRITE_FAILURE_ID)).resolves.toEqual({
      status: "staging", driver: "filesystem", object_key: objectKey
    });
    expect(storage.objects.has(objectKey)).toBe(false);
    expect(storage.calls).toEqual(["write"]);
    expect(body.destroyed).toBe(false);
  });

  it.each(["filesystem", "s3"] as const)(
    "does not delete an existing %s object when the conditional write reports OBJECT_EXISTS",
    async (driver) => {
      const id = uuidv7();
      const objectKey = createStorageKey("objects/original", id);
      const original = Buffer.from("approved original drawing");
      const root = driver === "filesystem" ? await mkdtemp(join(tmpdir(), "pdf-approval-service-exists-")) : undefined;
      const storage = driver === "filesystem"
        ? new FilesystemStorage({ root: root! })
        : new S3Storage(readS3Config());
      await storage.write(objectKey, Readable.from(original), "application/pdf");
      const deleteSpy = vi.spyOn(storage, "delete");
      try {
        await expect(service(storage, transactionRunner, () => id).create({
          body: Readable.from("replacement drawing"),
          mediaType: "application/pdf"
        })).rejects.toMatchObject({ code: "OBJECT_EXISTS" });

        expect(deleteSpy).not.toHaveBeenCalled();
        expect(await readAll(await storage.openRead(objectKey))).toEqual(original);
        await expect(findStoredObject(id)).resolves.toMatchObject({ status: "staging", driver });
      } finally {
        deleteSpy.mockRestore();
        await storage.delete(objectKey);
        if (storage instanceof S3Storage) storage.destroy();
        if (root) await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("reports compensation failure while retaining deadline-owned staging metadata", async () => {
    const storage = new MemoryStorage();
    const primary = new StorageError("STORAGE_IO_ERROR", "write failed", { commitAmbiguous: true });
    const compensation = new StorageError("STORAGE_IO_ERROR", "delete failed");
    storage.writeFailure = primary;
    storage.deleteFailure = compensation;
    const id = uuidv7();

    await expect(service(storage, transactionRunner, () => id)
      .create({ body: Readable.from("pdf"), mediaType: "application/pdf" }))
      .rejects.toMatchObject({
        message: "STORAGE_UPLOAD_COMPENSATION_FAILED",
        cause: primary,
        errors: [primary, compensation]
      });
    await expect(findStoredObject(id)).resolves.toMatchObject({ status: "staging" });
    expect(storage.calls).toEqual(["write", "delete"]);
  });

  it("compensates an upload deadline abort and leaves durable staging ownership", async () => {
    const id = uuidv7();
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    let fireDeadline!: () => void;
    const deleted: string[] = [];
    const storage: StorageAdapter = {
      driver: "s3",
      async write(_key, _body, _contentType, options) {
        writeStarted();
        return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => {
          reject(new StorageError("STORAGE_IO_ERROR", "aborted write", { commitAmbiguous: true }));
        }, { once: true }));
      },
      async delete(key) { deleted.push(key); },
      async head() { return null; },
      async openRead() { throw new Error("UNUSED"); },
      async checkHealth() {}
    };
    const uploading = new StorageObjectService({
      storage,
      transactionRunner,
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      createId: () => id,
      clock: () => new Date("2026-07-12T12:30:00.000Z"),
      uploadTimeoutMs: 1_000,
      scheduleTimeout: (callback) => { fireDeadline = callback; return () => undefined; }
    }).create({ body: Readable.from("pdf"), mediaType: "application/pdf" });
    await started;
    fireDeadline();

    await expect(uploading).rejects.toMatchObject({ code: "STORAGE_IO_ERROR" });
    const objectKey = `objects/original/${id}`;
    expect(deleted).toEqual([objectKey]);
    await expect(findStoredObject(id)).resolves.toMatchObject({ status: "staging", object_key: objectKey });
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
      id, driver: storage.driver, objectKey, createdAt: new Date("2026-01-01T00:00:00.000Z"),
      uploadExpiresAt: new Date("2026-01-02T00:00:00.000Z")
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

  it("captures deletion id and requestedAt before awaiting reference removal", async () => {
    const firstId = uuidv7();
    const secondId = uuidv7();
    for (const id of [firstId, secondId]) {
      await migration.query(
        `INSERT INTO platform.storage_objects
          (id, status, driver, object_key, size_bytes, sha256, media_type, created_at, updated_at, ready_at)
         VALUES ($1, 'ready', 'filesystem', $2, 1, $3, 'application/pdf', $4, $4, $4)`,
        [id, `objects/original/${id}`, Buffer.alloc(32), new Date("2026-07-01T00:00:00.000Z")]
      );
    }
    let entered!: () => void;
    let release!: () => void;
    const removing = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const requestedAt = new Date("2026-07-02T00:00:00.000Z");
    const options = {
      storageObjectId: firstId,
      requestedAt,
      transactionRunner,
      createRepository: (executor: QueryExecutor) => new PostgresStorageObjectRepository(executor),
      publisher: { publish: async () => undefined } satisfies CleanupIntentPublisher,
      async removeReferences() {
        entered();
        await barrier;
      }
    };

    const deleting = requestStorageObjectDeletion(options);
    await removing;
    options.storageObjectId = secondId;
    requestedAt.setUTCDate(10);
    release();
    await deleting;

    const states = await web.query<{ id: string; status: string; delete_requested_at: Date | null }>(
      "SELECT id, status, delete_requested_at FROM platform.storage_objects WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[firstId, secondId]]
    );
    const first = states.rows.find((row) => row.id === firstId);
    const second = states.rows.find((row) => row.id === secondId);
    expect(first).toMatchObject({ status: "delete_pending", delete_requested_at: new Date("2026-07-02T00:00:00.000Z") });
    expect(second).toMatchObject({ status: "ready", delete_requested_at: null });
  });

  it("rejects an invalid deletion timestamp before opening a transaction", async () => {
    let transactionCalls = 0;
    await expect(requestStorageObjectDeletion({
      storageObjectId: uuidv7(),
      requestedAt: new Date(Number.NaN),
      transactionRunner: async () => { transactionCalls += 1; throw new Error("SHOULD_NOT_RUN"); },
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      publisher: { publish: async () => undefined },
      removeReferences: async () => undefined
    })).rejects.toMatchObject({ code: "INVALID_STORAGE_OBJECT_DATE" });
    expect(transactionCalls).toBe(0);
  });
});

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

async function readAll(body: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
