import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const platformOnlyPackages = new Set([
  "pg", "@aws-sdk/client-s3", "@node-rs/argon2", "@inquirer/prompts", "cookie-parser", "ipaddr.js",
  "otpauth", "qrcode", "uuid"
]);

describe("legacy package isolation", () => {
  it.each(["src/server/index.ts", "src/server/serverExeEntry.ts"])(
    "%s static imports never reach platform-only code or packages", (entry) => {
      const visited = walkStaticImports(path.join(workspaceRoot, entry));
      expect([...visited.files].map((file) => path.relative(workspaceRoot, file).replaceAll("\\", "/")))
        .not.toEqual(expect.arrayContaining([expect.stringMatching(/^src\/server\/platform\//)]));
      expect([...visited.packages].filter((name) => platformOnlyPackages.has(name))).toEqual([]);
    }
  );

  it("keeps the platform loader dynamic and documents Windows server packages as legacy-only", () => {
    const configured = readFileSync(path.join(workspaceRoot, "src/server/startConfiguredServer.ts"), "utf8");
    const deployment = readFileSync(path.join(workspaceRoot, "docs/deploy-windows-lan.md"), "utf8");
    expect(configured).toContain('import("./platform/startPlatformWebServer.ts")');
    expect(deployment).toMatch(/legacy-only/i);
  });
});

function walkStaticImports(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    const normalized = path.normalize(file);
    if (files.has(normalized)) return;
    files.add(normalized);
    const source = readFileSync(normalized, "utf8");
    for (const specifier of staticSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        packages.add(packageName(specifier));
        continue;
      }
      const resolved = path.resolve(path.dirname(normalized), specifier);
      const candidate = existsSync(resolved) ? resolved : `${resolved}.ts`;
      if (existsSync(candidate)) visit(candidate);
    }
  };
  visit(entry);
  return { files, packages };
}

function staticSpecifiers(source: string) {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  return specifiers;
}

function packageName(specifier: string) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}
