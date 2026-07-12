import { z } from "zod";
import type { VersionedKeyring } from "../../platform/config/types.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";
import type { QueryExecutor } from "../../platform/database/queryExecutor.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import {
  passwordHashMatchesOptions,
  verifyPassword,
  type Argon2idOptions
} from "../../platform/security/passwords.ts";
import { createRateLimitService, RateLimitServiceError } from "../../platform/security/rateLimitService.ts";
import { hashRecoveryCode, RecoveryCodeError } from "../../platform/security/recoveryCodes.ts";
import { decryptSecret } from "../../platform/security/secretEncryption.ts";
import { generateOpaqueToken, hashOpaqueToken, verifyOpaqueToken } from "../../platform/security/tokenHash.ts";
import { verifyTotp } from "../../platform/security/totp.ts";
import { createSessionService } from "../../platform/security/sessionService.ts";
import { normalizeEmail } from "./email.ts";
import type { PlatformUser } from "./models.ts";
import { PostgresAuditRepository } from "./repositories/postgres/PostgresAuditRepository.ts";
import { PostgresMfaRepository } from "./repositories/postgres/PostgresMfaRepository.ts";
import { PostgresUserRepository } from "./repositories/postgres/PostgresUserRepository.ts";

const emailSchema = z.string().max(254).email();
const RATE_LIMIT_POLICY = { windowSeconds: 15 * 60, limit: 10, blockSeconds: 15 * 60 } as const;
const MFA_CHALLENGE_LIFETIME_SECONDS = 5 * 60;
const MFA_CHALLENGE_MAX_ATTEMPTS = 5;
const MAX_PASSWORD_BYTES = 256;
const MAX_TOKEN_BYTES = 256;
const MAX_REQUEST_ID_BYTES = 200;
const MAX_CLIENT_SUMMARY_BYTES = 200;

export const AUTHENTICATION_DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$rUGf7HCiiHaKSmXoxVCJGA$y/CRugqFEn15nKRtAD1mCOQUYjNQriOuHh1kLhe+heA";

export type AuthenticatedUser = Omit<PlatformUser, "passwordHash">;

export class AuthenticationServiceError extends Error {
  constructor(readonly code:
    | "AUTHENTICATION_INPUT_INVALID"
    | "AUTHENTICATION_INVALID_CREDENTIALS"
    | "AUTHENTICATION_MFA_INVALID"
    | "AUTHENTICATION_RATE_LIMITED"
    | "AUTHENTICATION_SECURITY_DEPENDENCY_UNAVAILABLE", options?: ErrorOptions) {
    super(code, options);
    this.name = "AuthenticationServiceError";
  }
}

type SecurityLogger = {
  error(event: { readonly requestId: string; readonly userId?: string; readonly code: string }): void;
};

type Options = {
  readonly pool: PlatformPool;
  readonly keyrings: {
    readonly totpEncryption: VersionedKeyring;
    readonly recoveryHmac: VersionedKeyring;
  };
  readonly passwordHashOptions: Argon2idOptions;
  readonly dummyPasswordHash?: string;
  readonly verifyPassword?: typeof verifyPassword;
  readonly verifyTotp?: typeof verifyTotp;
  readonly decryptSecret?: typeof decryptSecret;
  readonly generateOpaqueToken?: () => string;
  readonly logger?: SecurityLogger;
};

