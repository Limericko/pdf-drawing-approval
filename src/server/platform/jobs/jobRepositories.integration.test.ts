import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import type { QueryExecutor } from "../database/queryExecutor.ts";
import { withTransaction } from "../database/transaction.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import { OutboxDispatcher } from "./dispatcher.ts";
import type { CreateJob, JsonObject } from "./jobTypes.ts";
import { PostgresJobRepository } from "./postgres/PostgresJobRepository.ts";
import { PostgresOutboxRepository } from "./postgres/PostgresOutboxRepository.ts";
import { CleanupIntentOutboxPublisher, PostgresOutboxPublisher } from "./outboxPublisher.ts";

let database: PlatformTestDatabase;
let migration: Pool;
let web: PlatformPool;
let worker: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  await migration.query("CREATE TABLE platform.test_business_state (id uuid PRIMARY KEY, value text NOT NULL)");
  await migration.query("GRANT SELECT, INSERT ON platform.test_business_state TO platform_web");
  web = createPlatformPool(poolConfig(database.urls.web), "jobs-web-test");
  worker = createPlatformPool(poolConfig(database.urls.worker), "jobs-worker-test");
});

afterAll(async () => {
  await web?.end();
  await worker?.end();
  await database?.dispose();
});

beforeEach(async () => {
  await migration.query("TRUNCATE platform.jobs, platform.outbox_events, platform.test_business_state");
});

const webTransaction = <T>(callback: (executor: QueryExecutor) => Promise<T>) => withTransaction(web, callback);
const workerTransaction = <T>(callback: (executor: QueryExecutor) => Promise<T>) => withTransaction(worker, callback);

