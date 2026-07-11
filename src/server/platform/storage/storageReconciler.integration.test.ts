import type { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import { runMigrations } from "../database/migrationRunner.ts";
import { withTransaction } from "../database/transaction.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import type { QueryExecutor } from "../database/queryExecutor.ts";
import type { CleanupIntent, CleanupIntentPublisher } from "./cleanupIntentPublisher.ts";
import { PostgresStorageObjectRepository } from "./postgres/PostgresStorageObjectRepository.ts";
import { requestStorageObjectDeletion } from "./storageObjectService.ts";
import { StorageReconciler } from "./storageReconciler.ts";

let database: PlatformTestDatabase;
let migration: Pool;
let web: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  await migration.query("CREATE TABLE platform.test_storage_refs(id uuid PRIMARY KEY, storage_object_id uuid NOT NULL REFERENCES platform.storage_objects(id))");
  await migration.query("CREATE TABLE platform.test_cleanup_intents(idempotency_key text PRIMARY KEY, payload jsonb NOT NULL)");
  await migration.query("GRANT SELECT, INSERT, DELETE ON platform.test_storage_refs TO platform_web");
  await migration.query("GRANT SELECT, INSERT ON platform.test_cleanup_intents TO platform_web");
  web = createPlatformPool({
    connectionString: database.urls.web, poolMax: 4, connectTimeoutMs: 2_000,
    queryTimeoutMs: 2_000, lockTimeoutMs: 1_000, transactionTimeoutMs: 5_000
  }, "storage-reconciler-test");
});

afterAll(async () => {
  await web?.end();
  await database?.dispose();
});

const transactionRunner = <T>(callback: (tx: QueryExecutor) => Promise<T>) => withTransaction(web, callback);

class RecordingPublisher implements CleanupIntentPublisher {
  readonly intents: CleanupIntent[] = [];
  async publish(_executor: QueryExecutor, intent: CleanupIntent) { this.intents.push(intent); }
}

class DatabasePublisher implements CleanupIntentPublisher {
  async publish(executor: QueryExecutor, intent: CleanupIntent) {
    await executor.query(
      "INSERT INTO platform.test_cleanup_intents(idempotency_key, payload) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING",
      [intent.idempotencyKey, JSON.stringify(intent)]
    );
  }
}

async function insertObject(status: "staging" | "ready" | "delete_pending", createdAt: Date) {
  const id = uuidv7();
  await migration.query(
    `INSERT INTO platform.storage_objects
       (id, status, driver, object_key, size_bytes, sha256, media_type, created_at, updated_at, ready_at, delete_requested_at)
     VALUES ($1, $2, 'filesystem', $3, $4, $5, $6, $7::timestamptz, $7::timestamptz,
       CASE WHEN $2 IN ('ready', 'delete_pending') THEN $7::timestamptz ELSE NULL END,
       CASE WHEN $2 = 'delete_pending' THEN $7::timestamptz ELSE NULL END)`,
    [id, status, `objects/original/${id}`, status === "staging" ? null : 1,
      status === "staging" ? null : Buffer.alloc(32), status === "staging" ? null : "application/pdf", createdAt]
  );
  return id;
}