export function createAuthenticationService(options: Options) {
  const dummyPasswordHash = options?.dummyPasswordHash ?? AUTHENTICATION_DUMMY_PASSWORD_HASH;
  if (!options?.pool || !options.keyrings || !options.passwordHashOptions ||
      !passwordHashMatchesOptions(dummyPasswordHash, options.passwordHashOptions)) {
    throw new AuthenticationServiceError("AUTHENTICATION_INPUT_INVALID");
  }
  const passwordVerifier = options.verifyPassword ?? verifyPassword;
  const totpVerifier = options.verifyTotp ?? verifyTotp;
  const decryptTotpSecret = options.decryptSecret ?? decryptSecret;
  const makeToken = options.generateOpaqueToken ?? generateOpaqueToken;
  const logger = options.logger ?? { error() {} };
  const rateLimits = createRateLimitService({ pool: options.pool });
  const sessions = createSessionService({ pool: options.pool });

  return Object.freeze({
    async login(input: {
      readonly email: string;
      readonly password: string;
      readonly sourceIpPrefix: string;
      readonly requestId: string;
      readonly clientSummary?: string;
    }): Promise<{ readonly next: "mfa"; readonly challengeToken: string }> {
      const context = ownContext(input?.requestId, input?.clientSummary);
      await enforceIp(rateLimits, logger, context, "authentication.login", input?.sourceIpPrefix);
      const normalizedEmail = ownEmailForLookup(input?.email);
      let user: PlatformUser | undefined;
      try {
        user = normalizedEmail ? await new PostgresUserRepository(options.pool).findByEmail(normalizedEmail) : undefined;
      } catch (error) {
        throw dependencyUnavailable(logger, context, undefined, "AUTHENTICATION_USER_LOOKUP_UNAVAILABLE", error);
      }
      if (user) await enforceAccount(rateLimits, logger, context, "authentication.login", user.id);
      const password = ownLoginPassword(input?.password);
      if (password === undefined) {
        await recordPasswordFailure(options.pool, logger, context, user, input?.sourceIpPrefix);
        throw invalidCredentials();
      }

      let matches = false;
      try {
        matches = await passwordVerifier(user?.passwordHash ?? dummyPasswordHash, password);
      } catch (error) {
        throw dependencyUnavailable(logger, context, user?.id, "AUTHENTICATION_PASSWORD_VERIFIER_UNAVAILABLE", error);
      }
      if (!matches || !isActiveMfaUser(user)) {
        await recordPasswordFailure(options.pool, logger, context, user, input.sourceIpPrefix);
        throw invalidCredentials();
      }

      const challengeToken = makeToken();
      const challengeHash = ownGeneratedToken(challengeToken);
      try {
        try {
          await withTransaction(options.pool, async (transaction) => {
            const locked = await new PostgresUserRepository(transaction).lockById(user.id);
            if (!isActiveMfaUser(locked) || locked.passwordHash !== user.passwordHash) throw invalidCredentials();
            const challenge = await new PostgresMfaRepository(transaction).createChallenge({
              userId: user.id,
              tokenHash: challengeHash,
              lifetimeSeconds: MFA_CHALLENGE_LIFETIME_SECONDS,
              maxAttempts: MFA_CHALLENGE_MAX_ATTEMPTS
            });
            await new PostgresAuditRepository(transaction).append({
              actorUserId: user.id,
              actorType: "user",
              action: "authentication.password",
              targetType: "mfa_challenge",
              targetId: challenge.id,
              requestId: context.requestId,
              result: "success",
              metadata: auditMetadata(input.sourceIpPrefix, context.clientSummary, undefined, "password-verified")
            });
          });
        } catch (error) {
          if (error instanceof AuthenticationServiceError && error.code === "AUTHENTICATION_INVALID_CREDENTIALS") {
            await recordPasswordFailure(options.pool, logger, context, user, input.sourceIpPrefix);
            throw error;
          }
          throw dependencyUnavailable(logger, context, user.id, "AUTHENTICATION_LOGIN_TRANSACTION_UNAVAILABLE", error);
        }
        return Object.freeze({ next: "mfa" as const, challengeToken });
      } finally {
        challengeHash.fill(0);
      }
    },

    async completeMfa(input: {
      readonly challengeToken: string;
      readonly factor: { readonly method: "totp" | "recovery"; readonly code: string };
      readonly sourceIpPrefix: string;
      readonly requestId: string;
      readonly clientSummary?: string;
    }): Promise<{ readonly sessionToken: string; readonly user: AuthenticatedUser }> {
      const context = ownContext(input?.requestId, input?.clientSummary);
      await enforceIp(rateLimits, logger, context, "authentication.mfa", input?.sourceIpPrefix);
      const challengeToken = ownToken(input?.challengeToken);
      const challengeHash = hashOpaqueToken(challengeToken);
      const recoveryCandidates: Array<{ keyVersion: string; hash: Buffer }> = [];
      let secret: Buffer | undefined;
      let user: PlatformUser | undefined;
      try {
        const mfa = new PostgresMfaRepository(options.pool);
        const challenge = await mfa.findActiveChallengeByTokenHash(challengeHash);
        if (!challenge || !verifyOpaqueToken(challengeToken, challenge.tokenHash)) {
          await recordUnknownMfaFailure(options.pool, logger, context, input.sourceIpPrefix);
          throw mfaInvalid();
        }
        user = await new PostgresUserRepository(options.pool).findById(challenge.userId);
        if (!user) {
          await recordUnknownMfaFailure(options.pool, logger, context, input.sourceIpPrefix);
          throw mfaInvalid();
        }
        await enforceAccount(rateLimits, logger, context, "authentication.mfa", user.id);
        const rawFactor = input?.factor;
        let factor: { method: "totp" | "recovery"; code: string };
        try {
          factor = ownFactor(rawFactor);
        } catch (error) {
          if (!(error instanceof AuthenticationServiceError) || error.code !== "AUTHENTICATION_MFA_INVALID") throw error;
          await recordKnownMfaFailure(options.pool, logger, context, challenge.id, user.id,
            input.sourceIpPrefix, knownFactorMethod(rawFactor), "factor-malformed");
          throw error;
        }
        let factorValid = false;
        if (factor.method === "totp") {
          const credential = await mfa.findTotpCredentialByUserId(user.id);
          if (credential) {
            try {
              secret = decryptTotpSecret({ encryptedSecret: credential.encryptedSecret,
                keyVersion: credential.keyVersion }, options.keyrings.totpEncryption);
              factorValid = totpVerifier(secret, factor.code, Date.now());
            } catch (error) {
              throw dependencyUnavailable(logger, context, user.id, "AUTHENTICATION_TOTP_DEPENDENCY_UNAVAILABLE", error);
            }
          }
        } else {
          try {
            for (const keyVersion of options.keyrings.recoveryHmac.keys.keys()) {
              recoveryCandidates.push(hashRecoveryCode(factor.code, options.keyrings.recoveryHmac, keyVersion));
            }
          } catch (error) {
            if (!(error instanceof RecoveryCodeError)) throw error;
          }
          factorValid = recoveryCandidates.length > 0;
        }

        const sessionToken = makeToken();
        const sessionHash = ownGeneratedToken(sessionToken);
        try {
          let result: { user: PlatformUser } | undefined;
          try {
            result = await withTransaction(options.pool, async (transaction) => {
              const txUsers = new PostgresUserRepository(transaction);
              const lockedUser = await txUsers.lockById(user!.id);
              if (!isActiveMfaUser(lockedUser)) return recordMfaFailureInTransaction(
                transaction, challenge.id, user!.id, context, input.sourceIpPrefix, factor.method, "user-inactive"
              );
              const txMfa = new PostgresMfaRepository(transaction);
              if (!factorValid) return recordMfaFailureInTransaction(
                transaction, challenge.id, user!.id, context, input.sourceIpPrefix, factor.method, "factor-invalid"
              );
              if (factor.method === "recovery") {
                let consumed = false;
                for (const candidate of recoveryCandidates) {
                  if (await txMfa.consumeRecoveryCode(user!.id, candidate.keyVersion, candidate.hash)) {
                    consumed = true;
                    break;
                  }
                }
                if (!consumed) return recordMfaFailureInTransaction(
                  transaction, challenge.id, user!.id, context, input.sourceIpPrefix, factor.method, "factor-invalid"
                );
              }
              const completed = await txMfa.completeChallenge(challenge.id);
              if (!completed) throw mfaInvalid();
              const session = await sessions.createInTransaction(transaction, {
                userId: user!.id,
                tokenHash: sessionHash,
                clientSummary: context.clientSummary
              });
              await new PostgresAuditRepository(transaction).append({
                actorUserId: user!.id,
                actorType: "user",
                action: factor.method === "totp" ? "authentication.mfa" : "authentication.recovery",
                targetType: "session",
                targetId: session.id,
                requestId: context.requestId,
                result: "success",
                metadata: auditMetadata(input.sourceIpPrefix, context.clientSummary, factor.method)
              });
              return { user: lockedUser };
            });
          } catch (error) {
            if (error instanceof AuthenticationServiceError && error.code === "AUTHENTICATION_MFA_INVALID") {
              await recordKnownMfaFailure(options.pool, logger, context, challenge.id, user.id,
                input.sourceIpPrefix, factor.method, "challenge-used");
              throw error;
            }
            throw dependencyUnavailable(logger, context, user.id, "AUTHENTICATION_MFA_TRANSACTION_UNAVAILABLE", error);
          }
          if (!result) throw mfaInvalid();
          return Object.freeze({ sessionToken, user: publicUser(result.user) });
        } finally {
          sessionHash.fill(0);
        }
      } catch (error) {
        if (error instanceof AuthenticationServiceError) throw error;
        throw dependencyUnavailable(logger, context, user?.id, "AUTHENTICATION_MFA_LOOKUP_UNAVAILABLE", error);
      } finally {
        challengeHash.fill(0);
        secret?.fill(0);
        for (const candidate of recoveryCandidates) candidate.hash.fill(0);
      }
    }
  });
}

