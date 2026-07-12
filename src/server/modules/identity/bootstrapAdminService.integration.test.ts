import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { totpAt } from "../../platform/security/totp.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createBootstrapAdminService } from "./bootstrapAdminService.ts";

const now = new Date("2026-07-12T15:00:00.000Z");
const totpSecret = Buffer.alloc(20, 7);
const passwordHashOptions = { memoryCost: 8192, timeCost: 1, parallelism: 1, outputLen: 32 };
const keyrings = {
  totpEncryption: { currentVersion: "totp-v1", keys: new Map([["totp-v1", Buffer.alloc(32, 1)]]) },
  recoveryHmac: { currentVersion: "recovery-v1", keys: new Map([["recovery-v1", Buffer.alloc(32, 2)]]) }
};

let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let bootstrap: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  bootstrap = createPlatformPool({
    connectionString: database.urls.bootstrap,
    poolMax: 2,
    connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000,
    lockTimeoutMs: 2_000,
    transactionTimeoutMs: 10_000
  }, "bootstrap-admin-test");
});

afterAll(async () => {
  await bootstrap?.end();
  await database?.dispose();
});

beforeEach(async () => {
  await migration.query("TRUNCATE platform.users CASCADE");
});

function service(secret = totpSecret) {
  return createBootstrapAdminService({
    pool: bootstrap,
    keyrings,
    passwordHashOptions,
    clock: () => new Date(now),
    generateTotpSecret: () => Buffer.from(secret)
  });
}

async function prepare(email = " First.Admin@Example.Test ") {
  return service().prepare({
    email,
    displayName: "First Administrator",
    password: "correct horse battery staple"
  });
}

async function counts() {
  const result = await migration.query<{
    users: string; credentials: string; recovery: string; successful_audits: string;
  }>(`SELECT
      (SELECT count(*) FROM platform.users)::text AS users,
      (SELECT count(*) FROM platform.totp_credentials)::text AS credentials,
      (SELECT count(*) FROM platform.recovery_codes)::text AS recovery,
      (SELECT count(*) FROM platform.audit_events WHERE action = 'admin.bootstrap' AND result = 'success')::text
        AS successful_audits`);
  return result.rows[0];
}

describe("BootstrapAdminService", () => {
  it("creates one complete MFA-enabled administrator and returns ten one-time recovery codes", async () => {
    const challenge = await prepare();
    expect(challenge.otpauthUri).toMatch(/^otpauth:\/\/totp\//);

    const completed = await challenge.complete(totpAt(totpSecret, now.getTime()));

    expect(completed.recoveryCodes).toHaveLength(10);
    expect(new Set(completed.recoveryCodes)).toHaveLength(10);
    const user = await migration.query<{
      id: string; email_normalized: string; platform_role: string; status: string;
      mfa_status: string; mfa_enabled_at: Date;
    }>("SELECT id, email_normalized, platform_role, status, mfa_status, mfa_enabled_at FROM platform.users");
    expect(user.rows).toEqual([expect.objectContaining({
      email_normalized: "first.admin@example.test",
      platform_role: "admin",
      status: "active",
      mfa_status: "enabled"
    })]);
    const credential = await migration.query<{ user_id: string; confirmed_at: Date }>(
      "SELECT user_id, confirmed_at FROM platform.totp_credentials"
    );
    expect(credential.rows).toEqual([{
      user_id: user.rows[0]!.id,
      confirmed_at: user.rows[0]!.mfa_enabled_at
    }]);
    expect(await counts()).toEqual({ users: "1", credentials: "1", recovery: "10", successful_audits: "1" });
    await expect(challenge.complete(totpAt(totpSecret, now.getTime())))
      .rejects.toMatchObject({ code: "BOOTSTRAP_ADMIN_CHALLENGE_USED" });
  });

  it("allows exactly one of two concurrent bootstraps on an empty users table", async () => {
    const first = await prepare("first@example.test");
    const second = await service(Buffer.alloc(20, 8)).prepare({
      email: "second@example.test",
      displayName: "Second Administrator",
      password: "another correct horse battery staple"
    });
    const outcomes = await Promise.allSettled([
      first.complete(totpAt(totpSecret, now.getTime())),
      second.complete(totpAt(Buffer.alloc(20, 8), now.getTime()))
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "BOOTSTRAP_ADMIN_ALREADY_EXISTS" }) })
    ]);
    expect(await counts()).toEqual({ users: "1", credentials: "1", recovery: "10", successful_audits: "1" });
  });

  it("rejects a non-empty users table even when the presented TOTP is valid", async () => {
    const first = await prepare();
    await first.complete(totpAt(totpSecret, now.getTime()));
    const second = await prepare("other@example.test");

    await expect(second.complete(totpAt(totpSecret, now.getTime())))
      .rejects.toMatchObject({ code: "BOOTSTRAP_ADMIN_ALREADY_EXISTS" });
    expect(await counts()).toEqual({ users: "1", credentials: "1", recovery: "10", successful_audits: "1" });
  });

  it("leaves no rows for password-policy or TOTP failures and consumes a failed challenge", async () => {
    await expect(service().prepare({
      email: "admin@example.test",
      displayName: "Admin",
      password: "short"
    })).rejects.toMatchObject({ code: "BOOTSTRAP_ADMIN_PASSWORD_POLICY" });
    expect(await counts()).toEqual({ users: "0", credentials: "0", recovery: "0", successful_audits: "0" });

    const challenge = await prepare();
    await expect(challenge.complete("000000")).rejects.toMatchObject({ code: "BOOTSTRAP_ADMIN_TOTP_INVALID" });
    await expect(challenge.complete(totpAt(totpSecret, now.getTime())))
      .rejects.toMatchObject({ code: "BOOTSTRAP_ADMIN_CHALLENGE_USED" });
    expect(await counts()).toEqual({ users: "0", credentials: "0", recovery: "0", successful_audits: "0" });
  });

  it("allows only one concurrent completion of the same in-memory challenge", async () => {
    const challenge = await prepare();
    const token = totpAt(totpSecret, now.getTime());
    const outcomes = await Promise.allSettled([challenge.complete(token), challenge.complete(token)]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "BOOTSTRAP_ADMIN_CHALLENGE_USED" }) })
    ]);
    expect(await counts()).toEqual({ users: "1", credentials: "1", recovery: "10", successful_audits: "1" });
  });

  it("rolls back every identity row when the final audit append fails", async () => {
    await migration.query(`CREATE FUNCTION platform.reject_bootstrap_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
    await migration.query(`CREATE TRIGGER reject_bootstrap_audit
      BEFORE INSERT ON platform.audit_events FOR EACH ROW
      WHEN (NEW.action = 'admin.bootstrap') EXECUTE FUNCTION platform.reject_bootstrap_audit()`);
    try {
      const challenge = await prepare();
      await expect(challenge.complete(totpAt(totpSecret, now.getTime()))).rejects.toThrow("synthetic audit failure");
      await expect(challenge.complete(totpAt(totpSecret, now.getTime())))
        .rejects.toMatchObject({ code: "BOOTSTRAP_ADMIN_CHALLENGE_USED" });
      expect(await counts()).toEqual({ users: "0", credentials: "0", recovery: "0", successful_audits: "0" });
    } finally {
      await migration.query("DROP TRIGGER reject_bootstrap_audit ON platform.audit_events");
      await migration.query("DROP FUNCTION platform.reject_bootstrap_audit() ");
    }
  });
});
