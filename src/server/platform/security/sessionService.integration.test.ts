import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import { hashOpaqueToken } from "./tokenHash.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import { PostgresSessionRepository } from "../../modules/identity/repositories/postgres/PostgresSessionRepository.ts";
import { PostgresUserRepository } from "../../modules/identity/repositories/postgres/PostgresUserRepository.ts";
import { createSessionService } from "./sessionService.ts";

const passwordHashOptions = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;
const validNewPasswordHash =
  "$argon2id$v=19$m=19456,t=2,p=1$rUGf7HCiiHaKSmXoxVCJGA$y/CRugqFEn15nKRtAD1mCOQUYjNQriOuHh1kLhe+heA";

let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let web: PlatformPool;
let concurrentA: PlatformPool;
let concurrentB: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  const config = { connectionString: database.urls.web, poolMax: 4, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 };
  web = createPlatformPool(config, "session-service-test");
  concurrentA = createPlatformPool({ ...config, poolMax: 1 }, "session-service-concurrent-a");
  concurrentB = createPlatformPool({ ...config, poolMax: 1 }, "session-service-concurrent-b");
});

afterAll(async () => {
  await concurrentB?.end();
  await concurrentA?.end();
  await web?.end();
  await database?.dispose();
});

beforeEach(async () => {
  await migration.query("TRUNCATE platform.users CASCADE");
  await migration.query("TRUNCATE platform.audit_events");
});