describe("StorageReconciler", () => {
  it("publishes bounded stable intents for stale staging and delete_pending without deleting bytes", async () => {
    const now = new Date("2026-07-12T00:00:00.000Z");
    const stale = await insertObject("staging", new Date("2026-07-10T00:00:00.000Z"));
    await insertObject("staging", new Date("2026-07-11T23:59:00.000Z"));
    const pending = await insertObject("delete_pending", new Date("2026-07-09T00:00:00.000Z"));
    const publisher = new RecordingPublisher();
    const reconciler = new StorageReconciler({
      transactionRunner,
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      publisher,
      clock: () => now,
      stagingMaxAgeMs: 60 * 60 * 1000,
      batchSize: 10
    });

    await reconciler.runOnce();
    const first = publisher.intents.map((intent) => intent.idempotencyKey).sort();
    await reconciler.runOnce();
    const second = publisher.intents.slice(2).map((intent) => intent.idempotencyKey).sort();

    expect(first).toEqual([
      `storage-object-cleanup:${pending}:delete_pending`,
      `storage-object-cleanup:${stale}:staging`
    ].sort());
    expect(second).toEqual(first);
    expect(publisher.intents.every((intent) => intent.payloadVersion === 1)).toBe(true);
  });

  it("commits reference removal, delete_pending and cleanup publication in one transaction", async () => {
    const id = await insertObject("ready", new Date("2026-07-10T00:00:00.000Z"));
    const referenceId = uuidv7();
    await web.query("INSERT INTO platform.test_storage_refs(id, storage_object_id) VALUES ($1, $2)", [referenceId, id]);

    await requestStorageObjectDeletion({
      storageObjectId: id,
      requestedAt: new Date(),
      transactionRunner,
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      publisher: new DatabasePublisher(),
      removeReferences: (executor) => executor.query("DELETE FROM platform.test_storage_refs WHERE storage_object_id = $1", [id]).then(() => undefined)
    });

    const state = await web.query<{ status: string; refs: string; intents: string }>(
      `SELECT so.status,
        (SELECT count(*) FROM platform.test_storage_refs WHERE storage_object_id = so.id)::text AS refs,
        (SELECT count(*) FROM platform.test_cleanup_intents WHERE payload->>'storageObjectId' = so.id::text)::text AS intents
       FROM platform.storage_objects so WHERE so.id = $1`, [id]
    );
    expect(state.rows[0]).toEqual({ status: "delete_pending", refs: "0", intents: "1" });
  });

  it("rolls back reference removal and state when cleanup publication fails", async () => {
    const id = await insertObject("ready", new Date("2026-07-10T00:00:00.000Z"));
    await web.query("INSERT INTO platform.test_storage_refs(id, storage_object_id) VALUES ($1, $2)", [uuidv7(), id]);
    const publisher: CleanupIntentPublisher = { publish: async () => { throw new Error("OUTBOX_UNAVAILABLE"); } };

    await expect(requestStorageObjectDeletion({
      storageObjectId: id,
      requestedAt: new Date(), transactionRunner,
      createRepository: (executor) => new PostgresStorageObjectRepository(executor), publisher,
      removeReferences: (executor) => executor.query("DELETE FROM platform.test_storage_refs WHERE storage_object_id = $1", [id]).then(() => undefined)
    })).rejects.toThrow("OUTBOX_UNAVAILABLE");

    const state = await web.query<{ status: string; refs: string }>(
      `SELECT so.status, (SELECT count(*) FROM platform.test_storage_refs WHERE storage_object_id = so.id)::text AS refs
       FROM platform.storage_objects so WHERE so.id = $1`, [id]
    );
    expect(state.rows[0]).toEqual({ status: "ready", refs: "1" });
  });

  it("rolls back all transactional publications when a later publish fails", async () => {
    await insertObject("staging", new Date("2026-07-01T00:00:00.000Z"));
    await insertObject("staging", new Date("2026-07-02T00:00:00.000Z"));
    let publications = 0;
    const publisher: CleanupIntentPublisher = {
      async publish(executor, intent) {
        publications += 1;
        await new DatabasePublisher().publish(executor, intent);
        if (publications === 2) throw new Error("PUBLISH_FAILED");
      }
    };
    const reconciler = new StorageReconciler({
      transactionRunner,
      createRepository: (executor) => new PostgresStorageObjectRepository(executor),
      publisher,
      clock: () => new Date("2026-07-12T00:00:00.000Z"),
      stagingMaxAgeMs: 60_000,
      batchSize: 2
    });

    await expect(reconciler.runOnce()).rejects.toThrow("PUBLISH_FAILED");
    const count = await web.query<{ count: string }>("SELECT count(*)::text AS count FROM platform.test_cleanup_intents");
    expect(count.rows[0]?.count).toBe("1"); // one intent belongs to the prior committed deletion test
  });
});
