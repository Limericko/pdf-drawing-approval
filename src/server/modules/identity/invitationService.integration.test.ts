import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { totpAt } from "../../platform/security/totp.ts";
import { deriveInvitationToken } from "../../platform/security/tokenHash.ts";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createInvitationService } from "./invitationService.ts";
import { PostgresInvitationRepository } from "./repositories/postgres/PostgresInvitationRepository.ts";
import { PostgresMfaRepository } from "./repositories/postgres/PostgresMfaRepository.ts";

let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let web: PlatformPool;
let concurrentA: PlatformPool;
let concurrentB: PlatformPool;
let deadlockA: PlatformPool;
let deadlockB: PlatformPool;
let admin: Pool;
const inviterId = "01890f1e-9b4a-7cc2-8f00-000000000061";
const projectId = "01890f1e-9b4a-7cc2-8f00-000000000062";
const stableRequestId = "invitation-service-integration-request";
const unauthorizedInviters = [
  { id: "01890f1e-9b4a-7cc2-8f00-000000000064", email: "admin-viewer@example.test", platformRole: "admin", userStatus: "active", projectRole: "viewer", memberStatus: "active" },
  { id: "01890f1e-9b4a-7cc2-8f00-000000000065", email: "member-manager@example.test", platformRole: "member", userStatus: "active", projectRole: "manager", memberStatus: "active" },
  { id: "01890f1e-9b4a-7cc2-8f00-000000000066", email: "disabled-admin@example.test", platformRole: "admin", userStatus: "disabled", projectRole: "manager", memberStatus: "active" },
  { id: "01890f1e-9b4a-7cc2-8f00-000000000067", email: "inactive-manager@example.test", platformRole: "admin", userStatus: "active", projectRole: "manager", memberStatus: "disabled" }
] as const;
const unauthorizedMembershipIds = [
  "01890f1e-9b4a-7cc2-8f00-000000000068",
  "01890f1e-9b4a-7cc2-8f00-000000000069",
  "01890f1e-9b4a-7cc2-8f00-00000000006a",
  "01890f1e-9b4a-7cc2-8f00-00000000006b"
] as const;
const capabilityMutations = [
  { label: "admin status", sql: "UPDATE platform.users SET status='disabled',updated_at=clock_timestamp() WHERE id=$1 AND $2::uuid IS NOT NULL",
    check: "SELECT status='disabled' AS changed FROM platform.users WHERE id=$1 AND $2::uuid IS NOT NULL" },
  { label: "admin platform role", sql: "UPDATE platform.users SET platform_role='member',updated_at=clock_timestamp() WHERE id=$1 AND $2::uuid IS NOT NULL",
    check: "SELECT platform_role='member' AS changed FROM platform.users WHERE id=$1 AND $2::uuid IS NOT NULL" },
  { label: "manager membership status", sql: "UPDATE platform.project_members SET status='disabled',updated_at=clock_timestamp() WHERE project_id=$2 AND user_id=$1",
    check: "SELECT status='disabled' AS changed FROM platform.project_members WHERE project_id=$2 AND user_id=$1" },
  { label: "manager membership role", sql: "UPDATE platform.project_members SET role='viewer',updated_at=clock_timestamp() WHERE project_id=$2 AND user_id=$1",
    check: "SELECT role='viewer' AS changed FROM platform.project_members WHERE project_id=$2 AND user_id=$1" },
  { label: "project status", sql: "UPDATE platform.projects SET status='archived',updated_at=clock_timestamp() WHERE id=$2 AND $1::uuid IS NOT NULL",
    check: "SELECT status='archived' AS changed FROM platform.projects WHERE id=$2 AND $1::uuid IS NOT NULL" }
] as const;
const totpSecret = Buffer.alloc(20, 7);
const keyrings = {
  invitationHmac: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 1)]]) },
  totpEncryption: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 2)]]) },
  recoveryHmac: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 3)]]) }
};

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  admin = new Pool({ connectionString: database.urls.admin, max: 1 });
  migration = database.createPool("migration");
  await runMigrations(migration);
  const config = { connectionString: database.urls.web, poolMax: 4, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 };
  web = createPlatformPool(config, "invitation-service-test");
  concurrentA = createPlatformPool({ ...config, poolMax: 1 }, "invitation-service-concurrent-a");
  concurrentB = createPlatformPool({ ...config, poolMax: 1 }, "invitation-service-concurrent-b");
  deadlockA = createPlatformPool({ ...config, poolMax: 1, lockTimeoutMs: 1_000 }, "invitation-deadlock-a");
  deadlockB = createPlatformPool({ ...config, poolMax: 1, lockTimeoutMs: 1_000 }, "invitation-deadlock-b");
});
afterAll(async () => { await deadlockB?.end(); await deadlockA?.end(); await concurrentB?.end(); await concurrentA?.end();
  await web?.end(); await admin?.end(); await database?.dispose(); });
beforeEach(async () => {
  await migration.query("TRUNCATE platform.users, platform.projects CASCADE");
  await migration.query("TRUNCATE platform.security_rate_limit_buckets");
  await migration.query(`INSERT INTO platform.users
    (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
    VALUES ($1,'admin@example.test','Admin','$argon2id$seed','admin','active','enabled')`, [inviterId]);
  await migration.query("INSERT INTO platform.projects (id,name,status) VALUES ($1,'Project','active')", [projectId]);
  await migration.query(`INSERT INTO platform.project_members (id,project_id,user_id,role,status)
    VALUES ('01890f1e-9b4a-7cc2-8f00-000000000063',$1,$2,'manager','active')`, [projectId, inviterId]);
});

