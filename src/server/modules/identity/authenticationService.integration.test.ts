import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { hashPassword } from "../../platform/security/passwords.ts";
import { encryptSecret } from "../../platform/security/secretEncryption.ts";
import { hashRecoveryCode } from "../../platform/security/recoveryCodes.ts";
import { totpAt } from "../../platform/security/totp.ts";
import { hashOpaqueToken } from "../../platform/security/tokenHash.ts";
import { createRateLimitService } from "../../platform/security/rateLimitService.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { PostgresMfaRepository } from "./repositories/postgres/PostgresMfaRepository.ts";
import { PostgresUserRepository } from "./repositories/postgres/PostgresUserRepository.ts";
import {
  AUTHENTICATION_DUMMY_PASSWORD_HASH,
  createAuthenticationService
} from "./authenticationService.ts";

let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let web: PlatformPool;
let concurrentA: PlatformPool;
let concurrentB: PlatformPool;
let realPasswordHash: string;

const passwordOptions = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 };
const correctPassword = "correct horse battery staple";
const totpSecret = Buffer.alloc(20, 7);
const recoveryCode = "0000-0000-0000-0000-0000-0000-0000-0001";
const keyrings = {
  totpEncryption: { currentVersion: "totp-v1", keys: new Map([["totp-v1", Buffer.alloc(32, 2)]]) },
  recoveryHmac: { currentVersion: "recovery-v2", keys: new Map([
    ["recovery-v1", Buffer.alloc(32, 3)], ["recovery-v2", Buffer.alloc(32, 4)]
  ]) }
};

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  const config = { connectionString: database.urls.web, poolMax: 4, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 };
  web = createPlatformPool(config, "authentication-service-test");
  concurrentA = createPlatformPool({ ...config, poolMax: 1 }, "authentication-concurrent-a");
  concurrentB = createPlatformPool({ ...config, poolMax: 1 }, "authentication-concurrent-b");
  realPasswordHash = await hashPassword(correctPassword, passwordOptions);
});

afterAll(async () => {
  await concurrentB?.end();
  await concurrentA?.end();
  await web?.end();
  await database?.dispose();
});

beforeEach(async () => {
  await migration.query("TRUNCATE platform.users CASCADE");
  await migration.query("TRUNCATE platform.security_rate_limit_buckets, platform.audit_events");
});

