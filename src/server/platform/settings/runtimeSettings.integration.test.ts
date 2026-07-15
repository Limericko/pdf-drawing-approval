import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../database/migrationRunner.ts";
import type { PlatformPool } from "../database/pool.ts";
import { withPlatformTestDatabase } from "../testing/postgresHarness.ts";
import { ensureSingleNodeAdmin } from "../../commands/singleNodeBootstrap.ts";
import { createAdministrationService } from "../../modules/administration/administrationService.ts";
import { loadSmtpRuntimeSetting } from "./runtimeSettings.ts";

const keyring = { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 11)]]) };

describe("runtime SMTP settings", () => {
  it("stores the password encrypted, never returns it to the browser, and exposes it only to the worker", async () => {
    await withPlatformTestDatabase(async (database) => {
      await runMigrations(database.createPool("migration"));
      await ensureSingleNodeAdmin(asPlatformPool(database.createPool("bootstrap")));
      const web = asPlatformPool(database.createPool("web"));
      const actorUserId = (await web.query<{ id: string }>("SELECT id FROM platform.users")).rows[0]!.id;
      const service = createAdministrationService({ pool: web, storageHealth: async () => undefined,
        runtimeSettingsKeyring: keyring });
      const update = await service.updateSmtpSettings({ actorUserId, requestId: "smtp-settings-update", update: {
        host: "smtp.example.test", port: 465, from: "approval@example.test", secure: true, requireTls: false,
        username: "approval@example.test", password: "smtp-application-password"
      } });
      expect(update).toEqual({ configured: true, host: "smtp.example.test", port: 465,
        from: "approval@example.test", secure: true, requireTls: false, username: "approval@example.test",
        passwordConfigured: true });
      expect(JSON.stringify(await service.getSmtpSettings({ actorUserId }))).not.toContain("smtp-application-password");
      const stored = await web.query<{ encrypted_value: Buffer }>(
        "SELECT encrypted_value FROM platform.runtime_settings WHERE setting_key='smtp'"
      );
      expect(stored.rows[0]!.encrypted_value.toString("utf8")).not.toContain("smtp-application-password");
      await expect(loadSmtpRuntimeSetting(database.createPool("worker"), keyring)).resolves.toMatchObject({
        host: "smtp.example.test", username: "approval@example.test", password: "smtp-application-password"
      });
    });
  });
});

function asPlatformPool(pool: Pool): PlatformPool {
  return Object.assign(pool, { transactionTimeouts: Object.freeze({ queryTimeoutMs: 5_000,
    lockTimeoutMs: 5_000, transactionTimeoutMs: 15_000 }) }) as PlatformPool;
}
