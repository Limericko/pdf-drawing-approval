import { describe, expect, it } from "vitest";
import { acquireLocalMailpitCleanupLock, createPlatformMailpit, extractInvitationToken,
  requireLocalMailpitUrl } from "./mailpit.ts";

describe("platform E2E Mailpit support", () => {
  it("allows destructive cleanup only for the fixed loopback test instance", () => {
    expect(requireLocalMailpitUrl("http://127.0.0.1:58025/").href).toBe("http://127.0.0.1:58025/");
    expect(() => requireLocalMailpitUrl("http://mail.example.test:58025"))
      .toThrow("PLATFORM_E2E_MAILPIT_NOT_LOCAL");
    expect(() => requireLocalMailpitUrl("http://127.0.0.1:8025"))
      .toThrow("PLATFORM_E2E_MAILPIT_NOT_LOCAL");
  });

  it("extracts only a fragment invitation token from message content", () => {
    expect(extractInvitationToken(
      "Open http://127.0.0.1:24173/#/accept-invitation?token=01890f1e-9b4a-7cc2-8f00-000000000001.signature"
    )).toBe("01890f1e-9b4a-7cc2-8f00-000000000001.signature");
    expect(() => extractInvitationToken("https://example.test/accept?token=query-secret"))
      .toThrow("PLATFORM_E2E_INVITATION_TOKEN_NOT_FOUND");
  });

  it("maps an unavailable local Mailpit instance to a stable harness error", async () => {
    const mailpit = createPlatformMailpit({ baseUrl: "http://127.0.0.1:58025",
      fetchImpl: async () => { throw new Error("connect ECONNREFUSED secret-host"); } });
    await expect(mailpit.clearLocalTestInstance()).rejects.toThrow("PLATFORM_E2E_MAILPIT_CLEAR_FAILED");
  });

  it("allows only one local owner to perform full-mailbox cleanup", async () => {
    const first = await acquireLocalMailpitCleanupLock();
    try {
      await expect(acquireLocalMailpitCleanupLock()).rejects.toThrow("PLATFORM_E2E_MAILPIT_LOCKED");
    } finally {
      await first.release();
    }
    const next = await acquireLocalMailpitCleanupLock();
    await next.release();
  });
});