describe("SessionService", () => {
  it("owns the 12-hour absolute and 60-minute idle session lifetimes", async () => {
    const user = await createUser("lifetime@example.test");
    const tokenHash = Buffer.alloc(32, 1);

    const session = await sessionService().createInTransaction(migration, {
      userId: user.id, tokenHash, clientSummary: "integration-client"
    });

    expect(session.absoluteExpiresAt.getTime() - session.createdAt.getTime()).toBe(12 * 60 * 60 * 1000);
    expect(session.idleExpiresAt.getTime() - session.createdAt.getTime()).toBe(60 * 60 * 1000);
    expect(session.tokenHash).toEqual(tokenHash);
  });

  it("authenticates a hash-only token, throttles concurrent touches, and never extends absolute expiry", async () => {
    const user = await createUser("active@example.test");
    const rawToken = "active-session-token";
    const session = await createSession(user.id, rawToken);
    await migration.query(`UPDATE platform.sessions SET created_at=clock_timestamp()-interval '1 hour',
      last_activity_at=clock_timestamp()-interval '6 minutes',last_touch_at=clock_timestamp()-interval '6 minutes'
      WHERE id=$1`, [session.id]);
    const before = await sessionTimes(session.id);

    const results = await Promise.all([
      sessionService(concurrentA).authenticate({ sessionToken: rawToken }),
      sessionService(concurrentB).authenticate({ sessionToken: rawToken })
    ]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.user).toMatchObject({ id: user.id, emailNormalized: "active@example.test" });
      expect(result.user).not.toHaveProperty("passwordHash");
      expect(result.session).not.toHaveProperty("tokenHash");
    }
    const after = await sessionTimes(session.id);
    expect(after.lastTouchAt.getTime()).toBeGreaterThan(before.lastTouchAt.getTime());
    expect(after.absoluteExpiresAt).toEqual(before.absoluteExpiresAt);
    expect(after.idleExpiresAt.getTime()).toBeLessThanOrEqual(after.absoluteExpiresAt.getTime());

    await sessionService().authenticate({ sessionToken: rawToken });
    expect(await sessionTimes(session.id)).toEqual(after);
  });

  it("rejects absolute expiry, idle expiry, revocation and disabled users", async () => {
    const active = await createUser("expired@example.test");
    const disabled = await createUser("disabled-session@example.test", "disabled");
    const cases = [
      { token: "absolute-token", userId: active.id, update: `created_at=clock_timestamp()-interval '2 hours',
        absolute_expires_at=clock_timestamp()-interval '1 hour',idle_expires_at=clock_timestamp()-interval '70 minutes',
        last_activity_at=clock_timestamp()-interval '80 minutes',last_touch_at=clock_timestamp()-interval '81 minutes'` },
      { token: "idle-token", userId: active.id, update: `created_at=clock_timestamp()-interval '2 hours',
        absolute_expires_at=clock_timestamp()+interval '1 hour',idle_expires_at=clock_timestamp()-interval '1 minute',
        last_activity_at=clock_timestamp()-interval '1 hour',last_touch_at=clock_timestamp()-interval '61 minutes'` },
      { token: "revoked-token", userId: active.id, update: "revoked_at=clock_timestamp()" },
      { token: "disabled-token", userId: disabled.id, update: "last_touch_at=last_touch_at" }
    ];
    for (const item of cases) {
      const session = await createSession(item.userId, item.token);
      await migration.query(`UPDATE platform.sessions SET ${item.update} WHERE id=$1`, [session.id]);
      await expect(sessionService().authenticate({ sessionToken: item.token }))
        .rejects.toMatchObject({ code: "SESSION_INVALID" });
    }
  });

  it("revokes the current session with its success audit and rolls both back on audit failure", async () => {
    const user = await createUser("revoke-current@example.test");
    const rawToken = "revoke-current-token";
    const session = await createSession(user.id, rawToken);
    const service = sessionService();

    await installAuditFailure("session.revoke");
    try {
      await expect(service.revokeCurrent({ sessionToken: rawToken, requestId: "revoke-current-fail" }))
        .rejects.toMatchObject({ code: "SESSION_SECURITY_DEPENDENCY_UNAVAILABLE" });
      await expect(new PostgresSessionRepository(migration).findActiveByTokenHash(hashOpaqueToken(rawToken)))
        .resolves.toMatchObject({ id: session.id });
    } finally {
      await removeAuditFailure();
    }

    await expect(service.revokeCurrent({ sessionToken: rawToken, requestId: "revoke-current-success" }))
      .resolves.toEqual({ revoked: true });
    await expect(migration.query(`SELECT
      (SELECT count(*) FROM platform.sessions WHERE revoked_at IS NOT NULL)::int AS revoked,
      (SELECT count(*) FROM platform.audit_events WHERE action='session.revoke' AND result='success')::int AS audits`))
      .resolves.toMatchObject({ rows: [{ revoked: 1, audits: 1 }] });
  });

  it("changes the password, revokes every session and appends one audit in the same commit", async () => {
    const user = await createUser("password-change@example.test");
    const other = await createUser("password-change-other@example.test");
    await createSession(user.id, "password-change-1");
    await createSession(user.id, "password-change-2");
    await createSession(other.id, "password-change-other");

    await expect(sessionService().changePasswordAndRevokeAll({ userId: user.id, newPasswordHash: validNewPasswordHash,
      requestId: "password-change" })).resolves.toEqual({ revokedCount: 2 });
    await expect(securityChangeState(user.id, "password-change-other")).resolves.toEqual({
      passwordHash: validNewPasswordHash, status: "active", activeSessions: 0, otherSessionActive: 1,
      audits: 1, actorUserId: user.id, targetUserId: user.id, reason: "password-change"
    });
  });

  it("rolls back the password and session revocations when the audit fails", async () => {
    const user = await createUser("password-rollback@example.test");
    const session = await createSession(user.id, "password-rollback-token");
    await installAuditFailure("session.revoke_all");
    try {
      await expect(sessionService().changePasswordAndRevokeAll({ userId: user.id,
        newPasswordHash: validNewPasswordHash, requestId: "password-rollback" }))
        .rejects.toMatchObject({ code: "SESSION_SECURITY_DEPENDENCY_UNAVAILABLE" });
      await expect(new PostgresUserRepository(migration).findById(user.id))
        .resolves.toMatchObject({ passwordHash: "$argon2id$seed", status: "active" });
      await expect(new PostgresSessionRepository(migration).findActiveByTokenHash(hashOpaqueToken("password-rollback-token")))
        .resolves.toMatchObject({ id: session.id });
      await expect(auditCount()).resolves.toBe(0);
    } finally {
      await removeAuditFailure();
    }
  });

  it("disables the target user, revokes sessions and audits the supplied actor", async () => {
    const actor = await createUser("disable-actor@example.test");
    const target = await createUser("disable-target@example.test");
    await createSession(target.id, "disable-target-token");

    await expect(sessionService().disableUserAndRevokeAll({ targetUserId: target.id, actorUserId: actor.id,
      requestId: "disable-user" })).resolves.toEqual({ revokedCount: 1 });
    await expect(securityChangeState(target.id)).resolves.toEqual({ passwordHash: "$argon2id$seed",
      status: "disabled", activeSessions: 0, otherSessionActive: 0, audits: 1,
      actorUserId: actor.id, targetUserId: target.id, reason: "user-disabled" });
  });

  it("rolls back user disabling and session revocations when the audit fails", async () => {
    const actor = await createUser("disable-rollback-actor@example.test");
    const target = await createUser("disable-rollback-target@example.test");
    const session = await createSession(target.id, "disable-rollback-token");
    await installAuditFailure("session.revoke_all");
    try {
      await expect(sessionService().disableUserAndRevokeAll({ targetUserId: target.id, actorUserId: actor.id,
        requestId: "disable-rollback" }))
        .rejects.toMatchObject({ code: "SESSION_SECURITY_DEPENDENCY_UNAVAILABLE" });
      await expect(new PostgresUserRepository(migration).findById(target.id))
        .resolves.toMatchObject({ status: "active" });
      await expect(new PostgresSessionRepository(migration).findActiveByTokenHash(hashOpaqueToken("disable-rollback-token")))
        .resolves.toMatchObject({ id: session.id });
      await expect(auditCount()).resolves.toBe(0);
    } finally {
      await removeAuditFailure();
    }
  });

  it("rejects an invalid password hash before opening a transaction", async () => {
    const service = sessionService(failingPool("transaction must not open"));

    await expect(service.changePasswordAndRevokeAll({
      userId: "01890f1e-9b4a-7cc2-8f00-000000000001", newPasswordHash: "$argon2id$invalid",
      requestId: "invalid-password-hash"
    })).rejects.toMatchObject({ code: "SESSION_INPUT_INVALID" });
  });

  it("serializes concurrent disable operations so only one state change and audit succeeds", async () => {
    const actor = await createUser("disable-concurrent-actor@example.test");
    const target = await createUser("disable-concurrent-target@example.test");
    await createSession(target.id, "disable-concurrent-token");
    const input = { targetUserId: target.id, actorUserId: actor.id, requestId: "disable-concurrent" };

    const outcomes = await Promise.allSettled([
      sessionService(concurrentA).disableUserAndRevokeAll(input),
      sessionService(concurrentB).disableUserAndRevokeAll(input)
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "SESSION_INVALID" }
    });
    await expect(securityChangeState(target.id)).resolves.toMatchObject({
      status: "disabled", activeSessions: 0, audits: 1
    });
  });

  it("sanitizes session lookup dependency failures", async () => {
    const service = sessionService(failingPool("session database secret must not leak"));

    const error = await service.authenticate({ sessionToken: "opaque-session-token" })
      .then(() => undefined, (failure: unknown) => failure);

    expect(error).toMatchObject({ code: "SESSION_SECURITY_DEPENDENCY_UNAVAILABLE",
      message: "SESSION_SECURITY_DEPENDENCY_UNAVAILABLE" });
    expect(JSON.stringify(error)).not.toContain("session database secret must not leak");
  });
});