describe("InvitationService", () => {
  it("creates a 24-hour invitation, audit and strict outbox event in one transaction", async () => {
    const service = makeService();
    const requestId = "invitation-create-http-request";

    const created = await service.createInvitation({ email: "Invitee@Example.Test", platformRole: "member",
      projectId, projectRole: "designer", invitedByUserId: inviterId, requestId });
    expect(created).toEqual({ invitationId: expect.stringMatching(/^.{36}$/) });
    const token = await deriveStoredInvitationToken(created.invitationId);
    expect(token).toMatch(new RegExp(`^${created.invitationId}\\.`));
    const row = await migration.query<{ token_hash: Buffer; created_at: Date; expires_at: Date }>(
      "SELECT token_hash,created_at,expires_at FROM platform.invitations WHERE id=$1", [created.invitationId]);
    expect(row.rows[0]!.expires_at.getTime() - row.rows[0]!.created_at.getTime()).toBe(86_400_000);
    expect(row.rows[0]!.token_hash.toString("utf8")).not.toContain(token);
    const outbox = await migration.query<{ payload: unknown }>("SELECT payload FROM platform.outbox_events");
    expect(outbox.rows).toEqual([{ payload: { invitationId: created.invitationId } }]);
    await expect(migration.query("SELECT action,request_id FROM platform.audit_events WHERE action='invitation.create'"))
      .resolves.toMatchObject({ rows: [{ action: "invitation.create", request_id: requestId }] });
  });

  it("requires an active platform admin with an active manager membership for every target role", async () => {
    await insertUnauthorizedInviters();
    const service = makeService();
    const projectRoles = ["manager", "designer", "supervisor", "process", "viewer"] as const;
    let attempt = 0;
    for (const inviter of unauthorizedInviters) {
      for (const platformRole of ["admin", "member"] as const) {
        for (const projectRole of projectRoles) {
          await expect(service.createInvitation({ email: `unauthorized-${attempt++}@example.test`, platformRole,
            projectId, projectRole, invitedByUserId: inviter.id }))
            .rejects.toMatchObject({ code: "INVITATION_INVALID" });
        }
      }
    }
    const inviterIds = unauthorizedInviters.map(({ id }) => id);
    await expect(migration.query(`SELECT
      (SELECT count(*) FROM platform.invitations WHERE invited_by_user_id=ANY($1::uuid[]))::int AS invitations,
      (SELECT count(*) FROM platform.outbox_events event WHERE event.payload->>'invitationId' IN
        (SELECT id::text FROM platform.invitations WHERE invited_by_user_id=ANY($1::uuid[])))::int AS outbox,
      (SELECT count(*) FROM platform.audit_events
        WHERE action='invitation.create' AND actor_user_id=ANY($1::uuid[]))::int AS audits`, [inviterIds]))
      .resolves.toMatchObject({ rows: [{ invitations: 0, outbox: 0, audits: 0 }] });
  });

  it.each(capabilityMutations)("holds the $label capability row lock until an authorized create commits", async (mutation) => {
    const blocker = await migration.connect();
    let blockerReleased = false;
    let creating: ReturnType<ReturnType<typeof makeService>["createInvitation"]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE platform.invitations IN ACCESS EXCLUSIVE MODE");
      creating = makeService({ pool: concurrentA }).createInvitation({ email: "capability-lock@example.test",
        platformRole: "member", projectId, projectRole: "viewer", invitedByUserId: inviterId });
      await waitForApplicationLock("invitation-service-concurrent-a");

      const mutationOutcome = await Promise.allSettled([withTransaction(concurrentB, async (tx) => {
        await tx.query("SELECT set_config('lock_timeout','100ms',true)");
        await tx.query(mutation.sql, [inviterId, projectId]);
      })]).then(([outcome]) => outcome!);
      await blocker.query("COMMIT");
      blockerReleased = true;
      const created = await creating;
      if (mutationOutcome.status === "rejected") {
        await withTransaction(concurrentB, (tx) => tx.query(mutation.sql, [inviterId, projectId]));
      }

      expect(mutationOutcome).toMatchObject({ status: "rejected", reason: { code: "55P03" } });
      await expect(migration.query<{ changed: boolean }>(mutation.check, [inviterId, projectId]))
        .resolves.toMatchObject({ rows: [{ changed: true }] });
      await expect(invitationCreationState(created.invitationId))
        .resolves.toEqual({ invitations: 1, audits: 1, outbox: 1 });
    } finally {
      if (!blockerReleased) await blocker.query("ROLLBACK");
      blocker.release();
      if (creating) await Promise.allSettled([creating]);
    }
  });

  it.each(capabilityMutations)("rejects create when the $label capability change commits first", async (mutation) => {
    const before = await platformCreationCounts();
    await withTransaction(concurrentB, (tx) => tx.query(mutation.sql, [inviterId, projectId]));
    await expect(makeService({ pool: concurrentA }).createInvitation({ email: "capability-changed@example.test",
      platformRole: "member", projectId, projectRole: "viewer", invitedByUserId: inviterId }))
      .rejects.toMatchObject({ code: "INVITATION_INVALID" });
    await expect(migration.query<{ changed: boolean }>(mutation.check, [inviterId, projectId]))
      .resolves.toMatchObject({ rows: [{ changed: true }] });
    await expect(platformCreationCounts()).resolves.toEqual(before);
  });

  it("revokes every prior active project invitation for the normalized email before reinviting", async () => {
    const service = makeService();
    const first = await createInvite(service, "reinvite@example.test");
    const enrollment = await service.prepare({ invitationToken: first.token, sourceIpPrefix: "198.20.0.0/24" });
    const second = await createInvite(service, "REINVITE@example.test");

    await expect(migration.query(`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp())::int AS active,
      count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked
      FROM platform.invitations WHERE project_id=$1 AND email_normalized='reinvite@example.test'`, [projectId]))
      .resolves.toMatchObject({ rows: [{ total: 2, active: 1, revoked: 1 }] });
    expect(second.invitationId).not.toBe(first.invitationId);
    await expect(service.prepare({ invitationToken: first.token, sourceIpPrefix: "198.20.1.0/24" }))
      .rejects.toMatchObject({ code: "INVITATION_INVALID" });
    await expect(service.complete({ enrollmentToken: enrollment.enrollmentToken, sourceIpPrefix: "198.20.2.0/24",
      password: "correct horse battery staple", totp: totpAt(totpSecret, Date.now()) }))
      .rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });

  it("serializes concurrent reinvitations so only one remains active", async () => {
    const serviceA = makeService({ pool: concurrentA });
    const serviceB = makeService({ pool: concurrentB });
    const [first, second] = await Promise.all([
      createInvite(serviceA, "concurrent-reinvite@example.test"),
      createInvite(serviceB, "CONCURRENT-REINVITE@example.test")
    ]);

    const rows = await migration.query<{ id: string; revoked_at: Date | null }>(`SELECT id,revoked_at
      FROM platform.invitations WHERE project_id=$1 AND email_normalized='concurrent-reinvite@example.test'
      ORDER BY created_at,id`, [projectId]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.filter(({ revoked_at }) => revoked_at === null)).toHaveLength(1);
    const activeId = rows.rows.find(({ revoked_at }) => revoked_at === null)!.id;
    const superseded = first.invitationId === activeId ? second : first;
    await expect(makeService().prepare({ invitationToken: superseded.token, sourceIpPrefix: "198.21.0.0/24" }))
      .rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });

  it("avoids deadlock when complete locks the invitation before reinvite reaches it", async () => {
    const email = "complete-first-race@example.test";
    const setup = makeService();
    const original = await createInvite(setup, email);
    const enrollment = await setup.prepare({ invitationToken: original.token, sourceIpPrefix: "198.22.0.0/24" });
    await migration.query(`CREATE FUNCTION platform.block_complete_user_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.email_normalized='complete-first-race@example.test' THEN PERFORM pg_advisory_xact_lock(16001); END IF;
        RETURN NEW;
      END $$`);
    await migration.query(`CREATE TRIGGER block_complete_user_insert BEFORE INSERT ON platform.users
      FOR EACH ROW EXECUTE FUNCTION platform.block_complete_user_insert()`);
    const blocker = await migration.connect();
    let advisoryReleased = false;
    let completing: ReturnType<ReturnType<typeof makeService>["complete"]> | undefined;
    let reinviting: ReturnType<ReturnType<typeof makeService>["createInvitation"]> | undefined;
    try {
      await blocker.query("SELECT pg_advisory_lock(16001)");
      completing = makeService({ pool: deadlockA }).complete({ enrollmentToken: enrollment.enrollmentToken,
        sourceIpPrefix: "198.22.1.0/24", password: "correct horse battery staple",
        totp: totpAt(totpSecret, Date.now()) });
      await waitForApplicationLock("invitation-deadlock-a");
      reinviting = makeService({ pool: deadlockB }).createInvitation({ email: email.toUpperCase(), platformRole: "member",
        projectId, projectRole: "viewer", invitedByUserId: inviterId });
      await waitForApplicationLock("invitation-deadlock-b");
      await blocker.query("SELECT pg_advisory_unlock(16001)");
      advisoryReleased = true;

      const [completeOutcome, reinviteOutcome] = await Promise.allSettled([completing, reinviting]);
      expect(completeOutcome.status).toBe("fulfilled");
      expect(reinviteOutcome.status).toBe("fulfilled");
      if (reinviteOutcome.status !== "fulfilled") throw reinviteOutcome.reason;
      await expect(invitationRaceState(original.invitationId, reinviteOutcome.value.invitationId, email))
        .resolves.toEqual({ oldAccepted: 1, oldRevoked: 0, newActive: 1, users: 1,
          createAudits: 2, acceptAudits: 1, outbox: 2 });
    } finally {
      if (!advisoryReleased) await blocker.query("SELECT pg_advisory_unlock(16001)");
      blocker.release();
      await Promise.allSettled([...(completing ? [completing] : []), ...(reinviting ? [reinviting] : [])]);
      await migration.query("DROP TRIGGER block_complete_user_insert ON platform.users");
      await migration.query("DROP FUNCTION platform.block_complete_user_insert()");
    }
  });

  it("avoids deadlock when reinvite revokes the invitation before complete reaches it", async () => {
    const email = "reinvite-first-race@example.test";
    const setup = makeService();
    const original = await createInvite(setup, email);
    const enrollment = await setup.prepare({ invitationToken: original.token, sourceIpPrefix: "198.23.0.0/24" });
    await migration.query(`CREATE FUNCTION platform.block_reinvite_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.email_normalized='reinvite-first-race@example.test' THEN PERFORM pg_advisory_xact_lock(16002); END IF;
        RETURN NEW;
      END $$`);
    await migration.query(`CREATE TRIGGER block_reinvite_insert BEFORE INSERT ON platform.invitations
      FOR EACH ROW EXECUTE FUNCTION platform.block_reinvite_insert()`);
    const blocker = await migration.connect();
    let advisoryReleased = false;
    let reinviting: ReturnType<ReturnType<typeof makeService>["createInvitation"]> | undefined;
    let completing: ReturnType<ReturnType<typeof makeService>["complete"]> | undefined;
    try {
      await blocker.query("SELECT pg_advisory_lock(16002)");
      reinviting = makeService({ pool: deadlockA }).createInvitation({ email: email.toUpperCase(), platformRole: "member",
        projectId, projectRole: "viewer", invitedByUserId: inviterId });
      await waitForApplicationLock("invitation-deadlock-a");
      completing = makeService({ pool: deadlockB }).complete({ enrollmentToken: enrollment.enrollmentToken,
        sourceIpPrefix: "198.23.1.0/24", password: "correct horse battery staple",
        totp: totpAt(totpSecret, Date.now()) });
      await waitForApplicationLock("invitation-deadlock-b");
      await blocker.query("SELECT pg_advisory_unlock(16002)");
      advisoryReleased = true;

      const [reinviteOutcome, completeOutcome] = await Promise.allSettled([reinviting, completing]);
      expect(reinviteOutcome.status).toBe("fulfilled");
      expect(completeOutcome).toMatchObject({ status: "rejected",
        reason: { code: "INVITATION_INVALID" } });
      if (reinviteOutcome.status !== "fulfilled") throw reinviteOutcome.reason;
      await expect(invitationRaceState(original.invitationId, reinviteOutcome.value.invitationId, email))
        .resolves.toEqual({ oldAccepted: 0, oldRevoked: 1, newActive: 1, users: 0,
          createAudits: 2, acceptAudits: 0, outbox: 2 });
    } finally {
      if (!advisoryReleased) await blocker.query("SELECT pg_advisory_unlock(16002)");
      blocker.release();
      await Promise.allSettled([...(reinviting ? [reinviting] : []), ...(completing ? [completing] : [])]);
      await migration.query("DROP TRIGGER block_reinvite_insert ON platform.invitations");
      await migration.query("DROP FUNCTION platform.block_reinvite_insert()");
    }
  });

  it("prepares without creating a user, then atomically activates MFA membership and ten recovery hashes", async () => {
    const service = makeService();
    const created = await createInvite(service, "new.user@example.test");
    const prepared = await service.prepare({ invitationToken: created.token, sourceIpPrefix: "203.0.113.0/24" });
    expect(prepared.otpauthUri).toContain("otpauth://totp/");
    await expect(migration.query("SELECT count(*)::int AS count FROM platform.users"))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(migration.query("SELECT count(*)::int AS count FROM platform.mfa_enrollments"))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });

    const requestId = "invitation-complete-http-request";
    const completed = await service.complete({ enrollmentToken: prepared.enrollmentToken,
      sourceIpPrefix: "203.0.113.0/24", password: "correct horse battery staple",
      totp: totpAt(totpSecret, Date.now()), requestId });
    expect(completed.recoveryCodes).toHaveLength(10);
    await expect(migration.query(`SELECT
      (SELECT count(*) FROM platform.users)::int AS users,
      (SELECT count(*) FROM platform.totp_credentials)::int AS credentials,
      (SELECT count(*) FROM platform.recovery_codes)::int AS recovery,
      (SELECT count(*) FROM platform.project_members)::int AS members,
      (SELECT count(*) FROM platform.invitations WHERE accepted_at IS NOT NULL)::int AS accepted`))
      .resolves.toMatchObject({ rows: [{ users: 2, credentials: 1, recovery: 10, members: 2, accepted: 1 }] });
    await expect(migration.query("SELECT request_id FROM platform.audit_events WHERE action='invitation.accept'"))
      .resolves.toMatchObject({ rows: [{ request_id: requestId }] });
    await expect(service.complete({ enrollmentToken: prepared.enrollmentToken,
      sourceIpPrefix: "203.0.113.0/24", password: "correct horse battery staple",
      totp: totpAt(totpSecret, Date.now()) })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });

  it("does not let nine prepare attempts block the first complete for the same invitation and IP", async () => {
    const created = await createInvite(makeService(), "operation-domain@example.test");
    let prepared: Awaited<ReturnType<ReturnType<typeof makeService>["prepare"]>> | undefined;
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const service = attempt % 2 === 0 ? makeService({ pool: concurrentA }) : makeService({ pool: concurrentB });
      prepared = await service.prepare({ invitationToken: created.token, sourceIpPrefix: "203.0.120.0/24" });
    }
    expect(prepared).toBeDefined();
    await expect(makeService({ pool: concurrentB }).complete({ enrollmentToken: prepared!.enrollmentToken,
      sourceIpPrefix: "203.0.120.0/24", password: "correct horse battery staple",
      totp: totpAt(totpSecret, Date.now()) })).resolves.toMatchObject({ recoveryCodes: expect.any(Array) });
  });

  it("blocks the tenth malformed prepare by shared IP before reading the token or querying invitations", async () => {
    const lookup = vi.spyOn(PostgresInvitationRepository.prototype, "findActiveById");
    try {
      for (let attempt = 0; attempt < 9; attempt += 1) {
        const service = attempt % 2 === 0 ? makeService({ pool: concurrentA }) : makeService({ pool: concurrentB });
        await expect(service.prepare({ invitationToken: "malformed", sourceIpPrefix: "203.0.121.0/24" }))
          .rejects.toMatchObject({ code: "INVITATION_INVALID" });
      }
      const blockedInput = { sourceIpPrefix: "203.0.121.0/24",
        get invitationToken(): string { throw new Error("PREPARE_TOKEN_MUST_NOT_BE_READ"); } };
      await expect(makeService({ pool: concurrentB }).prepare(blockedInput))
        .rejects.toMatchObject({ code: "INVITATION_RATE_LIMITED" });
      expect(lookup).not.toHaveBeenCalled();
      await expect(rateLimitBucketCounts()).resolves.toEqual([{ bucketType: "ip-prefix", attemptCount: 10 }]);
    } finally {
      lookup.mockRestore();
    }
  });

  it("blocks the tenth unknown complete by shared IP before reading the enrollment token or doing expensive work", async () => {
    const lookup = vi.spyOn(PostgresMfaRepository.prototype, "findActiveEnrollmentByTokenHash");
    const passwordHasher = vi.fn(async () => "$argon2id$must-not-run");
    try {
      for (let attempt = 0; attempt < 9; attempt += 1) {
        const service = makeService({ pool: attempt % 2 === 0 ? concurrentA : concurrentB,
          hashPassword: passwordHasher as never });
        await expect(service.complete({ enrollmentToken: `unknown-${attempt}`,
          sourceIpPrefix: "203.0.122.0/24", password: "correct horse battery staple", totp: "000000" }))
          .rejects.toMatchObject({ code: "INVITATION_INVALID" });
      }
      const blockedInput = { sourceIpPrefix: "203.0.122.0/24",
        get enrollmentToken(): string { throw new Error("COMPLETE_TOKEN_MUST_NOT_BE_READ"); },
        get password(): string { throw new Error("PASSWORD_MUST_NOT_BE_READ"); },
        get totp(): string { throw new Error("TOTP_MUST_NOT_BE_READ"); } };
      await expect(makeService({ pool: concurrentB, hashPassword: passwordHasher as never }).complete(blockedInput))
        .rejects.toMatchObject({ code: "INVITATION_RATE_LIMITED" });
      expect(lookup).toHaveBeenCalledTimes(9);
      expect(passwordHasher).not.toHaveBeenCalled();
      await expect(rateLimitBucketCounts()).resolves.toEqual([{ bucketType: "ip-prefix", attemptCount: 10 }]);
    } finally {
      lookup.mockRestore();
    }
  });

  it("stores distinct prepare and complete IP and account bucket keys across independent pools", async () => {
    const created = await createInvite(makeService(), "bucket-domains@example.test");
    const prepared = await makeService({ pool: concurrentA }).prepare({ invitationToken: created.token,
      sourceIpPrefix: "203.0.123.0/24" });
    await makeService({ pool: concurrentB }).complete({ enrollmentToken: prepared.enrollmentToken,
      sourceIpPrefix: "203.0.123.0/24", password: "correct horse battery staple",
      totp: totpAt(totpSecret, Date.now()) });

    const buckets = await migration.query<{ bucket_type: string; key_hex: string }>(`SELECT bucket_type,
      encode(bucket_key,'hex') AS key_hex FROM platform.security_rate_limit_buckets ORDER BY bucket_type,key_hex`);
    expect(buckets.rows).toHaveLength(4);
    expect(new Set(buckets.rows.map(({ key_hex }) => key_hex)).size).toBe(4);
    expect(buckets.rows.filter(({ bucket_type }) => bucket_type === "ip-prefix")).toHaveLength(2);
    expect(buckets.rows.filter(({ bucket_type }) => bucket_type === "account")).toHaveLength(2);
  });

  it("shares prepare and complete account limits across independent pools", async () => {
    const created = await createInvite(makeService(), "shared-account@example.test");
    const secretGenerator = vi.fn(() => Buffer.from(totpSecret));
    let prepared: Awaited<ReturnType<ReturnType<typeof makeService>["prepare"]>> | undefined;
    for (let attempt = 0; attempt < 9; attempt += 1) {
      prepared = await makeService({ pool: attempt % 2 === 0 ? concurrentA : concurrentB,
        generateTotpSecret: secretGenerator }).prepare({ invitationToken: created.token,
        sourceIpPrefix: `203.1.${attempt}.0/24` });
    }
    await expect(makeService({ pool: concurrentB, generateTotpSecret: secretGenerator }).prepare({
      invitationToken: created.token, sourceIpPrefix: "203.1.10.0/24"
    })).rejects.toMatchObject({ code: "INVITATION_RATE_LIMITED" });
    expect(secretGenerator).toHaveBeenCalledTimes(9);

    const passwordHasher = vi.fn(async () => "$argon2id$test");
    const totpVerifier = vi.fn(() => false);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await expect(makeService({ pool: attempt % 2 === 0 ? concurrentA : concurrentB,
        hashPassword: passwordHasher as never, verifyTotp: totpVerifier }).complete({
        enrollmentToken: prepared!.enrollmentToken, sourceIpPrefix: `203.2.${attempt}.0/24`,
        password: "correct horse battery staple", totp: "000000"
      })).rejects.toMatchObject({ code: "INVITATION_TOTP_INVALID" });
      await migration.query("UPDATE platform.mfa_enrollments SET attempt_count=0 WHERE invitation_id=$1", [created.invitationId]);
    }
    const blockedComplete = { enrollmentToken: prepared!.enrollmentToken, sourceIpPrefix: "203.2.10.0/24",
      get password(): string { throw new Error("PASSWORD_MUST_NOT_BE_READ"); }, totp: "000000" };
    await expect(makeService({ pool: concurrentB, hashPassword: passwordHasher as never,
      verifyTotp: totpVerifier }).complete(blockedComplete))
      .rejects.toMatchObject({ code: "INVITATION_RATE_LIMITED" });
    expect(passwordHasher).toHaveBeenCalledTimes(9);
    expect(totpVerifier).toHaveBeenCalledTimes(9);
  });

  it("validates each operation IP before reading tokens or querying repositories", async () => {
    const invitationLookup = vi.spyOn(PostgresInvitationRepository.prototype, "findActiveById");
    const enrollmentLookup = vi.spyOn(PostgresMfaRepository.prototype, "findActiveEnrollmentByTokenHash");
    try {
      await expect(makeService().prepare({ sourceIpPrefix: "invalid\n",
        get invitationToken(): string { throw new Error("PREPARE_TOKEN_MUST_NOT_BE_READ"); } }))
        .rejects.toMatchObject({ code: "INVITATION_INVALID" });
      await expect(makeService().complete({ sourceIpPrefix: "invalid\0",
        get enrollmentToken(): string { throw new Error("COMPLETE_TOKEN_MUST_NOT_BE_READ"); },
        get password(): string { throw new Error("PASSWORD_MUST_NOT_BE_READ"); },
        get totp(): string { throw new Error("TOTP_MUST_NOT_BE_READ"); } }))
        .rejects.toMatchObject({ code: "INVITATION_INVALID" });
      expect(invitationLookup).not.toHaveBeenCalled();
      expect(enrollmentLookup).not.toHaveBeenCalled();
      await expect(rateLimitBucketCounts()).resolves.toEqual([]);
    } finally {
      invitationLookup.mockRestore();
      enrollmentLookup.mockRestore();
    }
  });

  it("checks shared rate limits before generating TOTP material or hashing a password", async () => {
    const secretGenerator = vi.fn(() => Buffer.from(totpSecret));
    const passwordHasher = vi.fn(async () => { throw new Error("ARGON2_MUST_NOT_RUN"); });
    const service = makeService({ generateTotpSecret: secretGenerator, hashPassword: passwordHasher as never });
    const created = await createInvite(service, "blocked@example.test");
    const stored = await migration.query<{ token_hash: Buffer }>("SELECT token_hash FROM platform.invitations WHERE id=$1", [created.invitationId]);
    await blockOperationAccount("invitation.prepare", stored.rows[0]!.token_hash);
    await expect(service.prepare({ invitationToken: created.token, sourceIpPrefix: "198.51.100.0/24" }))
      .rejects.toMatchObject({ code: "INVITATION_RATE_LIMITED" });
    expect(secretGenerator).not.toHaveBeenCalled();

    await migration.query("TRUNCATE platform.security_rate_limit_buckets");
    const prepared = await makeService().prepare({ invitationToken: created.token, sourceIpPrefix: "198.51.100.0/24" });
    await blockOperationAccount("invitation.complete", stored.rows[0]!.token_hash);
    await expect(service.complete({ enrollmentToken: prepared.enrollmentToken, sourceIpPrefix: "198.51.100.0/24",
      password: "correct horse battery staple", totp: "000000" }))
      .rejects.toMatchObject({ code: "INVITATION_RATE_LIMITED" });
    expect(passwordHasher).not.toHaveBeenCalled();
  });

  it("clears the decrypted TOTP secret when recovery-code preparation fails", async () => {
    let decryptedSecret: Buffer | undefined;
    const service = makeService({
      verifyTotp: (secret: Buffer) => {
        decryptedSecret = secret;
        return true;
      },
      generateRecoveryCodes: () => []
    });
    const created = await createInvite(service, "secret-cleanup@example.test");
    const prepared = await service.prepare({ invitationToken: created.token, sourceIpPrefix: "198.19.0.0/24" });

    await expect(service.complete({ enrollmentToken: prepared.enrollmentToken,
      sourceIpPrefix: "198.19.0.0/24", password: "correct horse battery staple", totp: "123456" }))
      .rejects.toMatchObject({ code: "INVITATION_INVALID" });
    expect(decryptedSecret).toBeDefined();
    expect(decryptedSecret).toEqual(Buffer.alloc(totpSecret.length));
  });

  it("records a failed TOTP attempt against the enrollment", async () => {
    const service = makeService({ verifyTotp: () => false });
    const created = await createInvite(service, "totp-attempt@example.test");
    const prepared = await service.prepare({ invitationToken: created.token, sourceIpPrefix: "198.19.1.0/24" });

    await expect(service.complete({ enrollmentToken: prepared.enrollmentToken,
      sourceIpPrefix: "198.19.1.0/24", password: "correct horse battery staple", totp: "000000" }))
      .rejects.toMatchObject({ code: "INVITATION_TOTP_INVALID" });
    await expect(migration.query("SELECT attempt_count FROM platform.mfa_enrollments"))
      .resolves.toMatchObject({ rows: [{ attempt_count: 1 }] });
  });

  it("invalidates the prior enrollment when prepare is repeated", async () => {
    const service = makeService();
    const created = await createInvite(service, "repeat@example.test");
    const first = await service.prepare({ invitationToken: created.token, sourceIpPrefix: "192.0.2.0/24" });
    const second = await service.prepare({ invitationToken: created.token, sourceIpPrefix: "192.0.2.0/24" });
    expect(second.enrollmentToken).not.toBe(first.enrollmentToken);
    await expect(migration.query(`SELECT
      count(*) FILTER (WHERE invalidated_at IS NOT NULL)::int AS invalidated,
      count(*) FILTER (WHERE invalidated_at IS NULL AND completed_at IS NULL)::int AS active
      FROM platform.mfa_enrollments`)).resolves.toMatchObject({ rows: [{ invalidated: 1, active: 1 }] });
    await expect(service.complete({ enrollmentToken: first.enrollmentToken, sourceIpPrefix: "192.0.2.0/24",
      password: "correct horse battery staple", totp: totpAt(totpSecret, Date.now()) }))
      .rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });

  it("rejects tampered tokens, unknown key versions, stored hash mismatch, expiry and revocation", async () => {
    const cases = ["tampered", "unknown-key", "hash-mismatch", "expired", "revoked"] as const;
    for (const [index, kind] of cases.entries()) {
      const service = makeService();
      const created = await createInvite(service, `${kind}@example.test`);
      let token = created.token;
      if (kind === "tampered") token = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
      if (kind === "unknown-key") await migration.query("UPDATE platform.invitations SET token_key_version='missing' WHERE id=$1", [created.invitationId]);
      if (kind === "hash-mismatch") await migration.query("UPDATE platform.invitations SET token_hash=$2 WHERE id=$1", [created.invitationId, Buffer.alloc(32, 9)]);
      if (kind === "expired") await migration.query(`UPDATE platform.invitations
        SET created_at=clock_timestamp()-interval '2 days', expires_at=clock_timestamp()-interval '1 day' WHERE id=$1`, [created.invitationId]);
      if (kind === "revoked") await migration.query("UPDATE platform.invitations SET revoked_at=clock_timestamp() WHERE id=$1", [created.invitationId]);
      await expect(service.prepare({ invitationToken: token, sourceIpPrefix: `198.18.${index}.0/24` }))
        .rejects.toMatchObject({ code: "INVITATION_INVALID" });
    }
  });

  it("rejects completion when a prepared invitation is later revoked or expires", async () => {
    for (const [index, kind] of (["revoked", "expired"] as const).entries()) {
      const service = makeService();
      const created = await createInvite(service, `post-prepare-${kind}@example.test`);
      const prepared = await service.prepare({ invitationToken: created.token, sourceIpPrefix: `100.62.${index}.0/24` });
      if (kind === "revoked") {
        await migration.query("UPDATE platform.invitations SET revoked_at=clock_timestamp() WHERE id=$1", [created.invitationId]);
      } else {
        await migration.query(`UPDATE platform.invitations
          SET created_at=clock_timestamp()-interval '2 days', expires_at=clock_timestamp()-interval '1 day' WHERE id=$1`,
        [created.invitationId]);
      }
      await expect(service.complete({ enrollmentToken: prepared.enrollmentToken, sourceIpPrefix: `100.63.${index}.0/24`,
        password: "correct horse battery staple", totp: totpAt(totpSecret, Date.now()) }))
        .rejects.toMatchObject({ code: "INVITATION_INVALID" });
      await expect(activationState(created.invitationId, `post-prepare-${kind}@example.test`))
        .resolves.toEqual({ users: 0, credentials: 0, recovery: 0, members: 0,
          enrollmentCompleted: 0, invitationAccepted: 0, successAudits: 0 });
    }
  });

  it("allows one completion across independent connections and commits exactly one full activation", async () => {
    const setup = makeService();
    const concurrent = await createInvite(setup, "concurrent@example.test");
    const prepared = await setup.prepare({ invitationToken: concurrent.token, sourceIpPrefix: "100.64.0.0/24" });
    const input = { enrollmentToken: prepared.enrollmentToken, sourceIpPrefix: "100.64.0.0/24",
      password: "correct horse battery staple", totp: totpAt(totpSecret, Date.now()) };
    const outcomes = await Promise.allSettled([
      makeService({ pool: concurrentA }).complete(input),
      makeService({ pool: concurrentB }).complete(input)
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "INVITATION_INVALID" }) })
    ]);
    await expect(activationState(concurrent.invitationId, "concurrent@example.test"))
      .resolves.toEqual({ users: 1, credentials: 1, recovery: 10, members: 1,
        enrollmentCompleted: 1, invitationAccepted: 1, successAudits: 1 });
  });

  it("rolls back every activation row when member or final audit insertion fails", async () => {
    const failures = [
      { kind: "member", table: "platform.project_members", when: "",
        message: "synthetic invitation member failure" },
      { kind: "audit", table: "platform.audit_events", when: "WHEN (NEW.action='invitation.accept')",
        message: "synthetic invitation audit failure" }
    ] as const;
    for (const [index, failure] of failures.entries()) {
      const functionName = `reject_invitation_${failure.kind}`;
      await migration.query(`CREATE FUNCTION platform.${functionName}() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${failure.message}'; END $$`);
      await migration.query(`CREATE TRIGGER ${functionName} BEFORE INSERT ON ${failure.table}
        FOR EACH ROW ${failure.when} EXECUTE FUNCTION platform.${functionName}()`);
      try {
        const service = makeService();
        const email = `rollback-${failure.kind}@example.test`;
        const failing = await createInvite(service, email);
        const enrollment = await service.prepare({ invitationToken: failing.token, sourceIpPrefix: `100.65.${index}.0/24` });
        await expect(service.complete({ enrollmentToken: enrollment.enrollmentToken,
          sourceIpPrefix: `100.66.${index}.0/24`, password: "correct horse battery staple",
          totp: totpAt(totpSecret, Date.now()) })).rejects.toThrow(failure.message);
        await expect(activationState(failing.invitationId, email))
          .resolves.toEqual({ users: 0, credentials: 0, recovery: 0, members: 0,
            enrollmentCompleted: 0, invitationAccepted: 0, successAudits: 0 });
      } finally {
        await migration.query(`DROP TRIGGER ${functionName} ON ${failure.table}`);
        await migration.query(`DROP FUNCTION platform.${functionName}()`);
      }
    }
  });
});

