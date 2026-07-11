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
  runTransaction<T>(
    connection: "primary" | "concurrentA" | "concurrentB",
    callback: (executor: QueryExecutor) => Promise<T>
  ): Promise<T>;
  consumeInvitation(executor: QueryExecutor, invitationId: string, acceptedByUserId: string): Promise<boolean>;
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

    it("uses one captured database instant for each challenge and enrollment completion", async () => {
      const user = await context().createUser();
      const challenge = await repositories().mfa.createChallenge({
        userId: user.id,
        tokenHash: randomBytes(32),
        lifetimeSeconds: 300,
        maxAttempts: 3
      });
      const invitation = await context().createInvitation();
      const enrollment = await repositories().mfa.createEnrollment({
        invitationId: invitation.id,
        tokenHash: randomBytes(32),
        encryptedTotpSecret: randomBytes(48),
        keyVersion: "v1",
        lifetimeSeconds: 600,
        maxAttempts: 3
      });
      const completionSql: string[] = [];
      const observedExecutor: QueryExecutor = {
        query(text, values) {
          completionSql.push(text);
          return context().primary.query(text, values);
        }
      };
      const mfa = options.createRepositories(observedExecutor).mfa;
      await mfa.completeChallenge(challenge.id);
      await mfa.completeEnrollment(enrollment.id);

      expect(completionSql).toHaveLength(2);
      for (const sql of completionSql) {
        expect(sql).toContain("WITH times AS (SELECT clock_timestamp() AS now)");
        expect(sql).toContain("SET completed_at = times.now");
        expect(sql).toContain("expires_at > times.now");
        expect(sql.match(/clock_timestamp\(\)/g)).toHaveLength(1);
      }
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

    it("replaces active and expired open enrollments by invitation inside a service transaction", async () => {
      const prepare = (invitationId: string, tokenHash: Buffer) => context().runTransaction("primary", async (executor) => {
        const mfa = options.createRepositories(executor).mfa;
        expect(await mfa.lockActiveInvitationForEnrollment(invitationId)).toBe(true);
        const invalidatedCount = await mfa.invalidateOpenEnrollmentsForInvitation(invitationId);
        const enrollment = await mfa.createEnrollment({
          invitationId,
          tokenHash,
          encryptedTotpSecret: randomBytes(48),
          keyVersion: "v1",
          lifetimeSeconds: 600,
          maxAttempts: 3
        });
        return { enrollment, invalidatedCount };
      });

      const activeInvitation = await context().createInvitation();
      const active = await repositories().mfa.createEnrollment({
        invitationId: activeInvitation.id,
        tokenHash: randomBytes(32),
        encryptedTotpSecret: randomBytes(48),
        keyVersion: "v1",
        lifetimeSeconds: 600,
        maxAttempts: 3
      });
      const activeReplacement = await prepare(activeInvitation.id, randomBytes(32));
      expect(activeReplacement.invalidatedCount).toBe(1);
      await expect(repositories().mfa.findActiveEnrollmentByTokenHash(active.tokenHash)).resolves.toBeUndefined();
      await expect(repositories().mfa.findActiveEnrollmentByTokenHash(activeReplacement.enrollment.tokenHash))
        .resolves.toMatchObject({ id: activeReplacement.enrollment.id });
      await repositories().mfa.completeEnrollment(activeReplacement.enrollment.id);
      const afterCompleted = await prepare(activeInvitation.id, randomBytes(32));
      expect(afterCompleted.invalidatedCount).toBe(0);
      const completedRow = await context().migration.query<{ invalidated_at: Date | null; completed_at: Date | null }>(
        "SELECT invalidated_at, completed_at FROM platform.mfa_enrollments WHERE id = $1",
        [activeReplacement.enrollment.id]
      );
      expect(completedRow.rows[0]).toMatchObject({ invalidated_at: null });
      expect(completedRow.rows[0]!.completed_at).toBeInstanceOf(Date);

      const expiredInvitation = await context().createInvitation();
      const expired = await repositories().mfa.createEnrollment({
        invitationId: expiredInvitation.id,
        tokenHash: randomBytes(32),
        encryptedTotpSecret: randomBytes(48),
        keyVersion: "v1",
        lifetimeSeconds: 600,
        maxAttempts: 3
      });
      await context().migration.query(
        "UPDATE platform.mfa_enrollments SET created_at = clock_timestamp() - interval '20 minutes', expires_at = clock_timestamp() - interval '10 minutes' WHERE id = $1",
        [expired.id]
      );
      const expiredReplacement = await prepare(expiredInvitation.id, randomBytes(32));
      expect(expiredReplacement.invalidatedCount).toBe(1);
      await expect(repositories().mfa.findActiveEnrollmentByTokenHash(expiredReplacement.enrollment.tokenHash))
        .resolves.toMatchObject({ id: expiredReplacement.enrollment.id });
    });

    it("serializes concurrent enrollment prepare transactions on the invitation row", async () => {
      const invitation = await context().createInvitation();
      const tokenA = randomBytes(32);
      const tokenB = randomBytes(32);
      let signalFirstLocked!: () => void;
      let releaseFirst!: () => void;
      let signalSecondLockRequested!: () => void;
      const firstLocked = new Promise<void>((resolve) => { signalFirstLocked = resolve; });
      const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const secondLockRequested = new Promise<void>((resolve) => { signalSecondLockRequested = resolve; });
      const createAfterLock = async (mfa: MfaRepository, tokenHash: Buffer) => {
        await mfa.invalidateOpenEnrollmentsForInvitation(invitation.id);
        return mfa.createEnrollment({
          invitationId: invitation.id,
          tokenHash,
          encryptedTotpSecret: randomBytes(48),
          keyVersion: "v1",
          lifetimeSeconds: 600,
          maxAttempts: 3
        });
      };
      const first = context().runTransaction("concurrentA", async (executor) => {
        const mfa = options.createRepositories(executor).mfa;
        if (!await mfa.lockActiveInvitationForEnrollment(invitation.id)) throw new Error("INVITATION_NOT_ACTIVE");
        signalFirstLocked();
        await firstCanFinish;
        return createAfterLock(mfa, tokenA);
      });
      await firstLocked;
      const second = context().runTransaction("concurrentB", async (executor) => {
        const observedExecutor: QueryExecutor = {
          query(text, values) {
            if (text.includes("FOR UPDATE")) signalSecondLockRequested();
            return executor.query(text, values);
          }
        };
        const mfa = options.createRepositories(observedExecutor).mfa;
        if (!await mfa.lockActiveInvitationForEnrollment(invitation.id)) throw new Error("INVITATION_NOT_ACTIVE");
        return createAfterLock(mfa, tokenB);
      });
      await secondLockRequested;
      releaseFirst();
      const created = await Promise.all([first, second]);

      const rows = await context().migration.query<{
        id: string; invalidated_at: Date | null; completed_at: Date | null;
      }>(
        `SELECT id, invalidated_at, completed_at FROM platform.mfa_enrollments
         WHERE invitation_id = $1 ORDER BY created_at, id`,
        [invitation.id]
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.filter((row) => row.invalidated_at === null && row.completed_at === null)).toHaveLength(1);
      expect(rows.rows.filter((row) => row.invalidated_at instanceof Date)).toHaveLength(1);
      const lookups = await Promise.all(created.map((enrollment) =>
        repositories().mfa.findActiveEnrollmentByTokenHash(enrollment.tokenHash)));
      expect(lookups.filter(Boolean)).toHaveLength(1);
      expect(lookups.filter((value) => value === undefined)).toHaveLength(1);
    });

    it("serializes enrollment completion and invitation consumption before a concurrent prepare", async () => {
      const invitation = await context().createInvitation();
      const acceptedBy = await context().createUser();
      const enrollment = await repositories().mfa.createEnrollment({
        invitationId: invitation.id,
        tokenHash: randomBytes(32),
        encryptedTotpSecret: randomBytes(48),
        keyVersion: "v1",
        lifetimeSeconds: 600,
        maxAttempts: 3
      });
      let signalCompletionLocked!: () => void;
      let releaseCompletion!: () => void;
      let signalPrepareLockRequested!: () => void;
      const completionLocked = new Promise<void>((resolve) => { signalCompletionLocked = resolve; });
      const completionCanFinish = new Promise<void>((resolve) => { releaseCompletion = resolve; });
      const prepareLockRequested = new Promise<void>((resolve) => { signalPrepareLockRequested = resolve; });

      const completion = context().runTransaction("concurrentA", async (executor) => {
        const mfa = options.createRepositories(executor).mfa;
        if (!await mfa.lockActiveInvitationForEnrollment(invitation.id)) throw new Error("INVITATION_NOT_ACTIVE");
        signalCompletionLocked();
        await completionCanFinish;
        const completed = await mfa.completeEnrollment(enrollment.id);
        const consumed = await context().consumeInvitation(executor, invitation.id, acceptedBy.id);
        return { completed, consumed };
      });
      await completionLocked;
      const prepare = context().runTransaction("concurrentB", async (executor) => {
        const observedExecutor: QueryExecutor = {
          query(text, values) {
            if (text.includes("FOR UPDATE")) signalPrepareLockRequested();
            return executor.query(text, values);
          }
        };
        const mfa = options.createRepositories(observedExecutor).mfa;
        const locked = await mfa.lockActiveInvitationForEnrollment(invitation.id);
        if (!locked) return undefined;
        await mfa.invalidateOpenEnrollmentsForInvitation(invitation.id);
        return mfa.createEnrollment({
          invitationId: invitation.id,
          tokenHash: randomBytes(32),
          encryptedTotpSecret: randomBytes(48),
          keyVersion: "v1",
          lifetimeSeconds: 600,
          maxAttempts: 3
        });
      });
      await prepareLockRequested;
      releaseCompletion();
      const [completionResult, prepareResult] = await Promise.all([completion, prepare]);

      expect(completionResult.completed).toMatchObject({ id: enrollment.id });
      expect(completionResult.consumed).toBe(true);
      expect(prepareResult).toBeUndefined();
      const rows = await context().migration.query<{ id: string; completed_at: Date | null }>(
        "SELECT id, completed_at FROM platform.mfa_enrollments WHERE invitation_id = $1",
        [invitation.id]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.completed_at).toBeInstanceOf(Date);
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

    it("rejects fail-open rate-limit policies and invalid bucket identities before querying PostgreSQL", async () => {
      const valid = {
        bucketType: "account" as const,
        bucketKey: randomBytes(16),
        windowSeconds: 60,
        limit: 5,
        blockSeconds: 120
      };
      const invalidNumbers = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5];
      for (const field of ["windowSeconds", "limit", "blockSeconds"] as const) {
        for (const value of invalidNumbers) {
          await expect(repositories().rateLimits.increment({ ...valid, [field]: value }))
            .rejects.toThrow("INVALID_RATE_LIMIT_POLICY");
        }
      }
      await expect(repositories().rateLimits.increment({ ...valid, bucketType: "email" as never }))
        .rejects.toThrow("INVALID_RATE_LIMIT_BUCKET");
      await expect(repositories().rateLimits.increment({ ...valid, bucketKey: Buffer.alloc(0) }))
        .rejects.toThrow("INVALID_RATE_LIMIT_BUCKET");
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

    it("rejects invalid audit limits before querying PostgreSQL", async () => {
      for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
        await expect(repositories().audit.list({ limit })).rejects.toThrow("INVALID_AUDIT_LIMIT");
      }
    });

    it("copies the audit cursor Date before an asynchronous executor can observe caller mutations", async () => {
      const user = await context().createUser();
      const event = await repositories().audit.append({
        actorUserId: user.id,
        actorType: "user",
        action: "audit.cursor.tested",
        targetType: "user",
        targetId: user.id,
        requestId: `audit-cursor-${user.id}`,
        result: "success",
        metadata: { reason: "cursor-copy" }
      });
      const beforeOccurredAt = new Date(Date.now() + 60_000);
      const expectedCursorTime = beforeOccurredAt.getTime();
      let capturedValues: readonly unknown[] | undefined;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const delayedExecutor: QueryExecutor = {
        async query(text, values) {
          capturedValues = values;
          await gate;
          return context().primary.query(text, values);
        }
      };
      const listing = options.createRepositories(delayedExecutor).audit.list({ beforeOccurredAt, limit: 10 });
      beforeOccurredAt.setTime(0);
      release();
      const events = await listing;

      expect(events.some((candidate) => candidate.id === event.id)).toBe(true);
      const capturedDate = capturedValues?.find((value) => value instanceof Date);
      expect(capturedDate).toBeInstanceOf(Date);
      expect((capturedDate as Date).getTime()).toBe(expectedCursorTime);
    });

    it("keeps audit events append-only for the real platform_web role", async () => {
      await expect(context().primary.query("UPDATE platform.audit_events SET result = 'error'")).rejects.toMatchObject({ code: "42501" });
      await expect(context().primary.query("DELETE FROM platform.audit_events")).rejects.toMatchObject({ code: "42501" });
    });
  });
}