function createUser(email: string, status: "active" | "disabled" = "active") {
  return new PostgresUserRepository(migration).create({ email, displayName: email.split("@")[0]!,
    passwordHash: "$argon2id$seed", platformRole: "member", status, mfaEnabledAt: new Date() });
}

function createSession(userId: string, rawToken: string) {
  return new PostgresSessionRepository(migration).create({ userId, tokenHash: hashOpaqueToken(rawToken),
    absoluteLifetimeSeconds: 12 * 60 * 60, idleLifetimeSeconds: 60 * 60, clientSummary: "integration-client" });
}

function sessionService(pool = web) {
  return createSessionService({ pool, passwordHashOptions });
}

async function securityChangeState(userId: string, otherToken?: string) {
  const result = await migration.query<{ password_hash: string; status: "active" | "disabled";
    active_sessions: number; other_session_active: number; audits: number; actor_user_id: string | null;
    target_id: string | null; reason: string | null }>(`SELECT u.password_hash,u.status,
      (SELECT count(*) FROM platform.sessions WHERE user_id=u.id AND revoked_at IS NULL)::int AS active_sessions,
      (SELECT count(*) FROM platform.sessions WHERE token_hash=$2 AND revoked_at IS NULL)::int AS other_session_active,
      (SELECT count(*) FROM platform.audit_events WHERE action='session.revoke_all' AND target_id=u.id)::int AS audits,
      (SELECT actor_user_id FROM platform.audit_events WHERE action='session.revoke_all' AND target_id=u.id
        ORDER BY occurred_at DESC LIMIT 1) AS actor_user_id,
      (SELECT target_id FROM platform.audit_events WHERE action='session.revoke_all' AND target_id=u.id
        ORDER BY occurred_at DESC LIMIT 1) AS target_id,
      (SELECT metadata->>'reason' FROM platform.audit_events WHERE action='session.revoke_all' AND target_id=u.id
        ORDER BY occurred_at DESC LIMIT 1) AS reason
    FROM platform.users u WHERE u.id=$1`, [userId, otherToken ? hashOpaqueToken(otherToken) : Buffer.alloc(32)]);
  const row = result.rows[0]!;
  return { passwordHash: row.password_hash, status: row.status, activeSessions: row.active_sessions,
    otherSessionActive: row.other_session_active, audits: row.audits, actorUserId: row.actor_user_id,
    targetUserId: row.target_id, reason: row.reason };
}