type AuthenticationContext = { requestId: string; clientSummary?: string };
type RateLimits = ReturnType<typeof createRateLimitService>;

async function enforceIp(rateLimits: RateLimits, logger: SecurityLogger, context: AuthenticationContext,
  operation: string, sourceIpPrefix: unknown) {
  try {
    const decision = await rateLimits.consumeIp({ operation, sourceIpPrefix: sourceIpPrefix as string,
      policy: RATE_LIMIT_POLICY });
    if (decision.blocked) throw new AuthenticationServiceError("AUTHENTICATION_RATE_LIMITED");
  } catch (error) {
    if (error instanceof AuthenticationServiceError) throw error;
    if (error instanceof RateLimitServiceError && error.code !== "RATE_LIMIT_DEPENDENCY_UNAVAILABLE") {
      throw new AuthenticationServiceError("AUTHENTICATION_INPUT_INVALID", { cause: error });
    }
    throw dependencyUnavailable(logger, context, undefined, "AUTHENTICATION_RATE_LIMIT_UNAVAILABLE", error);
  }
}

async function enforceAccount(rateLimits: RateLimits, logger: SecurityLogger, context: AuthenticationContext,
  operation: string, userId: string) {
  try {
    const decision = await rateLimits.consumeAccount({ operation, accountKey: Buffer.from(userId, "utf8"),
      policy: RATE_LIMIT_POLICY });
    if (decision.blocked) throw new AuthenticationServiceError("AUTHENTICATION_RATE_LIMITED");
  } catch (error) {
    if (error instanceof AuthenticationServiceError) throw error;
    if (error instanceof RateLimitServiceError && error.code !== "RATE_LIMIT_DEPENDENCY_UNAVAILABLE") {
      throw new AuthenticationServiceError("AUTHENTICATION_INPUT_INVALID", { cause: error });
    }
    throw dependencyUnavailable(logger, context, userId, "AUTHENTICATION_RATE_LIMIT_UNAVAILABLE", error);
  }
}

