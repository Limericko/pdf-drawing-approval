import { describe, expect, it } from "vitest";
import { formatPlatformE2EWorkerFailure } from "./worker.ts";

describe("platform E2E worker diagnostics", () => {
  it("redacts untrusted child errors", () => {
    const output = formatPlatformE2EWorkerFailure({ code: "SECRET_DATABASE_URL" });
    expect(output).toBe("PLATFORM_E2E_WORKER_FAILED");
    expect(output).not.toContain("SECRET_DATABASE_URL");
  });
});