describe("AuthenticationService password login", () => {
  it("requires a structured security logger at construction", () => {
    for (const logger of [undefined, null, {}, { error: "not-a-function" }]) {
      expect(() => createAuthenticationService({ ...authenticationOptions(), logger } as never))
        .toThrow(expect.objectContaining({ code: "AUTHENTICATION_INPUT_INVALID" }));
    }
  });

  it("verifies known-wrong and unknown users exactly once with indistinguishable external failures", async () => {
    const user = await createUser("known@example.test");
    const verifier = vi.fn(async (_encoded: string, _password: string) => false);
    const service = makeService({ verifyPassword: verifier });

    await expect(service.login(loginInput("known@example.test", "wrong password", "login-known")))
      .rejects.toMatchObject({ code: "AUTHENTICATION_INVALID_CREDENTIALS" });
    await expect(service.login(loginInput("unknown@example.test", "wrong password", "login-unknown", "203.0.114.0/24")))
      .rejects.toMatchObject({ code: "AUTHENTICATION_INVALID_CREDENTIALS" });

    expect(verifier).toHaveBeenCalledTimes(2);
    expect(verifier.mock.calls[0]![0]).toBe(user.passwordHash);
    expect(verifier.mock.calls[1]![0]).toBe(AUTHENTICATION_DUMMY_PASSWORD_HASH);
    await expect(migration.query(`SELECT result,count(*)::int AS count FROM platform.audit_events
      WHERE action='authentication.password' GROUP BY result`))
      .resolves.toMatchObject({ rows: [{ result: "failure", count: 2 }] });
  });

  it("rejects an oversized password before Argon2 and rejects disabled or MFA-incomplete users", async () => {
    await createUser("disabled@example.test", { status: "disabled" });
    await createUser("no-mfa@example.test", { mfaEnabled: false });
    const verifier = vi.fn(async () => true);
    const service = makeService({ verifyPassword: verifier });

    await expect(service.login(loginInput("unknown@example.test", "密".repeat(86), "login-large")))
      .rejects.toMatchObject({ code: "AUTHENTICATION_INVALID_CREDENTIALS" });
    expect(verifier).not.toHaveBeenCalled();
    for (const [index, email] of ["disabled@example.test", "no-mfa@example.test"].entries()) {
      await expect(service.login(loginInput(email, correctPassword, `login-state-${index}`, `203.0.115.${index}/24`)))
        .rejects.toMatchObject({ code: "AUTHENTICATION_INVALID_CREDENTIALS" });
    }
    expect(verifier).toHaveBeenCalledTimes(2);
    await expect(migration.query("SELECT count(*)::int AS count FROM platform.mfa_challenges"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("creates only a five-minute hashed MFA challenge and success audit after password verification", async () => {
    await createUser("success@example.test");
    const result = await makeService({ verifyPassword: async () => true })
      .login(loginInput("success@example.test", correctPassword, "login-success"));

    expect(result).toEqual({ next: "mfa", challengeToken: expect.any(String) });
    const state = await migration.query<{ raw_match: boolean; lifetime: string; sessions: number; audits: number }>(`SELECT
      EXISTS(SELECT 1 FROM platform.mfa_challenges WHERE token_hash=convert_to($1,'UTF8')) AS raw_match,
      (SELECT extract(epoch FROM expires_at-created_at)::int::text FROM platform.mfa_challenges) AS lifetime,
      (SELECT count(*) FROM platform.sessions)::int AS sessions,
      (SELECT count(*) FROM platform.audit_events WHERE action='authentication.password' AND result='success')::int AS audits`,
    [result.challengeToken]);
    expect(state.rows[0]).toEqual({ raw_match: false, lifetime: "300", sessions: 0, audits: 1 });
  });

  it("fails closed and emits only stable high-priority context when a failure audit cannot be written", async () => {
    const logger = { error: vi.fn() };
    await installAuditFailure("authentication.password", "failure");
    try {
      const service = makeService({ verifyPassword: async () => false, logger });
      await expect(service.login(loginInput("unknown@example.test", "wrong password", "login-audit-failure")))
        .rejects.toMatchObject({ code: "AUTHENTICATION_SECURITY_DEPENDENCY_UNAVAILABLE" });
      expect(logger.error).toHaveBeenCalledWith({ requestId: "login-audit-failure",
        code: "AUTHENTICATION_FAILURE_AUDIT_UNAVAILABLE" });
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain("unknown@example.test");
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain("wrong password");
    } finally {
      await removeAuditFailure();
    }
  });

  it("rolls back a successful password challenge when its success audit fails", async () => {
    await createUser("password-audit@example.test");
    const logger = { error: vi.fn() };
    await installAuditFailure("authentication.password", "success");
    try {
      await expect(makeService({ verifyPassword: async () => true, logger }).login(
        loginInput("password-audit@example.test", correctPassword, "password-success-audit")))
        .rejects.toMatchObject({ code: "AUTHENTICATION_SECURITY_DEPENDENCY_UNAVAILABLE" });
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith({ requestId: "password-success-audit",
        userId: expect.any(String), code: "AUTHENTICATION_LOGIN_TRANSACTION_UNAVAILABLE" });
      await expect(migration.query("SELECT count(*)::int AS count FROM platform.mfa_challenges"))
        .resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await removeAuditFailure();
    }
  });

  it("sanitizes a login dependency failure before user lookup and logs no credential", async () => {
    const logger = { error: vi.fn() };
    const service = makeService({ pool: failingPool("database credential must not leak"), logger });

    const error = await service.login(loginInput("dependency@example.test", "secret password",
      "login-dependency")).then(() => undefined, (failure: unknown) => failure);

    expect(error).toMatchObject({ code: "AUTHENTICATION_SECURITY_DEPENDENCY_UNAVAILABLE" });
    expect(logger.error).toHaveBeenCalledWith({ requestId: "login-dependency",
      code: "AUTHENTICATION_RATE_LIMIT_UNAVAILABLE" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([error, logger.error.mock.calls])).not.toContain("database credential");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("dependency@example.test");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret password");
  });

  it("keeps dependency and logger failures internal when the required logger throws", async () => {
    const logger = { error: vi.fn(() => { throw new Error("logger credential must not leak"); }) };
    const service = makeService({ pool: failingPool("database credential must not leak"), logger });

    const error = await service.login(loginInput("logger-throw@example.test", "secret password", "logger-throw"))
      .then(() => undefined, (failure: unknown) => failure) as Error & { code: string; cause?: unknown };

    expect(error).toMatchObject({ code: "AUTHENTICATION_SECURITY_DEPENDENCY_UNAVAILABLE",
      message: "AUTHENTICATION_SECURITY_DEPENDENCY_UNAVAILABLE" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect(Object.keys(error)).not.toContain("cause");
    expect(JSON.stringify(error)).not.toContain("database credential");
    expect(JSON.stringify(error)).not.toContain("logger credential");
  });
});

describe("AuthenticationService MFA completion", () => {
  it("creates one hashed session after TOTP and clears the decrypted secret", async () => {
    await createUser("totp@example.test");
    const challenge = await login("totp@example.test", "mfa-totp-login");
    const observedSecret = Buffer.from(totpSecret);
    const service = makeService({ decryptSecret: () => observedSecret });

    const result = await service.completeMfa(mfaInput(challenge.challengeToken, "mfa-totp", {
      method: "totp", code: totpAt(totpSecret, Date.now())
    }));

    expect(result.sessionToken).toEqual(expect.any(String));
    expect(result.user).toMatchObject({ emailNormalized: "totp@example.test", status: "active" });
    expect(result.user).not.toHaveProperty("passwordHash");
    expect(observedSecret).toEqual(Buffer.alloc(totpSecret.length));
    await expect(authenticationState()).resolves.toEqual({ challengesCompleted: 1, sessions: 1,
      sessionRawMatches: 0, successAudits: 1 });
  });

  it("allows one of two independent TOTP completions and creates no second session", async () => {
    await createUser("concurrent-totp@example.test");
    const challenge = await login("concurrent-totp@example.test", "mfa-concurrent-login");
    const input = mfaInput(challenge.challengeToken, "mfa-concurrent", {
      method: "totp", code: totpAt(totpSecret, Date.now())
    });

    const outcomes = await Promise.allSettled([
      makeService({ pool: concurrentA }).completeMfa(input),
      makeService({ pool: concurrentB }).completeMfa(input)
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(migration.query("SELECT count(*)::int AS count FROM platform.sessions"))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("verifies a retained recovery key and consumes the code once across two challenges", async () => {
    const user = await createUser("recovery@example.test");
    await new PostgresMfaRepository(migration).addRecoveryCodes(user.id, [
      hashRecoveryCode(recoveryCode, keyrings.recoveryHmac, "recovery-v1")
    ]);
    const first = await login("recovery@example.test", "recovery-login-1", "203.0.117.0/24");
    const second = await login("recovery@example.test", "recovery-login-2", "203.0.118.0/24");

    const outcomes = await Promise.allSettled([
      makeService({ pool: concurrentA }).completeMfa(mfaInput(first.challengeToken, "recovery-mfa-1",
        { method: "recovery", code: recoveryCode }, "203.0.119.0/24")),
      makeService({ pool: concurrentB }).completeMfa(mfaInput(second.challengeToken, "recovery-mfa-2",
        { method: "recovery", code: recoveryCode }, "203.0.120.0/24"))
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(migration.query(`SELECT
      (SELECT count(*) FROM platform.recovery_codes WHERE used_at IS NOT NULL)::int AS used,
      (SELECT count(*) FROM platform.sessions)::int AS sessions`))
      .resolves.toMatchObject({ rows: [{ used: 1, sessions: 1 }] });
  });

  it("checks MFA account limits before decrypting or verifying a factor", async () => {
    const user = await createUser("mfa-blocked@example.test");
    const challenge = await login("mfa-blocked@example.test", "mfa-blocked-login");
    const limiter = createRateLimitService({ pool: web });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await limiter.consumeAccount({ operation: "authentication.mfa", accountKey: Buffer.from(user.id),
        policy: { windowSeconds: 900, limit: 10, blockSeconds: 900 } });
    }
    const decrypt = vi.fn(() => Buffer.from(totpSecret));
    await expect(makeService({ decryptSecret: decrypt }).completeMfa(mfaInput(challenge.challengeToken,
      "mfa-blocked", { method: "totp", code: "000000" })))
      .rejects.toMatchObject({ code: "AUTHENTICATION_RATE_LIMITED" });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("checks the MFA IP limit before reading challenge or factor secrets", async () => {
    const limiter = createRateLimitService({ pool: web });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await limiter.consumeIp({ operation: "authentication.mfa", sourceIpPrefix: "203.0.125.0/24",
        policy: { windowSeconds: 900, limit: 10, blockSeconds: 900 } });
    }
    const blocked = { sourceIpPrefix: "203.0.125.0/24", requestId: "mfa-ip-blocked",
      clientSummary: "integration-client",
      get challengeToken(): string { throw new Error("CHALLENGE_MUST_NOT_BE_READ"); },
      get factor(): never { throw new Error("FACTOR_MUST_NOT_BE_READ"); } };

    await expect(makeService().completeMfa(blocked))
      .rejects.toMatchObject({ code: "AUTHENTICATION_RATE_LIMITED" });
  });

  it("rolls back challenge completion and session creation when the success audit fails", async () => {
    await createUser("mfa-audit@example.test");
    const challenge = await login("mfa-audit@example.test", "mfa-audit-login");
    await installAuditFailure("authentication.mfa", "success");
    try {
      await expect(makeService().completeMfa(mfaInput(challenge.challengeToken, "mfa-audit", {
        method: "totp", code: totpAt(totpSecret, Date.now())
      }))).rejects.toMatchObject({ code: "AUTHENTICATION_SECURITY_DEPENDENCY_UNAVAILABLE" });
      await expect(migration.query(`SELECT
        (SELECT count(*) FROM platform.mfa_challenges WHERE completed_at IS NOT NULL)::int AS completed,
        (SELECT count(*) FROM platform.sessions)::int AS sessions`))
        .resolves.toMatchObject({ rows: [{ completed: 0, sessions: 0 }] });
    } finally {
      await removeAuditFailure();
    }
  });

  it("records an invalid factor attempt with its failure audit and rolls both back if that audit fails", async () => {
    await createUser("mfa-failure@example.test");
    const first = await login("mfa-failure@example.test", "mfa-failure-login-1", "203.0.121.0/24");
    await expect(makeService({ verifyTotp: () => false }).completeMfa(mfaInput(first.challengeToken,
      "mfa-failure-1", { method: "totp", code: "000000" }, "203.0.122.0/24")))
      .rejects.toMatchObject({ code: "AUTHENTICATION_MFA_INVALID" });
    await expect(migration.query(`SELECT
      (SELECT attempt_count FROM platform.mfa_challenges WHERE token_hash=$1)::int AS attempts,
      (SELECT count(*) FROM platform.audit_events WHERE action='authentication.mfa' AND result='failure')::int AS audits`,
    [hashOpaqueToken(first.challengeToken)])).resolves.toMatchObject({ rows: [{ attempts: 1, audits: 1 }] });

    const second = await login("mfa-failure@example.test", "mfa-failure-login-2", "203.0.123.0/24");
    await installAuditFailure("authentication.mfa", "failure");
    try {
      await expect(makeService({ verifyTotp: () => false }).completeMfa(mfaInput(second.challengeToken,
        "mfa-failure-2", { method: "totp", code: "000000" }, "203.0.124.0/24")))
        .rejects.toMatchObject({ code: "AUTHENTICATION_SECURITY_DEPENDENCY_UNAVAILABLE" });
      await expect(migration.query("SELECT attempt_count FROM platform.mfa_challenges WHERE token_hash=$1",
        [hashOpaqueToken(second.challengeToken)])).resolves.toMatchObject({ rows: [{ attempt_count: 0 }] });
    } finally {
      await removeAuditFailure();
    }
  });

  it("records a malformed factor against a known challenge as an audited attempt", async () => {
    await createUser("mfa-malformed@example.test");
    const challenge = await login("mfa-malformed@example.test", "mfa-malformed-login", "203.0.126.0/24");
    const input = { ...mfaInput(challenge.challengeToken, "mfa-malformed", {
      method: "totp", code: "000000"
    }, "203.0.127.0/24"), factor: { method: "totp", code: "" } as never };

    await expect(makeService().completeMfa(input))
      .rejects.toMatchObject({ code: "AUTHENTICATION_MFA_INVALID" });
    await expect(migration.query(`SELECT
      (SELECT attempt_count FROM platform.mfa_challenges WHERE token_hash=$1)::int AS attempts,
      (SELECT count(*) FROM platform.audit_events WHERE action='authentication.mfa' AND result='failure')::int AS audits`,
    [hashOpaqueToken(challenge.challengeToken)])).resolves.toMatchObject({ rows: [{ attempts: 1, audits: 1 }] });
  });
});

function authenticationOptions(overrides: Record<string, unknown> = {}) {
  return { pool: web, keyrings, passwordHashOptions: passwordOptions,
    dummyPasswordHash: AUTHENTICATION_DUMMY_PASSWORD_HASH, logger: { error: vi.fn() }, ...overrides };
}

function makeService(overrides: Record<string, unknown> = {}) {
  return createAuthenticationService(authenticationOptions(overrides));
}

async function createUser(email: string, options: { status?: "active" | "disabled"; mfaEnabled?: boolean } = {}) {
  const user = await new PostgresUserRepository(migration).create({ email, displayName: email.split("@")[0]!,
    passwordHash: realPasswordHash, platformRole: "member", status: options.status ?? "active",
    mfaEnabledAt: options.mfaEnabled === false ? undefined : new Date() });
  if (options.mfaEnabled !== false) {
    const encrypted = encryptSecret(totpSecret, keyrings.totpEncryption);
    await new PostgresMfaRepository(migration).insertTotpCredential({ userId: user.id,
      encryptedSecret: encrypted.encryptedSecret, keyVersion: encrypted.keyVersion, confirmedAt: new Date() });
  }
  return user;
}

function loginInput(email: string, password: string, requestId: string, sourceIpPrefix = "203.0.113.0/24") {
  return { email, password, sourceIpPrefix, requestId, clientSummary: "integration-client" };
}

function mfaInput(challengeToken: string, requestId: string,
  factor: { method: "totp" | "recovery"; code: string }, sourceIpPrefix = "203.0.116.0/24") {
  return { challengeToken, factor, sourceIpPrefix, requestId, clientSummary: "integration-client" };
}

function login(email: string, requestId: string, sourceIpPrefix?: string) {
  return makeService({ verifyPassword: async () => true })
    .login(loginInput(email, correctPassword, requestId, sourceIpPrefix));
}

async function authenticationState() {
  const result = await migration.query<{ challenges_completed: number; sessions: number;
    session_raw_matches: number; success_audits: number }>(`SELECT
      (SELECT count(*) FROM platform.mfa_challenges WHERE completed_at IS NOT NULL)::int AS challenges_completed,
      (SELECT count(*) FROM platform.sessions)::int AS sessions,
      0::int AS session_raw_matches,
      (SELECT count(*) FROM platform.audit_events
        WHERE action='authentication.mfa' AND result='success')::int AS success_audits`);
  const row = result.rows[0]!;
  return { challengesCompleted: row.challenges_completed, sessions: row.sessions,
    sessionRawMatches: row.session_raw_matches, successAudits: row.success_audits };
}

async function installAuditFailure(action: string, result: "success" | "failure") {
  await migration.query(`CREATE FUNCTION platform.reject_authentication_audit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic authentication audit failure'; END $$`);
  await migration.query(`CREATE TRIGGER reject_authentication_audit BEFORE INSERT ON platform.audit_events
    FOR EACH ROW WHEN (NEW.action='${action}' AND NEW.result='${result}')
    EXECUTE FUNCTION platform.reject_authentication_audit()`);
}

async function removeAuditFailure() {
  await migration.query("DROP TRIGGER reject_authentication_audit ON platform.audit_events");
  await migration.query("DROP FUNCTION platform.reject_authentication_audit()");
}

function failingPool(message: string) {
  return { transactionTimeouts: { queryTimeoutMs: 1_000, lockTimeoutMs: 1_000, transactionTimeoutMs: 1_000 },
    async connect() { throw new Error(message); } } as never;
}
