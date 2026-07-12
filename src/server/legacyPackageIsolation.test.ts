import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const compilerOptions = loadCompilerOptions();
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

  it("collects every static TypeScript module form while excluding dynamic imports and text lookalikes", () => {
    const source = `
      import value from "./imported.js";
      export { value as renamed } from "./exported";
      export * from "./star";
      import equal = require("./equals");
      const required = require("./required");
      void import("./dynamic");
      const text = 'require("./string-only")';
      // export * from "./comment-only";
    `;

    expect(staticSpecifiers(source)).toEqual([
      "./imported.js",
      "./exported",
      "./star",
      "./equals",
      "./required"
    ]);
  });

  it("uses TypeScript module resolution for JS aliases, directory indexes, and TS-family extensions", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "legacy-import-graph-"));
    try {
      await mkdir(path.join(fixture, "directory"));
      await Promise.all([
        writeFile(path.join(fixture, "entry.ts"), `
          import "./aliased.js";
          export * from "./directory";
          import "./component";
          import value from "./module.mjs";
          const common = require("./common.cjs");
          void import("./dynamic.js");
        `),
        writeFile(path.join(fixture, "aliased.ts"), "export {};"),
        writeFile(path.join(fixture, "directory", "index.ts"), "export {};"),
        writeFile(path.join(fixture, "component.tsx"), "export {};"),
        writeFile(path.join(fixture, "module.mts"), "export default 1;"),
        writeFile(path.join(fixture, "common.cts"), "export = 1;"),
        writeFile(path.join(fixture, "dynamic.ts"), "throw new Error('must stay dynamic');")
      ]);

      let visited: ReturnType<typeof walkStaticImports> | undefined;
      expect(() => { visited = walkStaticImports(path.join(fixture, "entry.ts")); }).not.toThrow();
      const files = [...visited!.files].map((file) => path.relative(fixture, file).replaceAll("\\", "/")).sort();
      expect(files).toEqual([
        "aliased.ts",
        "common.cts",
        "component.tsx",
        "directory/index.ts",
        "entry.ts",
        "module.mts"
      ]);
      expect(files).not.toContain("dynamic.ts");
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });
});

function walkStaticImports(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const resolutionCache = ts.createModuleResolutionCache(
    workspaceRoot,
    (fileName) => process.platform === "win32" ? fileName.toLowerCase() : fileName,
    compilerOptions
  );
  const visit = (file: string) => {
    const normalized = path.normalize(file);
    if (files.has(normalized)) return;
    files.add(normalized);
    const source = readFileSync(normalized, "utf8");
    for (const specifier of staticSpecifiers(source, normalized)) {
      const resolved = ts.resolveModuleName(
        specifier,
        normalized,
        compilerOptions,
        ts.sys,
        resolutionCache
      ).resolvedModule;
      if (resolved && !resolved.isExternalLibraryImport) {
        visit(resolved.resolvedFileName);
      } else if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
        packages.add(packageName(specifier));
      }
    }
  };
  visit(entry);
  return { files, packages };
}

function staticSpecifiers(source: string, fileName = "module.ts") {
  const specifiers: string[] = [];
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" &&
        node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function loadCompilerOptions() {
  const configPath = path.join(workspaceRoot, "tsconfig.json");
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw new Error("LEGACY_IMPORT_GRAPH_TSCONFIG_INVALID");
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, workspaceRoot, undefined, configPath);
  if (parsed.errors.length > 0) throw new Error("LEGACY_IMPORT_GRAPH_TSCONFIG_INVALID");
  return parsed.options;
}

function packageName(specifier: string) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}
