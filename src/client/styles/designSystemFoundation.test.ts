import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const clientRoot = path.resolve("src/client");

function read(relativePath: string) {
  return fs.readFileSync(path.join(clientRoot, relativePath), "utf8");
}

describe("Phase 2 design system foundation", () => {
  it("defines the approved semantic, spacing, sizing and layering tokens", () => {
    const tokens = read("styles/tokens.css");
    const requiredTokens = [
      "--color-chrome", "--color-workspace", "--color-surface", "--color-text",
      "--color-primary", "--color-danger", "--color-warning", "--color-success", "--color-info",
      "--font-family-sans", "--font-family-mono", "--font-size-body", "--line-height-body",
      "--space-1", "--space-4", "--space-8", "--control-height-md", "--control-height-touch",
      "--nav-width-expanded", "--nav-width-collapsed", "--content-max",
      "--radius-sm", "--radius-md", "--radius-lg", "--shadow-floating", "--shadow-dialog",
      "--shadow-document", "--z-sticky", "--z-popover", "--z-dialog", "--z-toast",
      "--duration-fast", "--duration-default", "--duration-overlay", "--focus-ring"
    ];

    for (const token of requiredTokens) expect(tokens, token).toContain(`${token}:`);
    expect(tokens).not.toContain("9999");
    expect(tokens).not.toMatch(/linear-gradient|radial-gradient/);
  });

  it("loads the four foundation layers before temporary legacy styles", () => {
    const main = read("main.tsx");
    const imports = [
      'import "./styles/tokens.css";',
      'import "./styles/reset.css";',
      'import "./styles/globals.css";',
      'import "./styles/motion.css";',
      'import "./styles.css";'
    ];

    let previous = -1;
    for (const statement of imports) {
      const index = main.indexOf(statement);
      expect(index, statement).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it("keeps legacy aliases in tokens and removes the old root owner", () => {
    const tokens = read("styles/tokens.css");
    const legacy = read("styles.css");

    expect(tokens).toContain("--bg: var(--color-workspace)");
    expect(tokens).toContain("--primary: var(--color-primary)");
    expect(tokens).toContain("--radius-panel: var(--radius-lg)");
    expect(legacy).not.toMatch(/:root\s*\{/);
  });

  it("exposes the gallery only from the development runtime", () => {
    const main = read("main.tsx");

    expect(main).toContain("import.meta.env.DEV");
    expect(main).toContain('location.pathname === "/__ui-gallery"');
    expect(main).toContain('import("./dev/UiGallery.tsx")');
  });
});
