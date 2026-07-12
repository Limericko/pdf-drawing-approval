import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { totpAt } from "../../platform/security/totp.ts";
import { deriveInvitationToken } from "../../platform/security/tokenHash.ts";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createInvitationService } from "./invitationService.ts";

let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let web: PlatformPool;
let concurrentA: PlatformPool;
let concurrentB: PlatformPool;
const inviterId = "01890f1e-9b4a-7cc2-8f00-000000000061";
const projectId = "01890f1e-9b4a-7cc2-8f00-000000000062";
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
const totpSecret = Buffer.alloc(20, 7);
const keyrings = {
  invitationHmac: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 1)]]) },
  totpEncryption: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 2)]]) },
  recoveryHmac: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 3)]]) }
};

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  const config = { connectionString: database.urls.web, poolMax: 4, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 };
  web = createPlatformPool(config, "invitation-service-test");
  concurrentA = createPlatformPool({ ...config, poolMax: 1 }, "invitation-service-concurrent-a");
  concurrentB = createPlatformPool({ ...config, poolMax: 1 }, "invitation-service-concurrent-b");
});
afterAll(async () => { await concurrentB?.end(); await concurrentA?.end(); await web?.end(); await database?.dispose(); });
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

    const created = await service.createInvitation({ email: "Invitee@Example.Test", platformRole: "member",
      projectId, projectRole: "designer", invitedByUserId: inviterId });
    expect(created).toEqual({ invitationId: expect.stringMatching(/^.{36}$/) });
    const token = await deriveStoredInvitationToken(created.invitationId);
    expect(token).toMatch(new RegExp(`^${created.invitationId}\\.`));
    const row = await migration.query<{ token_hash: Buffer; created_at: Date; expires_at: Date }>(
      "SELECT token_hash,created_at,expires_at FROM platform.invitations WHERE id=$1", [created.invitationId]);
    expect(row.rows[0]!.expires_at.getTime() - row.rows[0]!.created_at.getTime()).toBe(86_400_000);
    expect(row.rows[0]!.token_hash.toString("utf8")).not.toContain(token);
    const outbox = await migration.query<{ payload: unknown }>("SELECT payload FROM platform.outbox_events");
    expect(outbox.rows).toEqual([{ payload: { invitationId: created.invitationId } }]);
    await expect(migration.query("SELECT action FROM platform.audit_events WHERE action='invitation.create'"))
      .resolves.toMatchObject({ rowCount: 1 });
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

  it("prepares without creating a user, then atomically activates MFA membership and ten recovery hashes", async () => {
    const service = makeService();
    const created = await createInvite(service, "new.user@example.test");
    const prepared = await service.prepare({ invitationToken: created.token, sourceIpPrefix: "203.0.113.0/24" });
    expect(prepared.otpauthUri).toContain("otpauth://totp/");
    await expect(migration.query("SELECT count(*)::int AS count FROM platform.users"))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(migration.query("SELECT count(*)::int AS count FROM platform.mfa_enrollments"))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });

    const completed = await service.complete({ enrollmentToken: prepared.enrollmentToken,
      sourceIpPrefix: "203.0.113.0/24", password: "correct horse battery staple",
      totp: totpAt(totpSecret, Date.now()) });
    expect(completed.recoveryCodes).toHaveLength(10);
    await expect(migration.query(`SELECT
      (SELECT count(*) FROM platform.users)::int AS users,
      (SELECT count(*) FROM platform.totp_credentials)::int AS credentials,
      (SELECT count(*) FROM platform.recovery_codes)::int AS recovery,
      (SELECT count(*) FROM platform.project_members)::int AS members,
      (SELECT count(*) FROM platform.invitations WHERE accepted_at IS NOT NULL)::int AS accepted`))
      .resolves.toMatchObject({ rows: [{ users: 2, credentials: 1, recovery: 10, members: 2, accepted: 1 }] });
    await expect(service.complete({ enrollmentToken: prepared.enrollmentToken,
      sourceIpPrefix: "203.0.113.0/24", password: "correct horse battery staple",
      totp: totpAt(totpSecret, Date.now()) })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });

  it("checks shared rate limits before generating TOTP material or hashing a password", async () => {
    const secretGenerator = vi.fn(() => Buffer.from(totpSecret));
    const passwordHasher = vi.fn(async () => { throw new Error("ARGON2_MUST_NOT_RUN"); });
    const service = makeService({ generateTotpSecret: secretGenerator, hashPassword: passwordHasher as never });
    const created = await createInvite(service, "blocked@example.test");
    const stored = await migration.query<{ token_hash: Buffer }>("SELECT token_hash FROM platform.invitations WHERE id=$1", [created.invitationId]);
    await blockAccount(stored.rows[0]!.token_hash);
    await expect(service.prepare({ invitationToken: created.token, sourceIpPrefix: "198.51.100.0/24" }))
      .rejects.toMatchObject({ code: "INVITATION_RATE_LIMITED" });
    expect(secretGenerator).not.toHaveBeenCalled();

    await migration.query("TRUNCATE platform.security_rate_limit_buckets");
    const prepared = await makeService().prepare({ invitationToken: created.token, sourceIpPrefix: "198.51.100.0/24" });
    await blockAccount(stored.rows[0]!.token_hash);
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
  return createInvitationService({ pool: web, keyrings,
    passwordHashOptions: { memoryCost: 8192, timeCost: 1, parallelism: 1, outputLen: 32 },
    generateTotpSecret: () => Buffer.from(totpSecret),
    generateRecoveryCodes: () => Array.from({ length: 10 }, (_, i) =>
      i.toString(16).padStart(32, "0").match(/.{4}/g)!.join("-")),
    ...overrides });
}

async function blockAccount(bucketKey: Buffer) {
  await migration.query(`INSERT INTO platform.security_rate_limit_buckets
    (bucket_type,bucket_key,window_started_at,attempt_count,blocked_until,updated_at)
    VALUES ('account',$1,clock_timestamp(),10,clock_timestamp()+interval '15 minutes',clock_timestamp())
    ON CONFLICT (bucket_type,bucket_key) DO UPDATE SET attempt_count=10,
      blocked_until=clock_timestamp()+interval '15 minutes',updated_at=clock_timestamp()`, [bucketKey]);
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