describe("PostgreSQL outbox", () => {
  it("commits and rolls back business state with an outbox event on the same executor", async () => {
    const committedId = uuidv7();
    const rolledBackId = uuidv7();
    const publisher = new PostgresOutboxPublisher({ createId: uuidv7, clock: () => new Date() });

    await webTransaction(async (transaction) => {
      await transaction.query("INSERT INTO platform.test_business_state (id, value) VALUES ($1, $2)", [committedId, "committed"]);
      await publisher.publish(transaction, { eventType: "business_changed", payloadVersion: 1, payload: { id: committedId } });
    });
    await expect(webTransaction(async (transaction) => {
      await transaction.query("INSERT INTO platform.test_business_state (id, value) VALUES ($1, $2)", [rolledBackId, "rolled-back"]);
      await publisher.publish(transaction, { eventType: "business_changed", payloadVersion: 1, payload: { id: rolledBackId } });
      throw new Error("ROLLBACK");
    })).rejects.toThrow("ROLLBACK");

    const state = await web.query<{ id: string }>("SELECT id FROM platform.test_business_state WHERE id = ANY($1::uuid[])", [[committedId, rolledBackId]]);
    const events = await web.query<{ payload: { id: string } }>("SELECT payload FROM platform.outbox_events WHERE payload->>'id' = ANY($1::text[])", [[committedId, rolledBackId]]);
    expect(state.rows.map((row) => row.id)).toEqual([committedId]);
    expect(events.rows.map((row) => row.payload.id)).toEqual([committedId]);
  });

  it("owns JSON input and rejects values that are not safely persistable", async () => {
    const id = uuidv7();
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const queryEntered = new Promise<void>((resolve) => { entered = resolve; });
    const publisher = new PostgresOutboxPublisher({ createId: () => id, clock: () => new Date() });
    const payload = { nested: { value: "original" } };
    const executor: QueryExecutor = {
      async query(text, values) {
        entered();
        await barrier;
        return web.query(text, values ? [...values] : undefined);
      }
    };

    const publishing = publisher.publish(executor, { eventType: "owned", payloadVersion: 1, payload });
    await queryEntered;
    payload.nested.value = "mutated";
    release();
    await publishing;
    const stored = await web.query<{ payload: unknown }>("SELECT payload FROM platform.outbox_events WHERE id = $1", [id]);
    expect(stored.rows[0]?.payload).toEqual({ nested: { value: "original" } });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let tooDeep: Record<string, unknown> = {};
    for (let depth = 0; depth < 70; depth += 1) tooDeep = { nested: tooDeep };
    const sparse = new Array(2);
    sparse[1] = "value";
    let validationQueries = 0;
    const validationExecutor: QueryExecutor = {
      async query() {
        validationQueries += 1;
        throw new Error("VALIDATION_REACHED_DATABASE");
      }
    };
    const unsafePublisher = new PostgresOutboxPublisher({ createId: uuidv7, clock: () => new Date() });
    const unsafePayloads: unknown[] = [
      [], cyclic, tooDeep, { values: Array.from({ length: 10_001 }, () => null) }, sparse,
      { value: undefined }, { value: 1n }, { value: () => undefined }, { value: Symbol("unsafe") },
      { value: Number.NaN }, { value: Number.POSITIVE_INFINITY },
      JSON.parse('{"__proto__":true}'), { nested: { constructor: "unsafe" } }, { prototype: "unsafe" },
      Object.assign(Object.create({ polluted: true }), { safe: true })
    ];
    for (const unsafe of unsafePayloads) {
      await expect(unsafePublisher.publish(validationExecutor, {
        eventType: "unsafe", payloadVersion: 1, payload: unsafe as never
      }))
        .rejects.toMatchObject({ code: "INVALID_OUTBOX_EVENT" });
    }
    expect(validationQueries).toBe(0);
  });

  it("adapts the Task 12 cleanup-intent port to a stable versioned outbox event on the same executor", async () => {
    const storageObjectId = uuidv7();
    const committedEventId = uuidv7();
    const rolledBackEventId = uuidv7();
    const ids = [committedEventId, rolledBackEventId];
    const adapter = new CleanupIntentOutboxPublisher(new PostgresOutboxPublisher({
      createId: () => ids.shift()!, clock: () => new Date("2026-07-12T00:00:00.000Z")
    }));
    const intent = {
      type: "storage_object_cleanup" as const,
      payloadVersion: 1 as const,
      idempotencyKey: `storage-object-cleanup:${storageObjectId}:delete_pending`,
      storageObjectId,
      expectedStatus: "delete_pending" as const,
      driver: "filesystem" as const,
      objectKey: `objects/original/${storageObjectId}`
    };

    await webTransaction((transaction) => adapter.publish(transaction, intent));
    await expect(webTransaction(async (transaction) => {
      await adapter.publish(transaction, intent);
      throw new Error("ROLLBACK_CLEANUP_INTENT");
    })).rejects.toThrow("ROLLBACK_CLEANUP_INTENT");

    const rows = await web.query<{ id: string; event_type: string; payload_version: number; payload: unknown }>(
      "SELECT id, event_type, payload_version, payload FROM platform.outbox_events WHERE id = ANY($1::uuid[])",
      [[committedEventId, rolledBackEventId]]
    );
    expect(rows.rows).toEqual([{
      id: committedEventId,
      event_type: "storage_object_cleanup",
      payload_version: 1,
      payload: {
        idempotencyKey: intent.idempotencyKey,
        storageObjectId,
        expectedStatus: "delete_pending",
        driver: "filesystem",
        objectKey: intent.objectKey
      }
    }]);
    await expect(adapter.publish(web, { ...intent, idempotencyKey: "wrong" }))
      .rejects.toMatchObject({ code: "INVALID_OUTBOX_EVENT" });
  });

  it("rejects malformed text at the outbox row-mapping boundary", async () => {
    await migration.query(
      `INSERT INTO platform.outbox_events (id, event_type, payload_version, payload)
       VALUES ($1, $2, 1, '{}'::jsonb)`,
      [uuidv7(), "unsafe\nrow"]
    );

    await expect(new PostgresOutboxRepository(worker).claimUndispatched(1))
      .rejects.toMatchObject({ code: "INVALID_OUTBOX_ROW" });
  });
});

