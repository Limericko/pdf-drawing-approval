import type { QueryExecutor } from "../database/queryExecutor.ts";
import type { PlatformPool } from "../database/pool.ts";
import { withTransaction } from "../database/transaction.ts";
import type { PlatformSession } from "../../modules/identity/repositories/sessionRepository.ts";
import type { PlatformUser } from "../../modules/identity/models.ts";
import { PostgresAuditRepository } from "../../modules/identity/repositories/postgres/PostgresAuditRepository.ts";
import { PostgresSessionRepository } from "../../modules/identity/repositories/postgres/PostgresSessionRepository.ts";
import { PostgresUserRepository } from "../../modules/identity/repositories/postgres/PostgresUserRepository.ts";
import { hashOpaqueToken } from "./tokenHash.ts";

const SESSION_ABSOLUTE_LIFETIME_SECONDS = 12 * 60 * 60;
const SESSION_IDLE_LIFETIME_SECONDS = 60 * 60;
const SESSION_TOUCH_INTERVAL_SECONDS = 5 * 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SessionUser = Omit<PlatformUser, "passwordHash">;
export type AuthenticatedSession = Omit<PlatformSession, "tokenHash">;

export class SessionServiceError extends Error {
  constructor(readonly code:
    | "SESSION_INPUT_INVALID"
    | "SESSION_INVALID"
    | "SESSION_SECURITY_DEPENDENCY_UNAVAILABLE", options?: ErrorOptions) {
    super(code, options);
    this.name = "SessionServiceError";
  }
}

export function createSessionService(options: { readonly pool: PlatformPool }) {
  if (!options?.pool) throw inputInvalid();
  return Object.freeze({
    createInTransaction(transaction: QueryExecutor, input: {
      readonly userId: string;
      readonly tokenHash: Buffer;
      readonly clientSummary?: string;
    }) {
      ownUserId(input?.userId);
      if (!Buffer.isBuffer(input?.tokenHash) || input.tokenHash.length !== 32) throw inputInvalid();
      const clientSummary = ownClientSummary(input.clientSummary);
      return new PostgresSessionRepository(transaction).create({
        userId: input.userId,
        tokenHash: input.tokenHash,
        absoluteLifetimeSeconds: SESSION_ABSOLUTE_LIFETIME_SECONDS,
        idleLifetimeSeconds: SESSION_IDLE_LIFETIME_SECONDS,
        clientSummary
      });
    },

    async authenticate(input: { readonly sessionToken: string }) {
      const tokenHash = hashToken(input?.sessionToken);
      try {
        try {
          const sessions = new PostgresSessionRepository(options.pool);
          let session = await sessions.findActiveByTokenHash(tokenHash);
          if (!session) throw invalid();
          const user = await new PostgresUserRepository(options.pool).findById(session.userId);
          if (!user || user.status !== "active") throw invalid();
          const touched = await sessions.touch(session.id, SESSION_IDLE_LIFETIME_SECONDS, SESSION_TOUCH_INTERVAL_SECONDS);
          if (touched) {
            session = touched;
          } else {
            const stillActive = await sessions.findActiveByTokenHash(tokenHash);
            if (!stillActive) throw invalid();
            session = stillActive;
          }
          return Object.freeze({ user: publicUser(user), session: publicSession(session) });
        } catch (error) {
          if (error instanceof SessionServiceError) throw error;
          throw dependencyUnavailable(error);
        }
      } finally {
        tokenHash.fill(0);
      }
    },

    async revokeCurrent(input: { readonly sessionToken: string; readonly requestId: string }) {
      const requestId = ownRequestId(input?.requestId);
      const tokenHash = hashToken(input?.sessionToken);
      try {
        try {
          await withTransaction(options.pool, async (transaction) => {
            const sessions = new PostgresSessionRepository(transaction);
            const session = await sessions.findActiveByTokenHash(tokenHash);
            if (!session || !await sessions.revoke(session.id)) throw invalid();
            await new PostgresAuditRepository(transaction).append({
              actorUserId: session.userId,
              actorType: "user",
              action: "session.revoke",
              targetType: "session",
              targetId: session.id,
              requestId,
              result: "success",
              metadata: { sessionId: session.id, reason: "current-session" }
            });
          });
          return Object.freeze({ revoked: true as const });
        } catch (error) {
          if (error instanceof SessionServiceError) throw error;
          throw dependencyUnavailable(error);
        }
      } finally {
        tokenHash.fill(0);
      }
    },

    async revokeAllForSecurityChange(input: {
      readonly userId: string;
      readonly requestId: string;
      readonly reason: "password-change" | "user-disabled";
    }) {
      const userId = ownUserId(input?.userId);
      const requestId = ownRequestId(input?.requestId);
      if (input?.reason !== "password-change" && input?.reason !== "user-disabled") throw inputInvalid();
      try {
        return await withTransaction(options.pool, async (transaction) => {
          const user = await new PostgresUserRepository(transaction).lockById(userId);
          if (!user) throw invalid();
          const revokedCount = await new PostgresSessionRepository(transaction).revokeAllForUser(userId);
          await new PostgresAuditRepository(transaction).append({
            actorUserId: userId,
            actorType: "user",
            action: "session.revoke_all",
            targetType: "user",
            targetId: userId,
            requestId,
            result: "success",
            metadata: { reason: input.reason }
          });
          return Object.freeze({ revokedCount });
        });
      } catch (error) {
        if (error instanceof SessionServiceError) throw error;
        throw dependencyUnavailable(error);
      }
    }
  });
}

function hashToken(value: unknown) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 256 || /[\r\n\0]/.test(value)) throw invalid();
  return hashOpaqueToken(value);
}

function ownUserId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw inputInvalid();
  return value;
}

function ownRequestId(value: unknown) {
  if (typeof value !== "string" || value !== value.trim() || !value ||
      Buffer.byteLength(value) > 200 || /[\r\n\0]/.test(value)) throw inputInvalid();
  return value;
}

function ownClientSummary(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value !== value.trim() || Buffer.byteLength(value) > 200 || /[\r\n\0]/.test(value)) {
    throw inputInvalid();
  }
  return value;
}

function publicUser(user: PlatformUser): SessionUser {
  const { passwordHash: _passwordHash, ...safe } = user;
  return Object.freeze({ ...safe, mfaEnabledAt: user.mfaEnabledAt ? new Date(user.mfaEnabledAt) : null,
    createdAt: new Date(user.createdAt), updatedAt: new Date(user.updatedAt) });
}

function publicSession(session: PlatformSession): AuthenticatedSession {
  const { tokenHash: _tokenHash, ...safe } = session;
  return Object.freeze({ ...safe, createdAt: new Date(session.createdAt),
    absoluteExpiresAt: new Date(session.absoluteExpiresAt), idleExpiresAt: new Date(session.idleExpiresAt),
    lastActivityAt: new Date(session.lastActivityAt), lastTouchAt: new Date(session.lastTouchAt),
    revokedAt: session.revokedAt ? new Date(session.revokedAt) : null });
}

function inputInvalid() { return new SessionServiceError("SESSION_INPUT_INVALID"); }
function invalid() { return new SessionServiceError("SESSION_INVALID"); }
function dependencyUnavailable(cause?: unknown) {
  return new SessionServiceError("SESSION_SECURITY_DEPENDENCY_UNAVAILABLE", { cause });
}
