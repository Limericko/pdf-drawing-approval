import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styles = fs.readFileSync(path.resolve("src/client/features/identity/platformIdentity.css"), "utf8");

describe("platform identity styles", () => {
  it("uses shared semantic tokens without identity-local fixed colors", () => {
    const root = styles.match(/\.platform-identity\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(root).toContain("--platform-ink: var(--color-text)");
    expect(root).toContain("--platform-blue: var(--color-primary)");
    expect(styles).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("lets long project identity, names, details and capabilities wrap without widening the layout", () => {
    const minWidthRule = styles.match(/\.platform-access__header > div,[^{]*\.platform-capability-list\s*\{([^}]*)\}/s)?.[1] ?? "";
    const wrapRule = styles.match(/\.platform-access__header p,[^{]*\.platform-capability-list li\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(minWidthRule).toContain("min-width: 0");
    expect(wrapRule).toContain("overflow-wrap: anywhere");
    expect(wrapRule).toContain("word-break: break-word");
  });

  it("keeps identity layout responsive while shared controls own the mobile touch floor", () => {
    const mobile = styles.match(/@media \(max-width: 640px\)\s*\{([\s\S]*)\}\s*$/)?.[1] ?? "";
    expect(mobile).toContain(".platform-form-grid, .platform-enrollment, .platform-recovery-codes");
    expect(mobile).toContain("grid-template-columns: 1fr");
    expect(styles).not.toContain("min-height: 46px");
  });
});