describe("OutboxDispatcher", () => {
  it("creates an idempotent versioned job and marks its event dispatched in one transaction", async () => {
    const event = await publishEvent("dispatch_once", { documentId: uuidv7() });
    const dispatcher = createDispatcher(workerTransaction, "v3");

    await expect(dispatcher.dispatchBatch(10)).resolves.toBe(1);
    await expect(dispatcher.dispatchBatch(10)).resolves.toBe(0);

    const stored = await worker.query<{ idempotency_key: string; status: string; payload: unknown }>(
      "SELECT idempotency_key, status, payload FROM platform.jobs WHERE idempotency_key = $1",
      [`outbox:${event.id}:v3`]
    );
    expect(stored.rows).toEqual([expect.objectContaining({
      idempotency_key: `outbox:${event.id}:v3`, status: "pending", payload: { documentId: event.payload.documentId }
    })]);
    await expect(worker.query<{ dispatched_at: Date | null }>("SELECT dispatched_at FROM platform.outbox_events WHERE id = $1", [event.id]))
      .resolves.toMatchObject({ rows: [{ dispatched_at: expect.any(Date) }] });
  });

  it("uses independent connections and SKIP LOCKED so concurrent dispatchers take different events", async () => {
    const first = await publishEvent("concurrent", { sequence: 1 });
    const second = await publishEvent("concurrent", { sequence: 2 });
    let release!: () => void;
    let locked!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const firstLocked = new Promise<void>((resolve) => { locked = resolve; });
    const pausingRunner = <T>(callback: (executor: QueryExecutor) => Promise<T>) => withTransaction(worker, async (transaction) => {
      const wrapped: QueryExecutor = {
        async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) {
          const result = await transaction.query<R>(text, values);
          if (/FOR UPDATE SKIP LOCKED/i.test(text)) {
            locked();
            await barrier;
          }
          return result;
        }
      };
      return callback(wrapped);
    });

    const dispatchingFirst = createDispatcher(pausingRunner, "v1").dispatchBatch(1);
    await firstLocked;
    const dispatchingSecond = createDispatcher(workerTransaction, "v1").dispatchBatch(1);
    await expect(dispatchingSecond).resolves.toBe(1);
    release();
    await expect(dispatchingFirst).resolves.toBe(1);

    const jobs = await worker.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM platform.jobs WHERE idempotency_key = ANY($1::text[]) ORDER BY idempotency_key",
      [[`outbox:${first.id}:v1`, `outbox:${second.id}:v1`]]
    );
    expect(jobs.rows.map((row) => row.idempotency_key)).toEqual([
      `outbox:${first.id}:v1`, `outbox:${second.id}:v1`
    ].sort());
  });
});

