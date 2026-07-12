import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { totpAt } from "../../platform/security/totp.ts";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createInvitationService } from "./invitationService.ts";

let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let web: PlatformPool;
const inviterId = "01890f1e-9b4a-7cc2-8f00-000000000061";
const projectId = "01890f1e-9b4a-7cc2-8f00-000000000062";
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
  web = createPlatformPool({ connectionString: database.urls.web, poolMax: 4, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 }, "invitation-service-test");
});
afterAll(async () => { await web?.end(); await database?.dispose(); });
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
    expect(created.token).toMatch(new RegExp(`^${created.invitationId}\\.`));
    const row = await migration.query<{ token_hash: Buffer; created_at: Date; expires_at: Date }>(
      "SELECT token_hash,created_at,expires_at FROM platform.invitations WHERE id=$1", [created.invitationId]);
    expect(row.rows[0]!.expires_at.getTime() - row.rows[0]!.created_at.getTime()).toBe(86_400_000);
    expect(row.rows[0]!.token_hash.toString("utf8")).not.toContain(created.token);
    const outbox = await migration.query<{ payload: unknown }>("SELECT payload FROM platform.outbox_events");
    expect(outbox.rows).toEqual([{ payload: { invitationId: created.invitationId } }]);
    await expect(migration.query("SELECT action FROM platform.audit_events WHERE action='invitation.create'"))
      .resolves.toMatchObject({ rowCount: 1 });
  });

  it("prepares without creating a user, then atomically activates MFA membership and ten recovery hashes", async () => {
    const service = makeService();
    const created = await service.createInvitation({ email: "new.user@example.test", platformRole: "member",
      projectId, projectRole: "designer", invitedByUserId: inviterId });
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
    const created = await service.createInvitation({ email: "blocked@example.test", platformRole: "member",
      projectId, projectRole: "viewer", invitedByUserId: inviterId });
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

  it("allows one concurrent completion and rolls back all activation rows when the final audit fails", async () => {
    const service = makeService();
    const concurrent = await createInvite(service, "concurrent@example.test");
    const prepared = await service.prepare({ invitationToken: concurrent.token, sourceIpPrefix: "100.64.0.0/24" });
    const input = { enrollmentToken: prepared.enrollmentToken, sourceIpPrefix: "100.64.0.0/24",
      password: "correct horse battery staple", totp: totpAt(totpSecret, Date.now()) };
    const outcomes = await Promise.allSettled([service.complete(input), service.complete(input)]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);

    await migration.query(`CREATE FUNCTION platform.reject_invitation_accept_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic invitation audit failure'; END $$`);
    await migration.query(`CREATE TRIGGER reject_invitation_accept_audit BEFORE INSERT ON platform.audit_events
      FOR EACH ROW WHEN (NEW.action='invitation.accept') EXECUTE FUNCTION platform.reject_invitation_accept_audit()`);
    try {
      const failing = await createInvite(service, "rollback@example.test");
      const failingEnrollment = await service.prepare({ invitationToken: failing.token, sourceIpPrefix: "100.65.0.0/24" });
      await expect(service.complete({ ...input, enrollmentToken: failingEnrollment.enrollmentToken,
        sourceIpPrefix: "100.65.0.0/24" })).rejects.toThrow("synthetic invitation audit failure");
      await expect(migration.query("SELECT count(*)::int AS count FROM platform.users WHERE email_normalized='rollback@example.test'"))
        .resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(migration.query("SELECT accepted_at FROM platform.invitations WHERE id=$1", [failing.invitationId]))
        .resolves.toMatchObject({ rows: [{ accepted_at: null }] });
    } finally {
      await migration.query("DROP TRIGGER reject_invitation_accept_audit ON platform.audit_events");
      await migration.query("DROP FUNCTION platform.reject_invitation_accept_audit()");
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

function createInvite(service: ReturnType<typeof makeService>, email: string) {
  return service.createInvitation({ email, platformRole: "member", projectId,
    projectRole: "designer", invitedByUserId: inviterId });
}