function makeService(overrides: Record<string, unknown> = {}) {
  const service = createInvitationService({ pool: web, keyrings,
    passwordHashOptions: { memoryCost: 8192, timeCost: 1, parallelism: 1, outputLen: 32 },
    generateTotpSecret: () => Buffer.from(totpSecret),
    generateRecoveryCodes: () => Array.from({ length: 10 }, (_, i) =>
      i.toString(16).padStart(32, "0").match(/.{4}/g)!.join("-")),
    ...overrides });
  type CreateInput = Parameters<typeof service.createInvitation>[0];
  type CompleteInput = Parameters<typeof service.complete>[0];
  return Object.freeze({
    ...service,
    createInvitation(input: Omit<CreateInput, "requestId"> & { readonly requestId?: string }) {
      return service.createInvitation({ ...input, requestId: input.requestId ?? stableRequestId });
    },
    complete(input: Omit<CompleteInput, "requestId"> & { readonly requestId?: string }) {
      return service.complete(withRequestId(input, input.requestId ?? stableRequestId));
    }
  });
}

function withRequestId<T extends object>(input: T, requestId: string): T & { readonly requestId: string } {
  return Object.defineProperty(Object.create(input), "requestId", {
    value: requestId, enumerable: true, configurable: false, writable: false
  }) as T & { readonly requestId: string };
}

