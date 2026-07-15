import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");

describe("App shell migration", () => {
  it("keeps shell and navigation DOM outside App.tsx", () => {
    expect(source).toContain('from "./patterns/AppShell/index.tsx"');
    expect(source).toContain('from "./ui/navigation/index.tsx"');
    expect(source).not.toContain('<aside className="sidebar"');
    expect(source).not.toContain('<nav className="side-nav"');
    expect(source).not.toContain('className="app-layout');
  });
});
