import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { type PlatformTestDatabase, withPlatformTestDatabase } from "../testing/postgresHarness.ts";
import { runMigrations } from "./migrationRunner.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000000001",
  project: "01890f1e-9b4a-7cc2-8f00-000000000002",
  invitation: "01890f1e-9b4a-7cc2-8f00-000000000003",
  totp: "01890f1e-9b4a-7cc2-8f00-000000000004",
  recoveryCode: "01890f1e-9b4a-7cc2-8f00-000000000005",
  audit: "01890f1e-9b4a-7cc2-8f00-000000000006",
  auditSubject: "01890f1e-9b4a-7cc2-8f00-00000000000f",
  storage: "01890f1e-9b4a-7cc2-8f00-000000000007",
  outbox: "01890f1e-9b4a-7cc2-8f00-000000000008",
  job: "01890f1e-9b4a-7cc2-8f00-000000000009",
  session: "01890f1e-9b4a-7cc2-8f00-000000000013"
} as const;

const expectedTables = [
  "audit_events",
  "invitations",
  "jobs",
  "mfa_challenges",
  "mfa_enrollments",
  "outbox_events",
  "project_members",
  "projects",
  "recovery_codes",
  "security_rate_limit_buckets",
  "sessions",
  "storage_objects",
  "totp_credentials",
  "users",
  "worker_heartbeats"
] as const;

type SqlStatement = readonly [sql: string, values?: unknown[]];

async function withMigratedDatabase(run: (database: PlatformTestDatabase, migration: Pool) => Promise<void>) {
  await withPlatformTestDatabase(async (database) => {
    const migration = database.createPool("migration");
    await expect(runMigrations(migration)).resolves.toEqual({ applied: 3, verified: 0, total: 3 });
    await run(database, migration);
  });
}

async function expectDenied(pool: Pool, sql: string, values: unknown[] = []) {
  await expect(pool.query(sql, values)).rejects.toMatchObject({ code: "42501" });
}