async function blockOperationAccount(operation: "invitation.prepare" | "invitation.complete", tokenHash: Buffer) {
  const bucketKey = createHash("sha256").update(`${operation}.account\0`).update(tokenHash).digest();
  await migration.query(`INSERT INTO platform.security_rate_limit_buckets
    (bucket_type,bucket_key,window_started_at,attempt_count,blocked_until,updated_at)
    VALUES ('account',$1,clock_timestamp(),10,clock_timestamp()+interval '15 minutes',clock_timestamp())
    ON CONFLICT (bucket_type,bucket_key) DO UPDATE SET attempt_count=10,
      blocked_until=clock_timestamp()+interval '15 minutes',updated_at=clock_timestamp()`, [bucketKey]);
}

async function rateLimitBucketCounts() {
  const result = await migration.query<{ bucket_type: string; attempt_count: number }>(`SELECT bucket_type,attempt_count
    FROM platform.security_rate_limit_buckets ORDER BY bucket_type,bucket_key`);
  return result.rows.map(({ bucket_type, attempt_count }) => ({ bucketType: bucket_type, attemptCount: attempt_count }));
}

async function createInvite(service: ReturnType<typeof makeService>, email: string) {
  const created = await service.createInvitation({ email, platformRole: "member", projectId,
    projectRole: "designer", invitedByUserId: inviterId });
  return { ...created, token: await deriveStoredInvitationToken(created.invitationId) };
}