function ownContext(requestId: unknown, clientSummary: unknown): AuthenticationContext {
  if (typeof requestId !== "string" || requestId !== requestId.trim() || !requestId ||
      Buffer.byteLength(requestId) > MAX_REQUEST_ID_BYTES || /[\r\n\0]/.test(requestId)) throw inputInvalid();
  if (clientSummary !== undefined && (typeof clientSummary !== "string" || clientSummary !== clientSummary.trim() ||
      Buffer.byteLength(clientSummary) > MAX_CLIENT_SUMMARY_BYTES || /[\r\n\0]/.test(clientSummary))) throw inputInvalid();
  return { requestId, clientSummary: clientSummary as string | undefined };
}

function ownEmailForLookup(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeEmail(value);
  return emailSchema.safeParse(normalized).success ? normalized : undefined;
}

function ownLoginPassword(value: unknown) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES && !value.includes("\0")
    ? value : undefined;
}

function ownToken(value: unknown) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > MAX_TOKEN_BYTES || /[\r\n\0]/.test(value)) {
    throw mfaInvalid();
  }
  return value;
}

function ownGeneratedToken(value: string) {
  const owned = ownToken(value);
  return hashOpaqueToken(owned);
}

function ownFactor(value: unknown): { method: "totp" | "recovery"; code: string } {
  if (!value || typeof value !== "object") throw mfaInvalid();
  const factor = value as Record<string, unknown>;
  if ((factor.method !== "totp" && factor.method !== "recovery") || typeof factor.code !== "string" ||
      !factor.code || Buffer.byteLength(factor.code) > 128 || /[\r\n\0]/.test(factor.code)) throw mfaInvalid();
  return { method: factor.method, code: factor.code };
}

function knownFactorMethod(value: unknown): "totp" | "recovery" | undefined {
  if (!value || typeof value !== "object") return undefined;
  const method = (value as Record<string, unknown>).method;
  return method === "totp" || method === "recovery" ? method : undefined;
}

function isActiveMfaUser(user: PlatformUser | undefined): user is PlatformUser {
  return Boolean(user && user.status === "active" && user.mfaStatus === "enabled" && user.mfaEnabledAt);
}