describe("PostgresJobRepository", () => {
  it("atomically claims one due job and ignores the same idempotency key", async () => {
    const repository = new PostgresJobRepository(worker);
    const input = jobInput({ idempotencyKey: `same:${uuidv7()}` });
    await expect(repository.create(input)).resolves.toMatchObject({ created: true });
    await expect(repository.create({ ...input, id: uuidv7() })).resolves.toMatchObject({ created: false, job: { id: input.id } });
    const claims = await Promise.all([
      repository.claim({ workerId: "worker-a", now: input.nextRunAt, leaseDurationMs: 10_000 }),
      repository.claim({ workerId: "worker-b", now: input.nextRunAt, leaseDurationMs: 10_000 })
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ status: "running", attemptCount: 1, workerId: expect.any(String), leaseToken: expect.any(String) });
  });

  it("observes a concurrently committed winner after ON CONFLICT DO NOTHING", async () => {
    const input = jobInput({ idempotencyKey: `concurrent-create:${uuidv7()}` });
    let releaseWinner!: () => void;
    let winnerInserted!: () => void;
    let loserQueryStarted!: () => void;
    const holdWinner = new Promise<void>((resolve) => { releaseWinner = resolve; });
    const winnerReady = new Promise<void>((resolve) => { winnerInserted = resolve; });
    const loserReady = new Promise<void>((resolve) => { loserQueryStarted = resolve; });

    const winner = workerTransaction(async (transaction) => {
      const result = await new PostgresJobRepository(transaction).create(input);
      winnerInserted();
      await holdWinner;
      return result;
    });
    await winnerReady;
    const loser = workerTransaction(async (transaction) => {
      let firstQuery = true;
      const wrapped: QueryExecutor = {
        query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) {
          if (firstQuery) {
            firstQuery = false;
            loserQueryStarted();
          }
          return transaction.query<R>(text, values);
        }
      };
      return new PostgresJobRepository(wrapped).create({ ...input, id: uuidv7() });
    });
    await loserReady;
    releaseWinner();

    await expect(Promise.all([winner, loser])).resolves.toEqual([
      expect.objectContaining({ created: true, job: expect.objectContaining({ id: input.id }) }),
      expect.objectContaining({ created: false, job: expect.objectContaining({ id: input.id }) })
    ]);
  });

  it("rejects an idempotency-key collision with different job content", async () => {
    const repository = new PostgresJobRepository(worker);
    const input = jobInput({ idempotencyKey: `collision:${uuidv7()}` });
    await repository.create(input);
    await expect(repository.create({ ...input, id: uuidv7(), jobType: "different" }))
      .rejects.toMatchObject({ code: "JOB_IDEMPOTENCY_CONFLICT" });
  });

  it("treats JSON object key order as the same idempotent content", async () => {
    const repository = new PostgresJobRepository(worker);
    const input = jobInput({
      idempotencyKey: `json-order:${uuidv7()}`,
      payload: { outer: { first: 1, second: 2 }, tail: true }
    });
    await repository.create(input);

    await expect(repository.create({
      ...input,
      id: uuidv7(),
      payload: { tail: true, outer: { second: 2, first: 1 } }
    })).resolves.toMatchObject({ created: false, job: { id: input.id } });
  });

  it("uses JSONB number semantics for negative zero without hiding different numbers", async () => {
    const repository = new PostgresJobRepository(worker);
    const negativeZero = jobInput({
      idempotencyKey: `negative-zero:${uuidv7()}`,
      payload: { value: -0 }
    });
    await repository.create(negativeZero);
    await expect(repository.create({ ...negativeZero, id: uuidv7(), payload: { value: -0 } }))
      .resolves.toMatchObject({ created: false, job: { id: negativeZero.id } });
    await expect(repository.create({ ...negativeZero, id: uuidv7(), payload: { value: 0 } }))
      .resolves.toMatchObject({ created: false, job: { id: negativeZero.id } });

    const positiveZero = jobInput({
      idempotencyKey: `positive-zero:${uuidv7()}`,
      payload: { value: 0 }
    });
    await repository.create(positiveZero);
    await expect(repository.create({ ...positiveZero, id: uuidv7(), payload: { value: -0 } }))
      .resolves.toMatchObject({ created: false, job: { id: positiveZero.id } });
    await expect(repository.create({ ...positiveZero, id: uuidv7(), payload: { value: 1 } }))
      .rejects.toMatchObject({ code: "JOB_IDEMPOTENCY_CONFLICT" });
  });

  it("reclaims an expired lease with a new token and fences every stale worker write", async () => {
    const repository = new PostgresJobRepository(worker);
    const dueAt = new Date("2026-07-12T01:00:00.000Z");
    const input = jobInput({ maxAttempts: 3, nextRunAt: dueAt });
    await repository.create(input);
    const first = await repository.claim({ workerId: "old-worker", now: dueAt, leaseDurationMs: 1_000 });
    const reclaimedAt = new Date(dueAt.getTime() + 1_001);
    const second = await repository.claim({ workerId: "new-worker", now: reclaimedAt, leaseDurationMs: 10_000 });
    expect(second).toMatchObject({ id: input.id, attemptCount: 2, workerId: "new-worker" });
    expect(second!.leaseToken).not.toBe(first!.leaseToken);

    await expect(repository.renewLease({ id: input.id, workerId: "old-worker", leaseToken: first!.leaseToken!, now: reclaimedAt, leaseDurationMs: 20_000 }))
      .rejects.toMatchObject({ code: "STALE_LEASE" });
    await expect(repository.succeed({ id: input.id, workerId: "old-worker", leaseToken: first!.leaseToken!, completedAt: reclaimedAt }))
      .rejects.toMatchObject({ code: "STALE_LEASE" });
    await expect(repository.fail({ id: input.id, workerId: "old-worker", leaseToken: first!.leaseToken!, failedAt: reclaimedAt, kind: "permanent", errorCode: "OLD", errorMessage: "old failure" }))
      .rejects.toMatchObject({ code: "STALE_LEASE" });
    await expect(repository.findById(input.id)).resolves.toMatchObject({ workerId: "new-worker", leaseToken: second!.leaseToken, status: "running" });
  });

  it("renews, succeeds and clears the active lease", async () => {
    const repository = new PostgresJobRepository(worker);
    const dueAt = new Date("2026-07-12T02:00:00.000Z");
    const input = jobInput({ nextRunAt: dueAt });
    await repository.create(input);
    const claimed = await repository.claim({ workerId: "worker-success", now: dueAt, leaseDurationMs: 1_000 });
    const renewed = await repository.renewLease({ id: input.id, workerId: "worker-success", leaseToken: claimed!.leaseToken!, now: dueAt, leaseDurationMs: 2_000 });
    expect(renewed.leaseExpiresAt).toEqual(new Date(dueAt.getTime() + 2_000));
    const succeeded = await repository.succeed({ id: input.id, workerId: "worker-success", leaseToken: claimed!.leaseToken!, completedAt: new Date(dueAt.getTime() + 10) });
    expect(succeeded).toMatchObject({ status: "succeeded", workerId: null, leaseToken: null, leaseExpiresAt: null, completedAt: expect.any(Date) });
  });

  it("does not let a worker renew an already expired lease", async () => {
    const firstToken = randomUUID();
    const secondToken = randomUUID();
    const tokens = [firstToken, secondToken];
    const repository = new PostgresJobRepository(worker, { createLeaseToken: () => tokens.shift()! });
    const dueAt = new Date("2026-07-12T02:30:00.000Z");
    const input = jobInput({ nextRunAt: dueAt });
    await repository.create(input);
    const claimed = await repository.claim({ workerId: "expired-worker", now: dueAt, leaseDurationMs: 1_000 });
    const expiredAt = new Date(dueAt.getTime() + 1_001);

    await expect(repository.renewLease({
      id: input.id, workerId: "expired-worker", leaseToken: claimed!.leaseToken!,
      now: expiredAt, leaseDurationMs: 10_000
    })).rejects.toMatchObject({ code: "STALE_LEASE" });
    await expect(repository.claim({ workerId: "replacement-worker", now: expiredAt, leaseDurationMs: 10_000 }))
      .resolves.toMatchObject({ workerId: "replacement-worker", leaseToken: secondToken, attemptCount: 2 });
  });

  it("reschedules a transient failure then moves the maximum attempt to dead", async () => {
    const repository = new PostgresJobRepository(worker);
    const dueAt = new Date("2026-07-12T03:00:00.000Z");
    const input = jobInput({ maxAttempts: 2, nextRunAt: dueAt });
    await repository.create(input);
    const first = await repository.claim({ workerId: "retry-worker", now: dueAt, leaseDurationMs: 1_000 });
    const retryAt = new Date(dueAt.getTime() + 5_000);
    const pending = await repository.fail({
      id: input.id, workerId: "retry-worker", leaseToken: first!.leaseToken!, failedAt: dueAt,
      kind: "transient", errorCode: "SMTP_TEMPORARY", errorMessage: "retry later", nextRunAt: retryAt
    });
    expect(pending).toMatchObject({ status: "pending", nextRunAt: retryAt, completedAt: null, workerId: null });
    const second = await repository.claim({ workerId: "retry-worker", now: retryAt, leaseDurationMs: 1_000 });
    const dead = await repository.fail({
      id: input.id, workerId: "retry-worker", leaseToken: second!.leaseToken!, failedAt: retryAt,
      kind: "transient", errorCode: "SMTP_TEMPORARY", errorMessage: "still unavailable", nextRunAt: new Date(retryAt.getTime() + 5_000)
    });
    expect(dead).toMatchObject({ status: "dead", attemptCount: 2, completedAt: retryAt, workerId: null });
  });

  it("moves a permanent failure directly to dead", async () => {
    const repository = new PostgresJobRepository(worker);
    const dueAt = new Date("2026-07-12T04:00:00.000Z");
    const input = jobInput({ maxAttempts: 5, nextRunAt: dueAt });
    await repository.create(input);
    const claimed = await repository.claim({ workerId: "permanent-worker", now: dueAt, leaseDurationMs: 1_000 });
    await expect(repository.fail({
      id: input.id, workerId: "permanent-worker", leaseToken: claimed!.leaseToken!, failedAt: dueAt,
      kind: "permanent", errorCode: "INVALID_RECIPIENT", errorMessage: "invalid recipient"
    })).resolves.toMatchObject({ status: "dead", attemptCount: 1, completedAt: dueAt });
  });

  it("marks an exhausted expired lease dead even when no job can be claimed", async () => {
    const repository = new PostgresJobRepository(worker);
    const dueAt = new Date("2026-07-12T05:00:00.000Z");
    const input = jobInput({ maxAttempts: 1, nextRunAt: dueAt });
    await repository.create(input);
    await repository.claim({ workerId: "crashed-worker", now: dueAt, leaseDurationMs: 1_000 });
    const recoveryAt = new Date(dueAt.getTime() + 1_001);

    await expect(repository.claim({ workerId: "recovery-worker", now: recoveryAt, leaseDurationMs: 1_000 })).resolves.toBeNull();
    await expect(repository.findById(input.id)).resolves.toMatchObject({
      status: "dead", completedAt: recoveryAt, updatedAt: recoveryAt,
      workerId: null, leaseToken: null, leaseExpiresAt: null,
      lastErrorCode: "LEASE_EXPIRED_MAX_ATTEMPTS"
    });
  });

  it("skips a locked exhausted lease and still claims a due pending job", async () => {
    const repository = new PostgresJobRepository(worker);
    const dueAt = new Date("2026-07-12T05:30:00.000Z");
    const exhausted = jobInput({ maxAttempts: 1, nextRunAt: dueAt });
    const pending = jobInput({ nextRunAt: dueAt });
    await repository.create(exhausted);
    await repository.create(pending);
    await repository.claim({ workerId: "crashed-worker", now: dueAt, leaseDurationMs: 1 });
    const recoveryAt = new Date(dueAt.getTime() + 2);
    const locker = await worker.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM platform.jobs WHERE id = $1 FOR UPDATE", [exhausted.id]);

      const claimed = await workerTransaction(async (transaction) => {
        await transaction.query("SELECT set_config('lock_timeout', '100ms', true)");
        return new PostgresJobRepository(transaction).claim({
          workerId: "available-worker", now: recoveryAt, leaseDurationMs: 1_000
        });
      });

      expect(claimed).toMatchObject({ id: pending.id, workerId: "available-worker", status: "running" });
    } finally {
      try {
        await locker.query("ROLLBACK");
      } finally {
        locker.release();
      }
    }
  });

  it("rejects malformed text at the job row-mapping boundary", async () => {
    const input = jobInput();
    await migration.query(
      `INSERT INTO platform.jobs (
         id, job_type, payload_version, payload, idempotency_key, status,
         attempt_count, max_attempts, next_run_at, created_at, updated_at
       ) VALUES ($1, $2, 1, '{}'::jsonb, $3, 'pending', 0, 1, $4, $4, $4)`,
      [input.id, "unsafe\nrow", input.idempotencyKey, input.createdAt]
    );

    await expect(new PostgresJobRepository(worker).findById(input.id))
      .rejects.toMatchObject({ code: "INVALID_JOB_ROW" });
  });
});