async function deriveStoredInvitationToken(invitationId: string) {
  const result = await migration.query<{ token_key_version: string }>(
    "SELECT token_key_version FROM platform.invitations WHERE id=$1", [invitationId]
  );
  return deriveInvitationToken(invitationId, result.rows[0]!.token_key_version, keyrings.invitationHmac);
}

async function activationState(invitationId: string, email: string) {
  const result = await migration.query<{
    users: number; credentials: number; recovery: number; members: number;
    enrollment_completed: number; invitation_accepted: number; success_audits: number;
  }>(`WITH target_user AS (
      SELECT id FROM platform.users WHERE email_normalized=$2
    ) SELECT
      (SELECT count(*) FROM target_user)::int AS users,
      (SELECT count(*) FROM platform.totp_credentials WHERE user_id IN (SELECT id FROM target_user))::int AS credentials,
      (SELECT count(*) FROM platform.recovery_codes WHERE user_id IN (SELECT id FROM target_user))::int AS recovery,
      (SELECT count(*) FROM platform.project_members WHERE user_id IN (SELECT id FROM target_user))::int AS members,
      (SELECT count(*) FROM platform.mfa_enrollments WHERE invitation_id=$1 AND completed_at IS NOT NULL)::int AS enrollment_completed,
      (SELECT count(*) FROM platform.invitations WHERE id=$1 AND accepted_at IS NOT NULL)::int AS invitation_accepted,
      (SELECT count(*) FROM platform.audit_events
        WHERE action='invitation.accept' AND target_id=$1 AND result='success')::int AS success_audits`,
  [invitationId, email]);
  const row = result.rows[0]!;
  return { users: row.users, credentials: row.credentials, recovery: row.recovery, members: row.members,
    enrollmentCompleted: row.enrollment_completed, invitationAccepted: row.invitation_accepted,
    successAudits: row.success_audits };
}