async function expectTransactionAllowed(pool: Pool, statements: readonly SqlStatement[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [sql, values] of statements) await client.query(sql, values ?? []);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function seedPermissionFixtures(migration: Pool) {
  await migration.query(
    `INSERT INTO platform.users
      (id, email_normalized, display_name, password_hash, platform_role, status, mfa_status)
     VALUES ($1, 'audit-subject@example.test', 'Audit Subject', '$argon2id$audit-subject', 'member', 'active', 'disabled')`,
    [ids.auditSubject]
  );
  await migration.query(
    `INSERT INTO platform.audit_events
      (id, actor_user_id, actor_type, action, target_type, target_id, request_id, result, metadata)
     VALUES ('01890f1e-9b4a-7cc2-8f00-000000000010', $1, 'user', 'account.create', 'user', $1,
       'request-audit-retention', 'success', '{}'::jsonb)`,
    [ids.auditSubject]
  );
  await migration.query(
    `INSERT INTO platform.users
      (id, email_normalized, display_name, password_hash, platform_role, status, mfa_status)
     VALUES ($1, 'seed@example.test', 'Seed User', '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA', 'member', 'active', 'enabled')`,
    [ids.user]
  );
  await migration.query(
    `WITH times AS (SELECT clock_timestamp() AS now)
     INSERT INTO platform.sessions
       (id, user_id, token_hash, created_at, absolute_expires_at, idle_expires_at,
        last_activity_at, last_touch_at, client_summary)
     SELECT $1, $2, decode(repeat('55', 32), 'hex'), now, now + interval '12 hours',
       now + interval '1 hour', now, now, 'seed browser'
     FROM times`,
    [ids.session, ids.user]
  );
  await migration.query(
    "INSERT INTO platform.projects (id, name, status) VALUES ($1, 'Seed Project', 'active')",
    [ids.project]
  );
  await migration.query(
    `INSERT INTO platform.invitations
      (id, token_hash, token_key_version, email_normalized, platform_role, project_id, project_role,
       invited_by_user_id, expires_at)
     VALUES ($1, decode(repeat('11', 32), 'hex'), 1, 'invitee@example.test', 'member', $2, 'viewer', $3,
       clock_timestamp() + interval '24 hours')`,
    [ids.invitation, ids.project, ids.user]
  );
  await migration.query(
    `INSERT INTO platform.storage_objects
      (id, status, driver, object_key, size_bytes, sha256, media_type, ready_at)
     VALUES ($1, 'ready', 'filesystem', 'seed/object.pdf', 4, decode(repeat('22', 32), 'hex'),
       'application/pdf', clock_timestamp())`,
    [ids.storage]
  );
  await migration.query(
    `INSERT INTO platform.outbox_events (id, event_type, payload_version, payload)
     VALUES ($1, 'invitation.created', 1, '{}'::jsonb)`,
    [ids.outbox]
  );
  await migration.query(
    `INSERT INTO platform.jobs
      (id, job_type, payload_version, payload, idempotency_key, status, attempt_count, max_attempts, next_run_at)
     VALUES ($1, 'invitation.email', 1, '{}'::jsonb, 'seed-job', 'pending', 0, 5, clock_timestamp())`,
    [ids.job]
  );
}

describe("Phase 1 PostgreSQL platform schema", () => {
  it("applies all production migrations once and verifies the same history on a repeated run", async () => {
    await withMigratedDatabase(async (_database, migration) => {
      await expect(runMigrations(migration)).resolves.toEqual({ applied: 0, verified: 3, total: 3 });
      const history = await migration.query<{ version: number; file_name: string }>(
        "SELECT version, file_name FROM platform.schema_migrations ORDER BY version"
      );
      expect(history.rows).toEqual([
        { version: 1, file_name: "0001_identity_projects.sql" },
        { version: 2, file_name: "0002_security_sessions_audit.sql" },
        { version: 3, file_name: "0003_storage_outbox_jobs.sql" }
      ]);
    });
  });

  it("creates only platform tables with UUIDv7 application IDs and the required column types and constraints", async () => {
    await withMigratedDatabase(async (_database, migration) => {
      const tables = await migration.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'platform' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'
         ORDER BY table_name`
      );
      expect(tables.rows.map(({ table_name }) => table_name)).toEqual(expectedTables);

      const publicTables = await migration.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
        [expectedTables]
      );
      expect(publicTables.rows).toEqual([]);

      const typedColumns = await migration.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        column_default: string | null;
      }>(
        `SELECT table_name, column_name, data_type, column_default
         FROM information_schema.columns
         WHERE table_schema = 'platform'
           AND (data_type = 'uuid'
             OR (table_name, column_name) IN (
               ('users', 'password_hash'), ('invitations', 'token_hash'),
               ('totp_credentials', 'encrypted_secret'), ('recovery_codes', 'code_hash'),
               ('mfa_challenges', 'token_hash'), ('mfa_enrollments', 'encrypted_totp_secret'),
               ('sessions', 'token_hash'), ('storage_objects', 'sha256'),
               ('outbox_events', 'payload'), ('jobs', 'payload'),
               ('users', 'created_at'), ('jobs', 'lease_expires_at')
             ))`
      );
      const byColumn: Map<string, (typeof typedColumns.rows)[number]> = new Map(
        typedColumns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row] as const)
      );
      for (const row of typedColumns.rows.filter(({ data_type }) => data_type === "uuid")) {
        expect(row.column_default, `${row.table_name}.${row.column_name} default`).toBeNull();
      }
      expect(byColumn.get("users.password_hash")?.data_type).toBe("text");
      for (const key of [
        "invitations.token_hash",
        "totp_credentials.encrypted_secret",
        "recovery_codes.code_hash",
        "mfa_challenges.token_hash",
        "mfa_enrollments.encrypted_totp_secret",
        "sessions.token_hash",
        "storage_objects.sha256"
      ]) {
        expect(byColumn.get(key)?.data_type, `${key} type`).toBe("bytea");
      }
      expect(byColumn.get("outbox_events.payload")?.data_type).toBe("jsonb");
      expect(byColumn.get("jobs.payload")?.data_type).toBe("jsonb");
      expect(byColumn.get("users.created_at")?.data_type).toBe("timestamp with time zone");
      expect(byColumn.get("jobs.lease_expires_at")?.data_type).toBe("timestamp with time zone");

      const structuralViolations = await migration.query<{ violation: string }>(
        `SELECT format('%s lacks a primary key', table_name) AS violation
         FROM unnest($1::text[]) AS table_name
         WHERE NOT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid = format('platform.%I', table_name)::regclass AND contype = 'p'
         )
         UNION ALL
         SELECT format('%s.%s uses timestamp without time zone', table_name, column_name)
         FROM information_schema.columns
         WHERE table_schema = 'platform' AND data_type = 'timestamp without time zone'
         UNION ALL
         SELECT format('%s.%s is not lowercase snake_case', table_name, column_name)
         FROM information_schema.columns
         WHERE table_schema = 'platform'
           AND (table_name !~ '^[a-z][a-z0-9_]*$' OR column_name !~ '^[a-z][a-z0-9_]*$')`,
        [expectedTables]
      );
      expect(structuralViolations.rows).toEqual([]);

      const emailUnique = await migration.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid = 'platform.users'::regclass AND contype = 'u'
             AND pg_get_constraintdef(oid) = 'UNIQUE (email_normalized)'
         ) AS exists`
      );
      expect(emailUnique.rows[0]?.exists).toBe(true);

      const checks = await migration.query<{ table_name: string; definition: string }>(
        `SELECT c.conrelid::regclass::text AS table_name, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         WHERE c.connamespace = 'platform'::regnamespace AND c.contype = 'c'`
      );
      const definitions = checks.rows.map(({ definition }) => definition).join("\n");
      expect(definitions).toContain("platform_role");
      expect(definitions).toContain("manager");
      expect(definitions).toContain("octet_length(sha256) = 32");
      expect(definitions).toContain("expires_at > created_at");
      expect(definitions).toContain("lease_token");
      expect(definitions).toContain("attempt_count");
      expect(definitions).toContain("substr((id)::text, 15, 1) = '7'");

      const requiredChecks = new Map(
        checks.rows.map(({ table_name, definition }) => [`${table_name}:${definition}`, definition])
      );
      for (const table of ["platform.mfa_challenges", "platform.mfa_enrollments"]) {
        expect(
          [...requiredChecks.entries()].some(
            ([key, definition]) => key.startsWith(`${table}:`) && definition.includes("completed_at <= expires_at")
          ),
          `${table} completion expiry check`
        ).toBe(true);
      }

      const idsWithoutV7Checks = await migration.query<{ table_name: string }>(
        `SELECT c.table_name
         FROM information_schema.columns c
         WHERE c.table_schema = 'platform' AND c.column_name = 'id' AND c.data_type = 'uuid'
           AND NOT EXISTS (
             SELECT 1 FROM pg_constraint constraint_record
             WHERE constraint_record.conrelid = format('platform.%I', c.table_name)::regclass
               AND constraint_record.contype = 'c'
               AND pg_get_constraintdef(constraint_record.oid) LIKE '%substr((id)::text, 15, 1) = ''7''%'
           )`
      );
      expect(idsWithoutV7Checks.rows).toEqual([]);
    });
  });

  it("indexes every foreign key by its leading columns and exposes query-matching partial indexes", async () => {
    await withMigratedDatabase(async (_database, migration) => {
      const missingForeignKeyIndexes = await migration.query<{ table_name: string; constraint_name: string }>(
        `SELECT c.conrelid::regclass::text AS table_name, c.conname AS constraint_name
         FROM pg_constraint c
         WHERE c.connamespace = 'platform'::regnamespace AND c.contype = 'f'
           AND NOT EXISTS (
             SELECT 1 FROM pg_index i
             WHERE i.indrelid = c.conrelid AND i.indisvalid AND i.indpred IS NULL
               AND i.indnkeyatts >= cardinality(c.conkey)
               AND NOT EXISTS (
                 SELECT 1 FROM generate_subscripts(c.conkey, 1) AS position
                 WHERE i.indkey[position - 1] <> c.conkey[position]
               )
           )`
      );
      expect(missingForeignKeyIndexes.rows).toEqual([]);

      const implicitDeleteActions = await migration.query<{ table_name: string; constraint_name: string }>(
        `SELECT c.conrelid::regclass::text AS table_name, c.conname AS constraint_name
         FROM pg_constraint c
         WHERE c.connamespace = 'platform'::regnamespace AND c.contype = 'f' AND c.confdeltype = 'a'`
      );
      expect(implicitDeleteActions.rows).toEqual([]);

      const partialIndexes = await migration.query<{ index_name: string; predicate: string }>(
        `SELECT indexrelid::regclass::text AS index_name, pg_get_expr(indpred, indrelid) AS predicate
         FROM pg_index
         WHERE indrelid::regclass::text = ANY($1::text[]) AND indpred IS NOT NULL`,
        [[
          "platform.invitations",
          "platform.mfa_enrollments",
          "platform.sessions",
          "platform.outbox_events",
          "platform.jobs",
          "platform.storage_objects"
        ]]
      );
      const predicates = new Map(
        partialIndexes.rows.map(({ index_name, predicate }) => [index_name.replace("platform.", ""), predicate])
      );
      expect(predicates.get("invitations_active_idx")).toContain("accepted_at IS NULL");
      expect(predicates.get("invitations_active_idx")).toContain("revoked_at IS NULL");
      expect(predicates.get("mfa_enrollments_active_invitation_uidx")).toContain("invalidated_at IS NULL");
      expect(predicates.get("mfa_enrollments_active_invitation_uidx")).toContain("completed_at IS NULL");
      expect(predicates.get("sessions_active_idx")).toContain("revoked_at IS NULL");
      expect(predicates.get("outbox_events_undispatched_idx")).toContain("dispatched_at IS NULL");
      expect(predicates.get("jobs_pending_idx")).toBe("(status = 'pending'::text)");
      expect(predicates.get("jobs_running_lease_idx")).toBe("(status = 'running'::text)");
      expect(predicates.get("jobs_dead_idx")).toBe("(status = 'dead'::text)");
      expect(predicates.get("storage_objects_staging_idx")).toBe("(status = 'staging'::text)");
      expect(predicates.get("storage_objects_delete_pending_idx")).toBe("(status = 'delete_pending'::text)");
      expect([...predicates.values()].every((predicate) => !predicate.toLowerCase().includes("now()"))).toBe(true);
    });
  });

  it("enforces job status invariants without blocking retry, lease recovery, success, or dead transitions", async () => {
    await withMigratedDatabase(async (_database, migration) => {
      const insertJob = (id: string, status: string, attemptCount: number, maxAttempts: number) =>
        migration.query(
          `INSERT INTO platform.jobs
            (id, job_type, payload_version, payload, idempotency_key, status, attempt_count, max_attempts,
             next_run_at)
           VALUES ($1, 'state.test', 1, '{}'::jsonb, $2, $3, $4, $5, clock_timestamp())`,
          [id, `state-${id}`, status, attemptCount, maxAttempts]
        );
      const claimNextJob = (workerId: string, leaseExpiresAt: Date, leaseToken: string) =>
        migration.query<{ id: string; status: string; attempt_count: number; started_at: Date | null }>(
          `WITH next_job AS (
             SELECT id FROM platform.jobs
             WHERE (status = 'pending' AND next_run_at <= now())
                OR (status = 'running' AND lease_expires_at <= now() AND attempt_count < max_attempts)
             ORDER BY next_run_at, created_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           UPDATE platform.jobs j
           SET status = 'running', worker_id = $1, lease_expires_at = $2,
             lease_token = $3, attempt_count = attempt_count + 1
           FROM next_job
           WHERE j.id = next_job.id
           RETURNING j.id, j.status, j.attempt_count, j.started_at`,
          [workerId, leaseExpiresAt, leaseToken]
        );

      await expect(
        insertJob("01890f1e-9b4a-7cc2-8f00-000000000020", "pending", 5, 5)
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        migration.query(
          `INSERT INTO platform.jobs
            (id, job_type, payload_version, payload, idempotency_key, status, attempt_count, max_attempts,
             next_run_at, worker_id, lease_token, lease_expires_at)
           VALUES ('01890f1e-9b4a-7cc2-8f00-000000000021', 'state.test', 1, '{}'::jsonb, 'running-zero',
             'running', 0, 5, clock_timestamp(), 'worker-a', '11890f1e-9b4a-4cc2-8f00-000000000021',
             clock_timestamp() + interval '1 minute')`
        )
      ).rejects.toMatchObject({ code: "23514" });
      for (const [id, status] of [
        ["01890f1e-9b4a-7cc2-8f00-000000000022", "succeeded"],
        ["01890f1e-9b4a-7cc2-8f00-000000000023", "dead"]
      ] as const) {
        await expect(
          migration.query(
            `INSERT INTO platform.jobs
              (id, job_type, payload_version, payload, idempotency_key, status, attempt_count, max_attempts,
               next_run_at, started_at)
             VALUES ($1, 'state.test', 1, '{}'::jsonb, $2, $3, 1, 5, clock_timestamp(), clock_timestamp())`,
            [id, `terminal-${status}`, status]
          )
        ).rejects.toMatchObject({ code: "23514" });
      }

      const retryJobId = "01890f1e-9b4a-7cc2-8f00-000000000024";
      await insertJob(retryJobId, "pending", 0, 3);
      const initialClaim = await claimNextJob(
        "worker-a",
        new Date(Date.now() + 60_000),
        "11890f1e-9b4a-4cc2-8f00-000000000024"
      );
      expect(initialClaim.rows).toEqual([
        { id: retryJobId, status: "running", attempt_count: 1, started_at: null }
      ]);
      await migration.query(
        `UPDATE platform.jobs
         SET status = 'pending', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
           next_run_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [retryJobId]
      );
      const retryClaim = await claimNextJob(
        "worker-b",
        new Date(Date.now() - 1_000),
        "11890f1e-9b4a-4cc2-8f00-000000000025"
      );
      expect(retryClaim.rows[0]).toMatchObject({ id: retryJobId, status: "running", attempt_count: 2, started_at: null });
      const recoveredClaim = await claimNextJob(
        "worker-c",
        new Date(Date.now() + 60_000),
        "11890f1e-9b4a-4cc2-8f00-000000000027"
      );
      expect(recoveredClaim.rows[0]).toMatchObject({ id: retryJobId, status: "running", attempt_count: 3, started_at: null });
      await migration.query(
        `UPDATE platform.jobs
         SET status = 'succeeded', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [retryJobId]
      );

      const deadJobId = "01890f1e-9b4a-7cc2-8f00-000000000026";
      await insertJob(deadJobId, "pending", 0, 1);
      const maxAttemptClaim = await claimNextJob(
        "worker-d",
        new Date(Date.now() - 1_000),
        "11890f1e-9b4a-4cc2-8f00-000000000026"
      );
      expect(maxAttemptClaim.rows[0]).toMatchObject({ id: deadJobId, status: "running", attempt_count: 1, started_at: null });
      await migration.query(
        `UPDATE platform.jobs
         SET status = 'dead', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [deadJobId]
      );

      const terminalRows = await migration.query<{ id: string; status: string; attempt_count: number }>(
        "SELECT id, status, attempt_count FROM platform.jobs WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[retryJobId, deadJobId]]
      );
      expect(terminalRows.rows).toEqual([
        { id: retryJobId, status: "succeeded", attempt_count: 3 },
        { id: deadJobId, status: "dead", attempt_count: 1 }
      ]);
    });
  });

  it("orders storage lifecycle timestamps while allowing stale staging cleanup", async () => {
    await withMigratedDatabase(async (_database, migration) => {
      const insertReady = (id: string, objectKey: string, readyAt: string) =>
        migration.query(
          `INSERT INTO platform.storage_objects
            (id, status, driver, object_key, size_bytes, sha256, media_type, created_at, updated_at, ready_at)
           VALUES ($1, 'ready', 'filesystem', $2, 4, decode(repeat('88', 32), 'hex'), 'application/pdf',
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', $3)`,
          [id, objectKey, readyAt]
        );

      const deletedBeforeRequestId = "01890f1e-9b4a-7cc2-8f00-000000000030";
      await insertReady(deletedBeforeRequestId, "invalid/deleted-before-request.pdf", "2026-01-01T01:00:00Z");
      await migration.query(
        `UPDATE platform.storage_objects
         SET status = 'delete_pending', delete_requested_at = '2026-01-01T03:00:00Z'
         WHERE id = $1`,
        [deletedBeforeRequestId]
      );
      await expect(
        migration.query(
          `UPDATE platform.storage_objects
           SET status = 'deleted', deleted_at = '2026-01-01T02:00:00Z'
           WHERE id = $1`,
          [deletedBeforeRequestId]
        )
      ).rejects.toMatchObject({ code: "23514" });

      const requestBeforeReadyId = "01890f1e-9b4a-7cc2-8f00-000000000031";
      await insertReady(requestBeforeReadyId, "invalid/request-before-ready.pdf", "2026-01-01T03:00:00Z");
      await expect(
        migration.query(
          `UPDATE platform.storage_objects
           SET status = 'delete_pending', delete_requested_at = '2026-01-01T02:00:00Z'
           WHERE id = $1`,
          [requestBeforeReadyId]
        )
      ).rejects.toMatchObject({ code: "23514" });

      const validReadyId = "01890f1e-9b4a-7cc2-8f00-000000000032";
      await insertReady(validReadyId, "valid/ready-delete.pdf", "2026-01-01T01:00:00Z");
      await migration.query(
        `UPDATE platform.storage_objects
         SET status = 'delete_pending', delete_requested_at = '2026-01-01T02:00:00Z'
         WHERE id = $1`,
        [validReadyId]
      );
      await migration.query(
        `UPDATE platform.storage_objects
         SET status = 'deleted', deleted_at = '2026-01-01T03:00:00Z'
         WHERE id = $1`,
        [validReadyId]
      );

      const staleStagingId = "01890f1e-9b4a-7cc2-8f00-000000000033";
      await migration.query(
        `INSERT INTO platform.storage_objects
          (id, status, driver, object_key, created_at, updated_at)
         VALUES ($1, 'staging', 'filesystem', 'valid/stale-staging.pdf',
           '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        [staleStagingId]
      );
      await migration.query(
        `UPDATE platform.storage_objects
         SET status = 'delete_pending', delete_requested_at = '2026-01-01T02:00:00Z'
         WHERE id = $1`,
        [staleStagingId]
      );
      await migration.query(
        `UPDATE platform.storage_objects
         SET status = 'deleted', deleted_at = '2026-01-01T03:00:00Z'
         WHERE id = $1`,
        [staleStagingId]
      );

      const deletedRows = await migration.query<{ id: string; status: string; ready_at: Date | null }>(
        "SELECT id, status, ready_at FROM platform.storage_objects WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[validReadyId, staleStagingId]]
      );
      expect(deletedRows.rows).toEqual([
        { id: validReadyId, status: "deleted", ready_at: new Date("2026-01-01T01:00:00Z") },
        { id: staleStagingId, status: "deleted", ready_at: null }
      ]);
    });
  });

  it("enforces PUBLIC, migration, web, worker, and bootstrap privileges with real role connections", async () => {
    await withMigratedDatabase(async (database, migration) => {
      await seedPermissionFixtures(migration);

      await expect(
        migration.query(
          `INSERT INTO platform.storage_objects
            (id, status, driver, object_key, size_bytes, sha256, media_type)
           VALUES ('01890f1e-9b4a-7cc2-8f00-000000000011', 'ready', 'filesystem', 'invalid/ready.pdf',
             4, decode(repeat('44', 32), 'hex'), 'application/pdf')`
        )
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        migration.query(
          `UPDATE platform.invitations
           SET accepted_at = expires_at + interval '1 second', accepted_by_user_id = $2
           WHERE id = $1`,
          [ids.invitation, ids.user]
        )
      ).rejects.toMatchObject({ code: "23514" });

      await expect(migration.query("DELETE FROM platform.users WHERE id = $1", [ids.auditSubject])).rejects.toMatchObject({
        code: "23503"
      });
      const retainedActor = await migration.query<{ actor_user_id: string | null }>(
        "SELECT actor_user_id FROM platform.audit_events WHERE request_id = 'request-audit-retention'"
      );
      expect(retainedActor.rows).toEqual([{ actor_user_id: ids.auditSubject }]);

      const publicPrivileges = await migration.query<{ schema_usage: boolean; table_access: boolean }>(
        `SELECT has_schema_privilege('public', 'platform', 'USAGE') AS schema_usage,
          EXISTS (
            SELECT 1 FROM unnest($1::text[]) AS table_name
            WHERE has_table_privilege('public', format('platform.%I', table_name), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          ) AS table_access`,
        [expectedTables]
      );
      expect(publicPrivileges.rows[0]).toEqual({ schema_usage: false, table_access: false });

      await expectTransactionAllowed(migration, [
        ["CREATE TABLE platform.migration_ddl_probe (id integer PRIMARY KEY)"],
        ["DROP TABLE platform.migration_ddl_probe"]
      ]);

      const web = database.createPool("web");
      await expect(web.query("SELECT email_normalized FROM platform.users WHERE id = $1", [ids.user])).resolves.toMatchObject({
        rowCount: 1
      });
      await expectTransactionAllowed(web, [
        ["UPDATE platform.users SET display_name = 'Updated User', updated_at = clock_timestamp() WHERE id = $1", [ids.user]],
        ["UPDATE platform.sessions SET last_activity_at = clock_timestamp() WHERE false"],
        ["UPDATE platform.invitations SET revoked_at = clock_timestamp() WHERE id = $1", [ids.invitation]],
        ["UPDATE platform.storage_objects SET last_error = 'retryable', updated_at = clock_timestamp() WHERE id = $1", [ids.storage]],
        [
          `INSERT INTO platform.audit_events
            (id, actor_user_id, actor_type, action, target_type, target_id, request_id, result, metadata)
           VALUES ($1, $2, 'user', 'project.read', 'project', $3, 'request-web', 'success', '{}'::jsonb)`,
          [ids.audit, ids.user, ids.project]
        ],
        [
          `INSERT INTO platform.outbox_events (id, event_type, payload_version, payload)
           VALUES ('01890f1e-9b4a-7cc2-8f00-00000000000a', 'web.test', 1, '{}'::jsonb)`
        ],
        [
          `INSERT INTO platform.jobs
            (id, job_type, payload_version, payload, idempotency_key, status, attempt_count, max_attempts, next_run_at)
           VALUES ('01890f1e-9b4a-7cc2-8f00-000000000012', 'web.test', 1, '{}'::jsonb, 'web-job',
             'pending', 0, 5, clock_timestamp())`
        ]
      ]);
      await expectDenied(web, "DELETE FROM platform.audit_events");
      await expectDenied(web, "UPDATE platform.audit_events SET result = 'failure'");
      await expectDenied(web, "UPDATE platform.jobs SET status = 'running'");
      for (const statement of [
        "UPDATE platform.users SET id = '01890f1e-9b4a-7cc2-8f00-000000000014'",
        "UPDATE platform.users SET created_at = clock_timestamp()",
        "UPDATE platform.sessions SET user_id = '01890f1e-9b4a-7cc2-8f00-000000000014'",
        "UPDATE platform.sessions SET token_hash = decode(repeat('66', 32), 'hex')",
        "UPDATE platform.sessions SET created_at = clock_timestamp()",
        "UPDATE platform.invitations SET token_hash = decode(repeat('77', 32), 'hex')",
        "UPDATE platform.invitations SET token_key_version = 2",
        "UPDATE platform.invitations SET project_id = '01890f1e-9b4a-7cc2-8f00-000000000014'",
        "UPDATE platform.storage_objects SET driver = 's3'",
        "UPDATE platform.storage_objects SET object_key = 'forbidden/object.pdf'",
        "UPDATE platform.storage_objects SET created_at = clock_timestamp()"
      ]) {
        await expectDenied(web, statement);
      }
      await expectDenied(web, "TRUNCATE platform.projects");
      await expectDenied(web, "CREATE TABLE platform.web_ddl_forbidden (id integer)");

      const worker = database.createPool("worker");
      await expect(worker.query("SELECT email_normalized FROM platform.users WHERE id = $1", [ids.user])).resolves.toMatchObject({
        rowCount: 1
      });
      await expectTransactionAllowed(worker, [
        ["UPDATE platform.outbox_events SET dispatched_at = clock_timestamp() WHERE id = $1", [ids.outbox]],
        [
          `UPDATE platform.jobs SET status = 'running', worker_id = 'worker-test',
             lease_token = '11890f1e-9b4a-4cc2-8f00-000000000001', lease_expires_at = clock_timestamp() + interval '1 minute',
             started_at = clock_timestamp(), updated_at = clock_timestamp(), attempt_count = attempt_count + 1
           WHERE id = $1`,
          [ids.job]
        ],
        ["UPDATE platform.storage_objects SET status = 'delete_pending', delete_requested_at = clock_timestamp() WHERE id = $1", [ids.storage]],
        [
          `INSERT INTO platform.worker_heartbeats (worker_id, started_at, heartbeat_at, metadata)
           VALUES ('worker-test', clock_timestamp(), clock_timestamp(), '{}'::jsonb)`
        ],
        [
          `INSERT INTO platform.audit_events
            (id, actor_type, action, target_type, target_id, request_id, result, metadata)
           VALUES ('01890f1e-9b4a-7cc2-8f00-00000000000b', 'worker', 'job.claim', 'job', $1,
             'request-worker', 'success', '{}'::jsonb)`,
          [ids.job]
        ]
      ]);
      for (const statement of [
        "INSERT INTO platform.users (id, email_normalized, display_name, password_hash, platform_role, status, mfa_status) VALUES ('01890f1e-9b4a-7cc2-8f00-00000000000c', 'worker@example.test', 'Worker', 'x', 'member', 'active', 'disabled')",
        "UPDATE platform.users SET password_hash = 'worker-forbidden'",
        "UPDATE platform.totp_credentials SET encrypted_secret = decode('00', 'hex')",
        "UPDATE platform.recovery_codes SET used_at = clock_timestamp()",
        "UPDATE platform.mfa_challenges SET completed_at = clock_timestamp()",
        "UPDATE platform.mfa_enrollments SET completed_at = clock_timestamp()",
        "UPDATE platform.sessions SET revoked_at = clock_timestamp()"
      ]) {
        await expectDenied(worker, statement);
      }
      await expectDenied(worker, "DELETE FROM platform.audit_events");
      await expectDenied(worker, "UPDATE platform.outbox_events SET payload = '{\"tampered\":true}'::jsonb");
      await expectDenied(worker, "UPDATE platform.jobs SET payload = '{\"tampered\":true}'::jsonb");
      await expectDenied(worker, "UPDATE platform.storage_objects SET object_key = 'tampered/object.pdf'");
      await expectDenied(worker, "CREATE TABLE platform.worker_ddl_forbidden (id integer)");

      const bootstrap = database.createPool("bootstrap");
      await expect(bootstrap.query("SELECT count(*) FROM platform.users")).resolves.toMatchObject({ rowCount: 1 });
      await expectTransactionAllowed(bootstrap, [
        [
          `INSERT INTO platform.users
            (id, email_normalized, display_name, password_hash, platform_role, status, mfa_status)
           VALUES ('01890f1e-9b4a-7cc2-8f00-00000000000d', 'admin@example.test', 'Bootstrap Admin',
             '$argon2id$bootstrap', 'admin', 'active', 'enabled')`
        ],
        [
          `INSERT INTO platform.totp_credentials
            (id, user_id, encrypted_secret, key_version, confirmed_at)
           VALUES ($1, '01890f1e-9b4a-7cc2-8f00-00000000000d', decode('0102', 'hex'), 1, clock_timestamp())`,
          [ids.totp]
        ],
        [
          `INSERT INTO platform.recovery_codes (id, user_id, code_hash, key_version)
           VALUES ($1, '01890f1e-9b4a-7cc2-8f00-00000000000d', decode(repeat('33', 32), 'hex'), 1)`,
          [ids.recoveryCode]
        ],
        [
          `INSERT INTO platform.audit_events
            (id, actor_type, action, target_type, target_id, request_id, result, metadata)
           VALUES ('01890f1e-9b4a-7cc2-8f00-00000000000e', 'bootstrap', 'admin.create', 'user',
             '01890f1e-9b4a-7cc2-8f00-00000000000d', 'request-bootstrap', 'success', '{}'::jsonb)`
        ]
      ]);
      for (const statement of [
        "UPDATE platform.users SET display_name = 'forbidden'",
        "DELETE FROM platform.users",
        "SELECT * FROM platform.sessions",
        "SELECT * FROM platform.jobs",
        "SELECT * FROM platform.outbox_events",
        "SELECT * FROM platform.storage_objects",
        "SELECT * FROM platform.projects",
        "CREATE TABLE platform.bootstrap_ddl_forbidden (id integer)"
      ]) {
        await expectDenied(bootstrap, statement);
      }

      for (const [role, pool] of [
        ["web", web],
        ["worker", worker]
      ] as const) {
        await expect(pool.query("SELECT version FROM platform.schema_migrations ORDER BY version")).resolves.toMatchObject({
          rowCount: 3
        });
        await expectDenied(
          pool,
          `INSERT INTO platform.schema_migrations (version, file_name, name, checksum)
           VALUES (99, '0099_forbidden.sql', 'forbidden', $1)`,
          ["f".repeat(64)]
        );
        expect(role).toMatch(/web|worker/);
      }
    });
  });
});