async function recordPasswordFailure(pool: PlatformPool, logger: SecurityLogger, context: AuthenticationContext,
  user: PlatformUser | undefined, sourceIpPrefix: string) {
  try {
    await withTransaction(pool, (transaction) => new PostgresAuditRepository(transaction).append({
      actorUserId: user?.id ?? null,
      actorType: user ? "user" : "anonymous",
      action: "authentication.password",
      targetType: "user",
      targetId: user?.id ?? null,
      requestId: context.requestId,
      result: "failure",
      metadata: auditMetadata(sourceIpPrefix, context.clientSummary, undefined, "invalid-credentials")
    }));
  } catch (error) {
    throw dependencyUnavailable(logger, context, user?.id, "AUTHENTICATION_FAILURE_AUDIT_UNAVAILABLE", error);
  }
}

function recordUnknownMfaFailure(pool: PlatformPool, logger: SecurityLogger, context: AuthenticationContext,
  sourceIpPrefix: string) {
  return recordKnownMfaFailure(pool, logger, context, undefined, undefined, sourceIpPrefix, undefined, "challenge-invalid");
}

async function recordKnownMfaFailure(pool: PlatformPool, logger: SecurityLogger, context: AuthenticationContext,
  challengeId: string | undefined, userId: string | undefined, sourceIpPrefix: string,
  method: "totp" | "recovery" | undefined, reason: string) {
  try {
    await withTransaction(pool, (transaction) => recordMfaFailureInTransaction(
      transaction, challengeId, userId, context, sourceIpPrefix, method, reason
    ));
  } catch (error) {
    throw dependencyUnavailable(logger, context, userId, "AUTHENTICATION_FAILURE_AUDIT_UNAVAILABLE", error);
  }
}

async function recordMfaFailureInTransaction(transaction: QueryExecutor,
  challengeId: string | undefined, userId: string | undefined, context: AuthenticationContext,
  sourceIpPrefix: string, method: "totp" | "recovery" | undefined, reason: string): Promise<undefined> {
  if (challengeId) await new PostgresMfaRepository(transaction).recordChallengeAttempt(challengeId);
  await new PostgresAuditRepository(transaction).append({
    actorUserId: userId ?? null,
    actorType: userId ? "user" : "anonymous",
    action: method === "recovery" ? "authentication.recovery" : "authentication.mfa",
    targetType: "mfa_challenge",
    targetId: challengeId ?? null,
    requestId: context.requestId,
    result: "failure",
    metadata: auditMetadata(sourceIpPrefix, context.clientSummary, method, reason)
  });
  return undefined;
}

function auditMetadata(sourceIpPrefix: string, clientSummary: string | undefined,
  method?: "totp" | "recovery", reason?: string) {
  return { ipPrefix: sourceIpPrefix, userAgent: clientSummary ?? null,
    ...(method ? { mfaMethod: method } : {}), ...(reason ? { reason } : {}) };
}

function publicUser(user: PlatformUser): AuthenticatedUser {
  const { passwordHash: _passwordHash, ...safe } = user;
  return Object.freeze({ ...safe, mfaEnabledAt: user.mfaEnabledAt ? new Date(user.mfaEnabledAt) : null,
    createdAt: new Date(user.createdAt), updatedAt: new Date(user.updatedAt) });
}

function dependencyUnavailable(logger: SecurityLogger, context: AuthenticationContext,
  userId: string | undefined, code: string, cause?: unknown) {
  try {
    logger.error({ requestId: context.requestId, ...(userId ? { userId } : {}), code });
  } catch (loggerError) {
    const combinedCause = cause === undefined ? loggerError :
      new AggregateError([cause, loggerError], "AUTHENTICATION_SECURITY_LOGGING_FAILED", { cause });
    return new AuthenticationServiceError("AUTHENTICATION_SECURITY_DEPENDENCY_UNAVAILABLE", { cause: combinedCause });
  }
  return new AuthenticationServiceError("AUTHENTICATION_SECURITY_DEPENDENCY_UNAVAILABLE", { cause });
}

function inputInvalid() { return new AuthenticationServiceError("AUTHENTICATION_INPUT_INVALID"); }
function invalidCredentials() { return new AuthenticationServiceError("AUTHENTICATION_INVALID_CREDENTIALS"); }
function mfaInvalid() { return new AuthenticationServiceError("AUTHENTICATION_MFA_INVALID"); }