async function invitationCreationState(invitationId: string) {
  const result = await migration.query<{ invitations: number; audits: number; outbox: number }>(`SELECT
    (SELECT count(*) FROM platform.invitations WHERE id=$1)::int AS invitations,
    (SELECT count(*) FROM platform.audit_events
      WHERE action='invitation.create' AND target_id=$1 AND result='success')::int AS audits,
    (SELECT count(*) FROM platform.outbox_events WHERE payload=$2::jsonb)::int AS outbox`,
  [invitationId, JSON.stringify({ invitationId })]);
  return result.rows[0]!;
}

async function invitationRaceState(oldInvitationId: string, newInvitationId: string, email: string) {
  const result = await migration.query<{
    old_accepted: number; old_revoked: number; new_active: number; users: number;
    create_audits: number; accept_audits: number; outbox: number;
  }>(`SELECT
    (SELECT count(*) FROM platform.invitations WHERE id=$1 AND accepted_at IS NOT NULL)::int AS old_accepted,
    (SELECT count(*) FROM platform.invitations WHERE id=$1 AND revoked_at IS NOT NULL)::int AS old_revoked,
    (SELECT count(*) FROM platform.invitations
      WHERE id=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp())::int AS new_active,
    (SELECT count(*) FROM platform.users WHERE email_normalized=$3)::int AS users,
    (SELECT count(*) FROM platform.audit_events
      WHERE action='invitation.create' AND target_id IN ($1,$2) AND result='success')::int AS create_audits,
    (SELECT count(*) FROM platform.audit_events
      WHERE action='invitation.accept' AND target_id=$1 AND result='success')::int AS accept_audits,
    (SELECT count(*) FROM platform.outbox_events
      WHERE payload->>'invitationId' IN ($1::text,$2::text))::int AS outbox`,
  [oldInvitationId, newInvitationId, email]);
  const row = result.rows[0]!;
  return { oldAccepted: row.old_accepted, oldRevoked: row.old_revoked, newActive: row.new_active,
    users: row.users, createAudits: row.create_audits, acceptAudits: row.accept_audits, outbox: row.outbox };
}

