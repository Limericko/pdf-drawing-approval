import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PlatformPool } from "../platform/database/pool.ts";
import { ensureSingleNodeAdmin } from "./singleNodeBootstrap.ts";
import { runMigrations } from "../platform/database/migrationRunner.ts";
import { withPlatformTestDatabase } from "../platform/testing/postgresHarness.ts";
import { verifyPassword } from "../platform/security/passwords.ts";
import { createAuthenticationService, AuthenticationServiceError } from "../modules/identity/authenticationService.ts";
import { createAccountService } from "../modules/identity/accountService.ts";
import { createSessionService, SessionServiceError } from "../platform/security/sessionService.ts";

const passwordHashOptions = Object.freeze({ memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });
const session = Object.freeze({ absoluteTtlMs: 8 * 60 * 60_000, idleTtlMs: 30 * 60_000, touchIntervalMs: 60_000 });
const keyring = { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 7)]]) };

describe("single-node default administrator", () => {
  it("creates admin idempotently, requires an immediate password change, and revokes the initial session", async () => {
    await withPlatformTestDatabase(async (database) => {
      await runMigrations(database.createPool("migration"));
      const bootstrap = asPlatformPool(database.createPool("bootstrap"));
      await expect(ensureSingleNodeAdmin(bootstrap)).resolves.toEqual({ created: true });
      await expect(ensureSingleNodeAdmin(bootstrap)).resolves.toEqual({ created: false });

      const web = asPlatformPool(database.createPool("web"));
      const row = (await web.query<{ id: string; username_normalized: string; email_normalized: string;
        password_hash: string; password_change_required: boolean; mfa_status: string }>(
        `SELECT id,username_normalized,email_normalized,password_hash,password_change_required,mfa_status
         FROM platform.users`
      )).rows[0]!;
      expect(row).toMatchObject({ username_normalized: "admin", email_normalized: "admin@single-node.invalid",
        password_change_required: true, mfa_status: "disabled" });
      await expect(verifyPassword(row.password_hash, "admin123")).resolves.toBe(true);

      const authentication = createAuthenticationService({ pool: web,
        keyrings: { totpEncryption: keyring, recoveryHmac: keyring }, passwordHashOptions, session,
        logger: { error() { /* test logger */ } } });
      const firstLogin = await authentication.login({ account: "admin", password: "admin123",
        sourceIpPrefix: "127.0.0.0/24", requestId: "single-node-login" });
      expect(firstLogin).toMatchObject({ next: "session", user: { passwordChangeRequired: true } });
      if (firstLogin.next !== "session") throw new Error("EXPECTED_DIRECT_SESSION");

      await createAccountService({ pool: web, passwordHashOptions }).updateOwnAccount({ userId: row.id,
        username: "chief-admin", email: "admin@example.test", currentPassword: "admin123",
        newPassword: "a-new-admin-password", requestId: "single-node-account-update" });
      await expect(createSessionService({ pool: web, passwordHashOptions, session })
        .authenticate({ sessionToken: firstLogin.sessionToken })).rejects.toMatchObject({
          code: "SESSION_INVALID"
        } satisfies Partial<SessionServiceError>);
      await expect(authentication.login({ account: "admin", password: "admin123", sourceIpPrefix: "127.0.0.0/24",
        requestId: "old-login" })).rejects.toMatchObject({
          code: "AUTHENTICATION_INVALID_CREDENTIALS"
        } satisfies Partial<AuthenticationServiceError>);
      await expect(authentication.login({ account: "chief-admin", password: "a-new-admin-password",
        sourceIpPrefix: "127.0.0.0/24", requestId: "new-login" })).resolves.toMatchObject({
          next: "session", user: { usernameNormalized: "chief-admin", emailNormalized: "admin@example.test",
            passwordChangeRequired: false }
        });
    });
  });
});

function asPlatformPool(pool: Pool): PlatformPool {
  return Object.assign(pool, { transactionTimeouts: Object.freeze({ queryTimeoutMs: 5_000,
    lockTimeoutMs: 5_000, transactionTimeoutMs: 15_000 }) }) as PlatformPool;
}
