import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styles = fs.readFileSync(path.resolve("src/client/features/identity/platformIdentity.css"), "utf8");

describe("platform identity styles", () => {
  it("keeps project management inputs and selects at the 44px touch target floor", () => {
    const rule = styles.match(/\.platform-management input,\s*\.platform-management select\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("min-height: 46px");
  });

  it("keeps the inline error retry action at the 44px touch target floor", () => {
    const rule = styles.match(/\.platform-error button\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("min-height: 44px");
  });

  it("lets long project identity, names, details and capabilities wrap without widening the layout", () => {
    const minWidthRule = styles.match(/\.platform-access__header > div,[^{]*\.platform-capability-list\s*\{([^}]*)\}/s)?.[1] ?? "";
    const wrapRule = styles.match(/\.platform-access__header p,[^{]*\.platform-capability-list li\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(minWidthRule).toContain("min-width: 0");
    expect(wrapRule).toContain("overflow-wrap: anywhere");
    expect(wrapRule).toContain("word-break: break-word");
  });
});
