import { describe, expect, it } from "vitest";
import { resolvePlatformE2ECommands } from "../../../scripts/run-platform-e2e.mjs";

const prefix = ["test", "--config", "playwright.platform.config.ts"];

describe("platform E2E command matrix", () => {
  it("runs the three stateful groups as three fresh sequential harnesses by default", () => {
    expect(resolvePlatformE2ECommands([])).toEqual([
      [...prefix, "--project=desktop-chromium", "e2e/platform/identity-security.spec.ts"],
      [...prefix, "--project=desktop-chromium", "e2e/platform/session-csrf.spec.ts",
        "e2e/platform/project-access.spec.ts"],
      [...prefix, "--project=mobile-chromium", "e2e/platform/identity-security.spec.ts"]
    ]);
  });

  it("passes explicit Playwright arguments through one harness invocation", () => {
    expect(resolvePlatformE2ECommands(["--project=desktop-chromium", "e2e/platform/project-access.spec.ts"]))
      .toEqual([[...prefix, "--project=desktop-chromium", "e2e/platform/project-access.spec.ts"]]);
  });
});
