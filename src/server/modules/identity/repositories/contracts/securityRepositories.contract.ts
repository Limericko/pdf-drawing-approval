import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../../../../platform/database/queryExecutor.ts";
import type { AuditRepository } from "../auditRepository.ts";
import type { MfaRepository } from "../mfaRepository.ts";
import type { RateLimitRepository } from "../rateLimitRepository.ts";
import type { SessionRepository } from "../sessionRepository.ts";

export type SecurityRepositories = {
  readonly mfa: MfaRepository;
  readonly sessions: SessionRepository;
  readonly rateLimits: RateLimitRepository;
  readonly audit: AuditRepository;
};

export type SecurityRepositoryFactory = (executor: QueryExecutor) => SecurityRepositories;

export type SecurityRepositoryContractContext = {
  readonly primary: QueryExecutor;
  readonly concurrentA: QueryExecutor;
  readonly concurrentB: QueryExecutor;
  readonly migration: QueryExecutor;
  createUser(): Promise<{ readonly id: string }>;
  createInvitation(): Promise<{ readonly id: string }>;
};

type ContractOptions = {
  readonly createRepositories: SecurityRepositoryFactory;
  readonly getContext: () => SecurityRepositoryContractContext;
};

function expectCopiedBuffer(actual: Buffer, source: Buffer) {
  expect(actual).toEqual(source);
  expect(actual).not.toBe(source);
}

