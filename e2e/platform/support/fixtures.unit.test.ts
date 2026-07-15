import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { platformStateFile, publishPlatformE2EState, publishStateBeforeStart } from "./fixtures.ts";

describe("platform E2E state publication", () => {
  it("publishes complete state before the client can bind its readiness port", async () => {
    const order: string[] = [];
    const client = await publishStateBeforeStart({ ready: true },
      async () => { order.push("state-published"); },
      () => { order.push("client-started"); return "client"; });
    expect(client).toBe("client");
    expect(order).toEqual(["state-published", "client-started"]);
  });

  it("never serializes admin credentials or recovery material", async () => {
    const secrets = ["admin-password", "totp-secret", "recovery-code"];
    try {
      await publishPlatformE2EState({
        runId: "run", databaseName: "database", storageCleanupRoot: "cleanup-root", storagePrefix: "prefix",
        webUrl: "http://127.0.0.1:24173", apiUrl: "http://127.0.0.1:28080",
        mailpitUrl: "http://127.0.0.1:58025",
        seed: {
          admin: { email: "admin@example.test", password: secrets[0], totpSecretHex: secrets[1],
            recoveryCodes: [secrets[2]] },
          unauthorizedProjectId: "project-id"
        }
      } as never);
      const serialized = await readFile(platformStateFile, "utf8");
      for (const secret of secrets) expect(serialized).not.toContain(secret);
    } finally {
      await rm(platformStateFile, { force: true });
    }
  });
});