function poolConfig(connectionString: string) {
  return { connectionString, poolMax: 4, connectTimeoutMs: 2_000, queryTimeoutMs: 2_000, lockTimeoutMs: 1_000, transactionTimeoutMs: 5_000 };
}

async function publishEvent(eventType: string, payload: JsonObject) {
  return webTransaction((transaction) => new PostgresOutboxPublisher({ createId: uuidv7, clock: () => new Date() })
    .publish(transaction, { eventType, payloadVersion: 1, payload }));
}

function createDispatcher(transactionRunner: typeof workerTransaction, handlerVersion: string) {
  return new OutboxDispatcher({
    transactionRunner,
    createOutboxRepository: (executor) => new PostgresOutboxRepository(executor),
    createJobRepository: (executor) => new PostgresJobRepository(executor),
    createId: uuidv7,
    clock: () => new Date(),
    mapEvent: (event) => ({
      handlerVersion,
      jobType: event.eventType,
      payloadVersion: event.payloadVersion,
      payload: event.payload,
      maxAttempts: 3
    })
  });
}

function jobInput(overrides: Partial<CreateJob> = {}): CreateJob {
  const input = { ...baseJobInput(), ...overrides };
  if (overrides.nextRunAt && !overrides.createdAt) input.createdAt = new Date(overrides.nextRunAt.getTime());
  return input;
}

function baseJobInput(): CreateJob {
  const id = uuidv7();
  return {
    id,
    jobType: "test_job",
    payloadVersion: 1,
    payload: { id },
    idempotencyKey: `test:${id}`,
    maxAttempts: 3,
    nextRunAt: new Date(),
    createdAt: new Date()
  };
}