async function auditCount() {
  const result = await migration.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM platform.audit_events WHERE action='session.revoke_all'");
  return result.rows[0]!.count;
}

async function sessionTimes(id: string) {
  const result = await migration.query<{ absolute_expires_at: Date; idle_expires_at: Date; last_touch_at: Date }>(
    "SELECT absolute_expires_at,idle_expires_at,last_touch_at FROM platform.sessions WHERE id=$1", [id]);
  const row = result.rows[0]!;
  return { absoluteExpiresAt: row.absolute_expires_at, idleExpiresAt: row.idle_expires_at,
    lastTouchAt: row.last_touch_at };
}

async function installAuditFailure(action: string) {
  await migration.query(`CREATE FUNCTION platform.reject_session_audit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic session audit failure'; END $$`);
  await migration.query(`CREATE TRIGGER reject_session_audit BEFORE INSERT ON platform.audit_events
    FOR EACH ROW WHEN (NEW.action='${action}') EXECUTE FUNCTION platform.reject_session_audit()`);
}

async function removeAuditFailure() {
  await migration.query("DROP TRIGGER reject_session_audit ON platform.audit_events");
  await migration.query("DROP FUNCTION platform.reject_session_audit()");
}

function failingPool(message: string) {
  return { transactionTimeouts: { queryTimeoutMs: 1_000, lockTimeoutMs: 1_000, transactionTimeoutMs: 1_000 },
    async connect() { throw new Error(message); },
    async query() { throw new Error(message); } } as never;
}
