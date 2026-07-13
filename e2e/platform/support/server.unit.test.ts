import { describe, expect, it } from "vitest";
import { createStorageOwnershipLayout, formatCleanupFailures, formatStartupFailure,
  prepareLocalPlatformE2EStartup } from "./server.ts";

describe("platform E2E cleanup diagnostics", () => {
  it("preserves stable child cleanup codes without leaking arbitrary messages", () => {
    expect(formatCleanupFailures([
      new Error("PLATFORM_E2E_PORT_STILL_BOUND:24173"),
      new Error("secret database URL failed")
    ])).toBe("PLATFORM_E2E_CLEANUP_FAILED:PLATFORM_E2E_PORT_STILL_BOUND:24173,PLATFORM_E2E_CLEANUP_STEP_FAILED");
  });
});

describe("platform E2E startup boundary", () => {
  it("removes stale state before rejecting an unsafe dependency environment", async () => {
    const order: string[] = [];
    await expect(prepareLocalPlatformE2EStartup({
      PDF_APPROVAL_STORAGE_S3_ENDPOINT: "https://production.example.test"
    }, async () => { order.push("state-removed"); })).rejects.toThrow("PLATFORM_E2E_DEPENDENCY_NOT_LOCAL");
    expect(order).toEqual(["state-removed"]);
  });

  it("redacts database URLs and secrets from startup failures", () => {
    const output = formatStartupFailure(new Error(
      "connect postgresql://platform_web:secret@db.example.test/pdf_approval failed"
    ));
    expect(output).toBe("PLATFORM_E2E_START_FAILED:PLATFORM_E2E_START_STEP_FAILED");
    expect(output).not.toContain("postgresql://");
    expect(output).not.toContain("secret");
  });
});

describe("platform E2E storage ownership", () => {
  it("keeps the Worker sentinel outside the adapter prefix but inside the owned cleanup root", () => {
    const runId = "0123456789abcdef0123456789abcdef";
    const layout = createStorageOwnershipLayout(runId);
    expect(layout).toEqual({
      cleanupRoot: `phase1-e2e/${runId}`,
      storagePrefix: `phase1-e2e/${runId}/objects`,
      sentinelPrefix: `phase1-e2e/${runId}/sentinel`
    });
    expect(layout.sentinelPrefix.startsWith(`${layout.cleanupRoot}/`)).toBe(true);
    expect(layout.sentinelPrefix.startsWith(`${layout.storagePrefix}/`)).toBe(false);
  });
});
