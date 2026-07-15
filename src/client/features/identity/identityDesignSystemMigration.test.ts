import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const identityRoot = path.resolve("src/client/features/identity");
const pageSources = [
  "PlatformLoginPage.tsx",
  "MfaChallengePage.tsx",
  "InvitationAcceptancePage.tsx",
  "RecoveryCodesPage.tsx",
  "PlatformAccessPage.tsx",
  "PlatformIdentityApp.tsx"
].map((file) => fs.readFileSync(path.join(identityRoot, file), "utf8")).join("\n");
const styles = fs.readFileSync(path.join(identityRoot, "platformIdentity.css"), "utf8");

describe("platform identity DS2 migration", () => {
  it("uses shared actions, forms and feedback instead of identity-local primitives", () => {
    expect(pageSources).toContain('from "../../ui/actions/index.tsx"');
    expect(pageSources).toContain('from "../../ui/forms/index.tsx"');
    expect(pageSources).toContain('from "../../ui/feedback/index.tsx"');
    expect(pageSources).not.toContain('className="platform-button');
    expect(pageSources).not.toContain('className="platform-error');
    expect(pageSources).not.toContain('className="platform-feedback');
  });

  it("deletes migrated primitive styles while retaining identity layout", () => {
    expect(styles).not.toContain(".platform-button");
    expect(styles).not.toContain(".platform-form input");
    expect(styles).not.toContain(".platform-error");
    expect(styles).not.toContain(".platform-feedback");
    expect(styles).toContain(".platform-panel");
    expect(styles).toContain(".platform-projects");
  });
});
