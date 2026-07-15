import type { PlatformPool } from "../../platform/database/pool.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { hashPassword, verifyPassword, type Argon2idOptions } from "../../platform/security/passwords.ts";
import { normalizeEmail } from "./email.ts";
import type { PlatformUser } from "./models.ts";
import { normalizeUsername } from "./username.ts";
import { PostgresAuditRepository } from "./repositories/postgres/PostgresAuditRepository.ts";
import { PostgresSessionRepository } from "./repositories/postgres/PostgresSessionRepository.ts";
import { PostgresUserRepository } from "./repositories/postgres/PostgresUserRepository.ts";

export class AccountServiceError extends Error {
  constructor(readonly code: "ACCOUNT_INPUT_INVALID" | "ACCOUNT_INVALID_CREDENTIALS" |
    "ACCOUNT_PASSWORD_REQUIRED" | "ACCOUNT_CONFLICT" | "ACCOUNT_DEPENDENCY_UNAVAILABLE", options?: ErrorOptions) {
    super(code, options);
    this.name = "AccountServiceError";
  }
}

export function createAccountService(options: { readonly pool: PlatformPool;
  readonly passwordHashOptions: Argon2idOptions }) {
  if (!options?.pool || !options.passwordHashOptions) throw new AccountServiceError("ACCOUNT_INPUT_INVALID");
  return Object.freeze({
    async updateOwnAccount(input: { readonly userId: string; readonly username: string; readonly email: string;
      readonly currentPassword: string; readonly newPassword?: string; readonly requestId: string }) {
      const username = normalizeUsername(input?.username ?? "");
      const email = normalizeEmail(input?.email ?? "");
      if (!/^[0-9a-f-]{36}$/.test(input?.userId ?? "") || !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username) ||
          !email || typeof input?.currentPassword !== "string" || !input.currentPassword ||
          typeof input?.requestId !== "string" || !input.requestId) throw new AccountServiceError("ACCOUNT_INPUT_INVALID");
      let newPasswordHash: string | undefined;
      try {
        const current = await new PostgresUserRepository(options.pool).findById(input.userId);
        if (!current || current.status !== "active" || !await verifyPassword(current.passwordHash, input.currentPassword)) {
          throw new AccountServiceError("ACCOUNT_INVALID_CREDENTIALS");
        }
        if (current.passwordChangeRequired && !input.newPassword) {
          throw new AccountServiceError("ACCOUNT_PASSWORD_REQUIRED");
        }
        newPasswordHash = input.newPassword ? await hashPassword(input.newPassword, options.passwordHashOptions) : undefined;
        return await withTransaction(options.pool, async (transaction) => {
          const users = new PostgresUserRepository(transaction);
          const locked = await users.lockById(input.userId);
          if (!locked || locked.status !== "active" || locked.passwordHash !== current.passwordHash) {
            throw new AccountServiceError("ACCOUNT_INVALID_CREDENTIALS");
          }
          const updated = await users.updateAccount({ id: locked.id, username, email,
            passwordHash: newPasswordHash ?? locked.passwordHash, passwordChangeRequired: false });
          if (!updated) throw new AccountServiceError("ACCOUNT_INVALID_CREDENTIALS");
          await new PostgresSessionRepository(transaction).revokeAllForUser(locked.id);
          await new PostgresAuditRepository(transaction).append({
            actorUserId: locked.id,
            actorType: "user",
            action: "account.update",
            targetType: "user",
            targetId: locked.id,
            requestId: input.requestId,
            result: "success",
            metadata: { reason: locked.passwordChangeRequired ? "initial-setup" : "account-settings",
              oldStatus: `${locked.usernameNormalized ?? ""}|${locked.emailNormalized}`,
              newStatus: `${updated.usernameNormalized ?? ""}|${updated.emailNormalized}`,
              count: newPasswordHash ? 1 : 0 }
          });
          return Object.freeze({ user: publicUser(updated), reauthenticationRequired: true as const });
        });
      } catch (error) {
        if (error instanceof AccountServiceError) throw error;
        if (isUniqueViolation(error)) throw new AccountServiceError("ACCOUNT_CONFLICT", { cause: error });
        throw new AccountServiceError("ACCOUNT_DEPENDENCY_UNAVAILABLE", { cause: error });
      }
    }
  });
}

function publicUser(user: PlatformUser) {
  const { passwordHash: _passwordHash, ...safe } = user;
  return Object.freeze({ ...safe, mfaEnabledAt: user.mfaEnabledAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(), updatedAt: user.updatedAt.toISOString() });
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}