async function platformCreationCounts() {
  const result = await migration.query<{ invitations: number; audits: number; outbox: number }>(`SELECT
    (SELECT count(*) FROM platform.invitations)::int AS invitations,
    (SELECT count(*) FROM platform.audit_events WHERE action='invitation.create')::int AS audits,
    (SELECT count(*) FROM platform.outbox_events WHERE event_type='invitation.created')::int AS outbox`);
  return result.rows[0]!;
}

async function waitForApplicationLock(applicationName: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const activity = await admin.query<{ waiting: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'
    ) AS waiting`, [applicationName]);
    if (activity.rows[0]?.waiting) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`APPLICATION_DID_NOT_WAIT_FOR_LOCK:${applicationName}`);
}

async function insertUnauthorizedInviters() {
  for (const [index, inviter] of unauthorizedInviters.entries()) {
    await migration.query(`INSERT INTO platform.users
      (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
      VALUES ($1,$2,'Unauthorized inviter','$argon2id$seed',$3,$4,'enabled')`,
    [inviter.id, inviter.email, inviter.platformRole, inviter.userStatus]);
    await migration.query(`INSERT INTO platform.project_members (id,project_id,user_id,role,status)
      VALUES ($1,$2,$3,$4,$5)`,
    [unauthorizedMembershipIds[index], projectId, inviter.id, inviter.projectRole, inviter.memberStatus]);
  }
}
