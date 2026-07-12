import { v7 as uuidv7 } from "uuid";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../database/migrationRunner.ts";
import type { QueryExecutor } from "../database/queryExecutor.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import { createStorageKey } from "./storageKey.ts";
import { PostgresStorageObjectRepository } from "./postgres/PostgresStorageObjectRepository.ts";

let database: PlatformTestDatabase;
let migration: Pool;
let web: Pool;
let worker: Pool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  web = database.createPool("web");
  worker = database.createPool("worker");
});

afterAll(async () => database?.dispose());

function stagingInput() {
  const id = uuidv7();
  return {
    id,
    driver: "filesystem" as const,
    objectKey: createStorageKey("objects/original", id),
    createdAt: new Date(),
    uploadExpiresAt: new Date(Date.now() + 60_000)
  };
}

describe("PostgresStorageObjectRepository", () => {
  it("creates diagnostic staging metadata without content fields", async () => {
    const repository = new PostgresStorageObjectRepository(web);
    const input = stagingInput();

    const created = await repository.createStaging(input);

    expect(created).toMatchObject({ ...input, status: "staging", sizeBytes: null, sha256: null, mediaType: null });
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it("atomically moves staging to ready and owns mutable content metadata", async () => {
    const repository = new PostgresStorageObjectRepository(web);
    const input = stagingInput();
    const created = await repository.createStaging(input);
    const hash = Buffer.alloc(32, 7);

    const ready = await repository.markReady(input.id, {
      sizeBytes: 123,
      sha256: hash,
      mediaType: "application/pdf",
      readyAt: new Date(created.createdAt.getTime() + 1)
    });
    hash.fill(9);

    expect(ready).toMatchObject({ status: "ready", sizeBytes: 123, mediaType: "application/pdf" });
    expect(ready.sha256).toEqual(Buffer.alloc(32, 7));
    await expect(repository.markReady(input.id, {
      sizeBytes: 123,
      sha256: Buffer.alloc(32, 7),
      mediaType: "application/pdf",
      readyAt: new Date(created.createdAt.getTime() + 1)
    })).rejects.toMatchObject({ code: "STORAGE_OBJECT_STATE_CONFLICT" });
  });

  it("distinguishes a missing object from a conflicting state", async () => {
    const repository = new PostgresStorageObjectRepository(web);
    await expect(repository.markReady(uuidv7(), {
      sizeBytes: 1,
      sha256: Buffer.alloc(32),
      mediaType: "application/pdf",
      readyAt: new Date()
    })).rejects.toMatchObject({ code: "STORAGE_OBJECT_NOT_FOUND" });
  });

  it("only moves ready objects to delete_pending", async () => {
    const repository = new PostgresStorageObjectRepository(web);
    const input = stagingInput();
    const created = await repository.createStaging(input);
    await expect(repository.markDeletePending(input.id, new Date())).rejects.toMatchObject({
      code: "STORAGE_OBJECT_STATE_CONFLICT"
    });
    const ready = await repository.markReady(input.id, {
      sizeBytes: 0,
      sha256: Buffer.alloc(32),
      mediaType: "application/pdf",
      readyAt: new Date(created.createdAt.getTime() + 1)
    });
    await expect(repository.markDeletePending(input.id, new Date(ready.readyAt!.getTime() + 1))).resolves.toMatchObject({
      status: "delete_pending"
    });
  });

  it("rejects backwards lifecycle timestamps instead of silently clamping them", async () => {
    const repository = new PostgresStorageObjectRepository(web);
    const input = { ...stagingInput(), createdAt: new Date("2026-07-12T00:00:00.000Z") };
    await repository.createStaging(input);
    await expect(repository.markReady(input.id, {
      sizeBytes: 1,
      sha256: Buffer.alloc(32),
      mediaType: "application/pdf",
      readyAt: new Date("2026-07-11T23:59:59.999Z")
    })).rejects.toMatchObject({ code: "INVALID_STORAGE_OBJECT_DATE_ORDER" });
    await expect(repository.findById(input.id)).resolves.toMatchObject({ status: "staging" });
  });

  it("classifies a backwards ready timestamp from one statement despite a concurrent state change", async () => {
    const input = { ...stagingInput(), createdAt: new Date("2026-07-12T00:00:00.000Z") };
    await new PostgresStorageObjectRepository(web).createStaging(input);
    let queries = 0;
    const executor: QueryExecutor = {
      async query(text, values) {
        queries += 1;
        const result = await web.query(text, values ? [...values] : undefined);
        if (queries === 1) {
          await migration.query(
            "UPDATE platform.storage_objects SET status = 'failed', updated_at = created_at WHERE id = $1",
            [input.id]
          );
        }
        return result;
      }
    };

    await expect(new PostgresStorageObjectRepository(executor).markReady(input.id, {
      sizeBytes: 1,
      sha256: Buffer.alloc(32),
      mediaType: "application/pdf",
      readyAt: new Date("2026-07-11T23:59:59.999Z")
    })).rejects.toMatchObject({ code: "INVALID_STORAGE_OBJECT_DATE_ORDER" });
    expect(queries).toBe(1);
  });

  it("classifies a backwards delete timestamp from one statement despite a concurrent state change", async () => {
    const input = { ...stagingInput(), createdAt: new Date("2026-07-10T00:00:00.000Z") };
    const repository = new PostgresStorageObjectRepository(web);
    await repository.createStaging(input);
    await repository.markReady(input.id, {
      sizeBytes: 1,
      sha256: Buffer.alloc(32),
      mediaType: "application/pdf",
      readyAt: new Date("2026-07-11T00:00:00.000Z")
    });
    let queries = 0;
    const executor: QueryExecutor = {
      async query(text, values) {
        queries += 1;
        const result = await web.query(text, values ? [...values] : undefined);
        if (queries === 1) {
          await migration.query(
            `UPDATE platform.storage_objects
             SET status = 'delete_pending', delete_requested_at = ready_at, updated_at = ready_at
             WHERE id = $1`,
            [input.id]
          );
        }
        return result;
      }
    };

    await expect(new PostgresStorageObjectRepository(executor).markDeletePending(
      input.id,
      new Date("2026-07-10T23:59:59.999Z")
    )).rejects.toMatchObject({ code: "INVALID_STORAGE_OBJECT_DATE_ORDER" });
    expect(queries).toBe(1);
  });

  it("validates bounded scans before querying", async () => {
    const repository = new PostgresStorageObjectRepository(web);
    await expect(repository.listStaleStaging(new Date(), 0)).rejects.toMatchObject({
      code: "INVALID_STORAGE_OBJECT_LIMIT"
    });
    await expect(repository.listDeletePending(new Date(), Number.NaN)).rejects.toMatchObject({
      code: "INVALID_STORAGE_OBJECT_LIMIT"
    });
  });

  it("selects staging cleanup by the hard upload deadline rather than creation age", async () => {
    const repository = new PostgresStorageObjectRepository(web);
    const now = new Date("2026-07-12T12:00:00.000Z");
    const oldButActive = { ...stagingInput(), createdAt: new Date("2026-01-01T00:00:00.000Z"), uploadExpiresAt: new Date("2026-07-12T12:00:01.000Z") };
    const recentButExpired = { ...stagingInput(), createdAt: new Date("2026-07-12T11:59:58.000Z"), uploadExpiresAt: new Date("2026-07-12T11:59:59.000Z") };
    await repository.createStaging(oldButActive);
    await repository.createStaging(recentButExpired);
    const selected = await repository.listStaleStaging(now, 10);
    expect(selected).toContainEqual(expect.objectContaining({ id: recentButExpired.id, uploadExpiresAt: recentButExpired.uploadExpiresAt }));
    expect(selected.map((object) => object.id)).not.toContain(oldButActive.id);
  });

  it("claims one S3 tombstone across concurrent workers and fences scheduling by token and generation", async () => {
    const webRepository = new PostgresStorageObjectRepository(web);
    const repository = new PostgresStorageObjectRepository(worker);
    const createdAt = new Date("2026-07-12T12:10:00.000Z");
    const requestedAt = new Date(createdAt.getTime() + 1_000);
    const input = {
      ...stagingInput(),
      driver: "s3" as const,
      createdAt,
      uploadExpiresAt: new Date(createdAt.getTime() + 500)
    };
    await webRepository.createStaging(input);
    await expect(repository.prepareCleanup({
      id: input.id,
      expectedStatus: "staging",
      driver: "s3",
      objectKey: input.objectKey,
      requestedAt,
      cleanupGeneration: 0
    })).resolves.toMatchObject({
      status: "delete_pending",
      cleanupTombstone: true,
      cleanupGeneration: 0,
      cleanupNotBefore: requestedAt
    });

    const [first, second] = await Promise.all([
      repository.claimCleanupReap({ workerId: "reaper-a", now: requestedAt, leaseDurationMs: 10_000, id: input.id }),
      repository.claimCleanupReap({ workerId: "reaper-b", now: requestedAt, leaseDurationMs: 10_000, id: input.id })
    ]);
    const claimed = first ?? second;
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(claimed).toMatchObject({
      cleanupGeneration: 1,
      cleanupLeaseOwner: expect.stringMatching(/^reaper-[ab]$/),
      cleanupLeaseToken: expect.any(String),
      cleanupLeaseExpiresAt: new Date(requestedAt.getTime() + 10_000)
    });

    const nextCleanupAt = new Date(requestedAt.getTime() + 60_000);
    await expect(repository.scheduleCleanupReap({
      id: input.id,
      driver: "s3",
      objectKey: input.objectKey,
      workerId: claimed!.cleanupLeaseOwner!,
      leaseToken: uuidv7(),
      expectedGeneration: claimed!.cleanupGeneration,
      scheduledAt: requestedAt,
      nextCleanupAt,
      lastError: null
    })).resolves.toBeUndefined();
    await expect(repository.scheduleCleanupReap({
      id: input.id,
      driver: "s3",
      objectKey: input.objectKey,
      workerId: claimed!.cleanupLeaseOwner!,
      leaseToken: claimed!.cleanupLeaseToken!,
      expectedGeneration: claimed!.cleanupGeneration,
      scheduledAt: requestedAt,
      nextCleanupAt,
      lastError: null
    })).resolves.toMatchObject({
      status: "delete_pending",
      cleanupTombstone: true,
      cleanupGeneration: 1,
      cleanupNotBefore: nextCleanupAt,
      cleanupLeaseOwner: null,
      cleanupLeaseToken: null,
      cleanupLeaseExpiresAt: null
    });
    const beforeDue = await repository.listDeletePending(new Date(nextCleanupAt.getTime() - 1), 10);
    expect(beforeDue.map((object) => object.id)).not.toContain(input.id);
    const atDue = await repository.listDeletePending(nextCleanupAt, 10);
    expect(atDue.map((object) => object.id)).not.toContain(input.id);
    await expect(repository.claimCleanupReap({
      workerId: "reaper-c",
      now: new Date(nextCleanupAt.getTime() - 1),
      leaseDurationMs: 10_000,
      id: input.id
    })).resolves.toBeNull();
    await expect(repository.claimCleanupReap({
      workerId: "reaper-c",
      now: nextCleanupAt,
      leaseDurationMs: 10_000,
      id: input.id
    })).resolves.toMatchObject({
      id: input.id,
      cleanupGeneration: 2,
      cleanupLeaseOwner: "reaper-c"
    });
  });

  it("lets an expired cleanup lease be reclaimed and rejects every stale owner transition", async () => {
    const repository = new PostgresStorageObjectRepository(worker);
    const createdAt = new Date("2026-07-12T12:20:00.000Z");
    const dueAt = new Date(createdAt.getTime() + 1_000);
    const input = {
      ...stagingInput(), driver: "s3" as const, createdAt,
      uploadExpiresAt: new Date(createdAt.getTime() + 500)
    };
    await new PostgresStorageObjectRepository(web).createStaging(input);
    await repository.prepareCleanup({
      id: input.id, expectedStatus: "staging", driver: "s3", objectKey: input.objectKey,
      requestedAt: dueAt, cleanupGeneration: 0
    });

    const oldLease = await repository.claimCleanupReap({
      workerId: "old-reaper", now: dueAt, leaseDurationMs: 1_000, id: input.id
    });
    await expect(repository.claimCleanupReap({
      workerId: "new-reaper", now: new Date(dueAt.getTime() + 999), leaseDurationMs: 1_000, id: input.id
    })).resolves.toBeNull();
    const newLease = await repository.claimCleanupReap({
      workerId: "new-reaper", now: new Date(dueAt.getTime() + 1_000), leaseDurationMs: 1_000, id: input.id
    });
    expect(newLease).toMatchObject({ cleanupGeneration: 2, cleanupLeaseOwner: "new-reaper" });

    await expect(repository.releaseCleanupReap({
      id: input.id, workerId: "old-reaper", leaseToken: oldLease!.cleanupLeaseToken!,
      expectedGeneration: oldLease!.cleanupGeneration, releasedAt: new Date(dueAt.getTime() + 1_001)
    })).resolves.toBeUndefined();
    await expect(repository.scheduleCleanupReap({
      id: input.id, driver: "s3", objectKey: input.objectKey, workerId: "old-reaper",
      leaseToken: oldLease!.cleanupLeaseToken!, expectedGeneration: oldLease!.cleanupGeneration,
      scheduledAt: new Date(dueAt.getTime() + 1_001), nextCleanupAt: new Date(dueAt.getTime() + 60_000), lastError: null
    })).resolves.toBeUndefined();
    await expect(repository.releaseCleanupReap({
      id: input.id, workerId: "new-reaper", leaseToken: newLease!.cleanupLeaseToken!,
      expectedGeneration: newLease!.cleanupGeneration, releasedAt: new Date(dueAt.getTime() + 1_001)
    })).resolves.toMatchObject({ cleanupLeaseOwner: null, cleanupLeaseToken: null, cleanupLeaseExpiresAt: null });
  });
});