export function securityRepositoriesContract(options: ContractOptions) {
  const context = () => options.getContext();
  const repositories = () => options.createRepositories(context().primary);

  describe("security repository contract", () => {
    it("creates, limits attempts, expires, and atomically completes MFA challenges", async () => {
      const user = await context().createUser();
      const tokenHash = randomBytes(32);
      const challenge = await repositories().mfa.createChallenge({
        userId: user.id,
        tokenHash,
        lifetimeSeconds: 300,
        maxAttempts: 2
      });

      expectCopiedBuffer(challenge.tokenHash, tokenHash);
      expect(challenge.expiresAt.getTime() - challenge.createdAt.getTime()).toBe(300_000);
      await expect(repositories().mfa.findActiveChallengeByTokenHash(tokenHash)).resolves.toEqual(challenge);
      await expect(repositories().mfa.recordChallengeAttempt(challenge.id)).resolves.toMatchObject({ attemptCount: 1 });

      const repoA = options.createRepositories(context().concurrentA).mfa;
      const repoB = options.createRepositories(context().concurrentB).mfa;
      const completions = await Promise.all([repoA.completeChallenge(challenge.id), repoB.completeChallenge(challenge.id)]);
      expect(completions.filter(Boolean)).toHaveLength(1);
      expect(completions.filter((value) => value === undefined)).toHaveLength(1);
      await expect(repositories().mfa.recordChallengeAttempt(challenge.id)).resolves.toBeUndefined();

      const exhausted = await repositories().mfa.createChallenge({
        userId: user.id,
        tokenHash: randomBytes(32),
        lifetimeSeconds: 300,
        maxAttempts: 1
      });
      await expect(repositories().mfa.recordChallengeAttempt(exhausted.id)).resolves.toMatchObject({ attemptCount: 1 });
      await expect(repositories().mfa.recordChallengeAttempt(exhausted.id)).resolves.toBeUndefined();
      await expect(repositories().mfa.completeChallenge(exhausted.id)).resolves.toBeUndefined();

      const expired = await repositories().mfa.createChallenge({
        userId: user.id,
        tokenHash: randomBytes(32),
        lifetimeSeconds: 300,
        maxAttempts: 2
      });
      await context().migration.query(
        "UPDATE platform.mfa_challenges SET created_at = clock_timestamp() - interval '10 minutes', expires_at = clock_timestamp() - interval '5 minutes' WHERE id = $1",
        [expired.id]
      );
      await expect(repositories().mfa.completeChallenge(expired.id)).resolves.toBeUndefined();
    });

    it("fails closed for terminal MFA enrollments and stores the encrypted secret without doing cryptography", async () => {
      const invitation = await context().createInvitation();
      const secret = randomBytes(48);
      const enrollment = await repositories().mfa.createEnrollment({
        invitationId: invitation.id,
        tokenHash: randomBytes(32),
        encryptedTotpSecret: secret,
        keyVersion: "v1",
        lifetimeSeconds: 600,
        maxAttempts: 2
      });
      expectCopiedBuffer(enrollment.encryptedTotpSecret, secret);
      expect(enrollment.expiresAt.getTime() - enrollment.createdAt.getTime()).toBe(600_000);
      await expect(repositories().mfa.findActiveEnrollmentByTokenHash(enrollment.tokenHash)).resolves.toEqual(enrollment);
      await expect(repositories().mfa.recordEnrollmentAttempt(enrollment.id)).resolves.toMatchObject({ attemptCount: 1 });
      await expect(repositories().mfa.invalidateEnrollment(enrollment.id)).resolves.toMatchObject({ id: enrollment.id });
      await expect(repositories().mfa.completeEnrollment(enrollment.id)).resolves.toBeUndefined();
      await expect(repositories().mfa.recordEnrollmentAttempt(enrollment.id)).resolves.toBeUndefined();

      const second = await repositories().mfa.createEnrollment({
        invitationId: invitation.id,
        tokenHash: randomBytes(32),
        encryptedTotpSecret: secret,
        keyVersion: "v1",
        lifetimeSeconds: 600,
        maxAttempts: 2
      });
      const repoA = options.createRepositories(context().concurrentA).mfa;
      const repoB = options.createRepositories(context().concurrentB).mfa;
      const completions = await Promise.all([repoA.completeEnrollment(second.id), repoB.completeEnrollment(second.id)]);
      expect(completions.filter(Boolean)).toHaveLength(1);
      await expect(repositories().mfa.invalidateEnrollment(second.id)).resolves.toBeUndefined();

      const exhaustedInvitation = await context().createInvitation();
      const exhausted = await repositories().mfa.createEnrollment({
        invitationId: exhaustedInvitation.id,
        tokenHash: randomBytes(32),
        encryptedTotpSecret: secret,
        keyVersion: "v1",
        lifetimeSeconds: 600,
        maxAttempts: 1
      });
      await expect(repositories().mfa.recordEnrollmentAttempt(exhausted.id)).resolves.toMatchObject({ attemptCount: 1 });
      await expect(repositories().mfa.recordEnrollmentAttempt(exhausted.id)).resolves.toBeUndefined();
      await expect(repositories().mfa.completeEnrollment(exhausted.id)).resolves.toBeUndefined();

      const expiredInvitation = await context().createInvitation();
      const expired = await repositories().mfa.createEnrollment({
        invitationId: expiredInvitation.id,
        tokenHash: randomBytes(32),
        encryptedTotpSecret: secret,
        keyVersion: "v1",
        lifetimeSeconds: 600,
        maxAttempts: 2
      });
      await context().migration.query(
        "UPDATE platform.mfa_enrollments SET created_at = clock_timestamp() - interval '20 minutes', expires_at = clock_timestamp() - interval '10 minutes' WHERE id = $1",
        [expired.id]
      );
      await expect(repositories().mfa.recordEnrollmentAttempt(expired.id)).resolves.toBeUndefined();
      await expect(repositories().mfa.completeEnrollment(expired.id)).resolves.toBeUndefined();
    });

    it("persists TOTP credentials and consumes one recovery code exactly once across independent connections", async () => {
      const user = await context().createUser();
      const encryptedSecret = randomBytes(52);
      const credential = await repositories().mfa.saveTotpCredential({
        userId: user.id,
        encryptedSecret,
        keyVersion: "v1"
      });
      expectCopiedBuffer(credential.encryptedSecret, encryptedSecret);
      await expect(repositories().mfa.findTotpCredentialByUserId(user.id)).resolves.toEqual(credential);

      const codeHash = randomBytes(32);
      const records = await repositories().mfa.addRecoveryCodes(user.id, [{ keyVersion: "v1", hash: codeHash }]);
      expectCopiedBuffer(records[0]!.codeHash, codeHash);
      const repoA = options.createRepositories(context().concurrentA).mfa;
      const repoB = options.createRepositories(context().concurrentB).mfa;
      const results = await Promise.all([
        repoA.consumeRecoveryCode(user.id, "v1", codeHash),
        repoB.consumeRecoveryCode(user.id, "v1", codeHash)
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((value) => value === undefined)).toHaveLength(1);
    });

    it("looks sessions up by hash, enforces both expirations, throttles touch writes, and revokes idempotently", async () => {
      const user = await context().createUser();
      const tokenHash = randomBytes(32);
      const session = await repositories().sessions.create({
        userId: user.id,
        tokenHash,
        absoluteLifetimeSeconds: 3600,
        idleLifetimeSeconds: 900,
        clientSummary: "contract"
      });
      expectCopiedBuffer(session.tokenHash, tokenHash);
      expect(session.absoluteExpiresAt.getTime() - session.createdAt.getTime()).toBe(3_600_000);
      expect(session.idleExpiresAt.getTime() - session.createdAt.getTime()).toBe(900_000);
      await expect(repositories().sessions.findActiveByTokenHash(tokenHash)).resolves.toEqual(session);
      await expect(repositories().sessions.touch(session.id, 900)).resolves.toBeUndefined();
      const before = await context().migration.query<{ last_touch_at: Date }>(
        "SELECT last_touch_at FROM platform.sessions WHERE id = $1",
        [session.id]
      );
      await Promise.all([
        options.createRepositories(context().concurrentA).sessions.touch(session.id, 900),
        options.createRepositories(context().concurrentB).sessions.touch(session.id, 900)
      ]);
      const after = await context().migration.query<{ last_touch_at: Date }>(
        "SELECT last_touch_at FROM platform.sessions WHERE id = $1",
        [session.id]
      );
      expect(after.rows[0]!.last_touch_at).toEqual(before.rows[0]!.last_touch_at);

      await context().migration.query(
        `WITH times AS (SELECT clock_timestamp() AS now)
         UPDATE platform.sessions SET created_at = times.now - interval '10 minutes',
           last_touch_at = times.now - interval '6 minutes', last_activity_at = times.now - interval '6 minutes'
         FROM times WHERE id = $1`,
        [session.id]
      );
      const touches = await Promise.all([
        options.createRepositories(context().concurrentA).sessions.touch(session.id, 1800),
        options.createRepositories(context().concurrentB).sessions.touch(session.id, 1800)
      ]);
      expect(touches.filter(Boolean)).toHaveLength(1);
      expect(touches.filter((value) => value === undefined)).toHaveLength(1);
      const touched = touches.find(Boolean)!;
      expect(touched?.idleExpiresAt.getTime()).toBeLessThanOrEqual(touched!.absoluteExpiresAt.getTime());
      await expect(repositories().sessions.revoke(session.id)).resolves.toMatchObject({ id: session.id });
      await expect(repositories().sessions.revoke(session.id)).resolves.toBeUndefined();
      await expect(repositories().sessions.findActiveByTokenHash(tokenHash)).resolves.toBeUndefined();

      const expired = await repositories().sessions.create({
        userId: user.id,
        tokenHash: randomBytes(32),
        absoluteLifetimeSeconds: 3600,
        idleLifetimeSeconds: 900
      });
      await context().migration.query(
        `WITH times AS (SELECT clock_timestamp() AS now)
         UPDATE platform.sessions SET created_at = times.now - interval '2 hours',
           absolute_expires_at = times.now - interval '1 hour', idle_expires_at = times.now - interval '70 minutes',
           last_activity_at = times.now - interval '80 minutes', last_touch_at = times.now - interval '80 minutes'
         FROM times WHERE id = $1`,
        [expired.id]
      );
      await expect(repositories().sessions.findActiveByTokenHash(expired.tokenHash)).resolves.toBeUndefined();

      const idleExpired = await repositories().sessions.create({
        userId: user.id,
        tokenHash: randomBytes(32),
        absoluteLifetimeSeconds: 3600,
        idleLifetimeSeconds: 900
      });
      await context().migration.query(
        `WITH times AS (SELECT clock_timestamp() AS now)
         UPDATE platform.sessions
         SET created_at = times.now - interval '2 hours',
             absolute_expires_at = times.now + interval '1 hour',
             idle_expires_at = times.now - interval '30 minutes',
             last_activity_at = times.now - interval '1 hour',
             last_touch_at = times.now - interval '1 hour'
         FROM times WHERE id = $1`,
        [idleExpired.id]
      );
      await expect(repositories().sessions.findActiveByTokenHash(idleExpired.tokenHash)).resolves.toBeUndefined();
      await expect(repositories().sessions.touch(idleExpired.id, 900)).resolves.toBeUndefined();
    });

    it("atomically increments typed rate-limit buckets without losing concurrent attempts", async () => {
      const key = randomBytes(16);
      const increment = (executor: QueryExecutor, bucketType: "account" | "ip-prefix", bucketKey: Buffer) =>
        options.createRepositories(executor).rateLimits.increment({
          bucketType,
          bucketKey,
          windowSeconds: 60,
          limit: 10,
          blockSeconds: 120
        });

      const results = await Promise.all([
        increment(context().concurrentA, "account", key),
        increment(context().concurrentB, "account", key),
        increment(context().primary, "account", key)
      ]);
      expect(results.map((result) => result.attemptCount).sort()).toEqual([1, 2, 3]);
      for (const result of results) expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(result.windowStartedAt.getTime());
      await expect(increment(context().primary, "ip-prefix", key)).resolves.toMatchObject({ attemptCount: 1 });
      await expect(increment(context().primary, "ip-prefix", Buffer.concat([key, Buffer.from([1])]))).resolves.toMatchObject({ attemptCount: 1 });

      await context().migration.query(
        "UPDATE platform.security_rate_limit_buckets SET window_started_at = clock_timestamp() - interval '2 minutes', updated_at = clock_timestamp() - interval '2 minutes' WHERE bucket_type = 'account' AND bucket_key = $1",
        [key]
      );
      await expect(increment(context().primary, "account", key)).resolves.toMatchObject({ attemptCount: 1 });

      const blockedKey = randomBytes(16);
      const limitedIncrement = () => repositories().rateLimits.increment({
        bucketType: "account",
        bucketKey: blockedKey,
        windowSeconds: 60,
        limit: 2,
        blockSeconds: 120
      });
      await expect(limitedIncrement()).resolves.toMatchObject({ attemptCount: 1, blocked: false });
      const blocked = await limitedIncrement();
      expect(blocked).toMatchObject({ attemptCount: 2, blocked: true });
      expect(blocked.blockedUntil).toBeInstanceOf(Date);
      const continued = await limitedIncrement();
      expect(continued).toMatchObject({ attemptCount: 3, blocked: true });
      expect(continued.blockedUntil!.getTime()).toBeGreaterThanOrEqual(blocked.blockedUntil!.getTime());
      expect(continued.blockedUntil!.getTime()).toBeGreaterThanOrEqual(continued.updatedAt.getTime());
      await context().migration.query(
        `UPDATE platform.security_rate_limit_buckets
         SET window_started_at = clock_timestamp() - interval '3 minutes',
             blocked_until = clock_timestamp() - interval '1 minute',
             updated_at = clock_timestamp()
         WHERE bucket_type = 'account' AND bucket_key = $1`,
        [blockedKey]
      );
      await expect(limitedIncrement()).resolves.toMatchObject({ attemptCount: 1, blocked: false, blockedUntil: null });
    });

    it("revokes all sessions for one user in one idempotent operation", async () => {
      const user = await context().createUser();
      const otherUser = await context().createUser();
      const createSession = (userId: string, tokenHash: Buffer) => repositories().sessions.create({
        userId,
        tokenHash,
        absoluteLifetimeSeconds: 3600,
        idleLifetimeSeconds: 900
      });
      const firstHash = randomBytes(32);
      const secondHash = randomBytes(32);
      const otherHash = randomBytes(32);
      await Promise.all([
        createSession(user.id, firstHash),
        createSession(user.id, secondHash),
        createSession(otherUser.id, otherHash)
      ]);

      await expect(repositories().sessions.revokeAllForUser(user.id)).resolves.toBe(2);
      await expect(repositories().sessions.revokeAllForUser(user.id)).resolves.toBe(0);
      await expect(repositories().sessions.findActiveByTokenHash(firstHash)).resolves.toBeUndefined();
      await expect(repositories().sessions.findActiveByTokenHash(secondHash)).resolves.toBeUndefined();
      await expect(repositories().sessions.findActiveByTokenHash(otherHash)).resolves.toMatchObject({ userId: otherUser.id });
    });

    it("copies mutable bytea inputs before an asynchronous executor can observe caller mutations", async () => {
      const user = await context().createUser();
      const source = randomBytes(32);
      const expected = Buffer.from(source);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const delayedExecutor: QueryExecutor = {
        async query(text, values) {
          await gate;
          return context().primary.query(text, values);
        }
      };
      const creation = options.createRepositories(delayedExecutor).sessions.create({
        userId: user.id,
        tokenHash: source,
        absoluteLifetimeSeconds: 3600,
        idleLifetimeSeconds: 900
      });
      source.fill(0);
      release();

      const session = await creation;
      expect(session.tokenHash).toEqual(expected);
      await expect(repositories().sessions.findActiveByTokenHash(expected)).resolves.toMatchObject({ id: session.id });
    });

    it("validates audit metadata, provides bounded reads, and exposes no mutation capability", async () => {
      const user = await context().createUser();
      const metadata = { reason: "contract", ipPrefix: "203.0.113.0/24" } as const;
      const event = await repositories().audit.append({
        actorUserId: user.id,
        actorType: "user",
        action: "session.created",
        targetType: "session",
        targetId: null,
        requestId: `request-${user.id}`,
        result: "success",
        metadata
      });
      expect(event.metadata).toEqual(metadata);
      expect(event.metadata).not.toBe(metadata);
      await expect(repositories().audit.list({ requestId: event.requestId, limit: 500 })).resolves.toEqual([event]);
      await expect(
        repositories().audit.append({
          actorUserId: user.id,
          actorType: "user",
          action: "invalid",
          targetType: "user",
          targetId: user.id,
          requestId: "invalid-metadata",
          result: "denied",
          metadata: { token: "secret" } as never
        })
      ).rejects.toThrow("INVALID_AUDIT_METADATA_KEY");
      await expect(
        repositories().audit.append({
          actorUserId: user.id,
          actorType: "user",
          action: "invalid",
          targetType: "user",
          targetId: user.id,
          requestId: "invalid-value",
          result: "denied",
          metadata: { reason: { nested: true } } as never
        })
      ).rejects.toThrow("INVALID_AUDIT_METADATA_VALUE");
      expect("update" in repositories().audit).toBe(false);
      expect("delete" in repositories().audit).toBe(false);
    });

    it("keeps audit events append-only for the real platform_web role", async () => {
      await expect(context().primary.query("UPDATE platform.audit_events SET result = 'error'")).rejects.toMatchObject({ code: "42501" });
      await expect(context().primary.query("DELETE FROM platform.audit_events")).rejects.toMatchObject({ code: "42501" });
    });
  });
}
