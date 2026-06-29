import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The packaging script is a Node ESM utility verified by this Vitest test.
import { createServerExePackage, resolveEsbuildCommand } from "../../scripts/serverExePackage.mjs";

describe("server exe package", () => {
  it("creates a portable server executable package with bundled app assets", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-server-exe-"));
    const electronDist = path.join(workspaceRoot, "node_modules", "electron", "dist");
    const appSource = path.join(workspaceRoot, "apps", "server-exe");
    const serverBundle = path.join(workspaceRoot, "dist", "server-electron", "server", "index.js");
    const schemaPath = path.join(workspaceRoot, "src", "server", "schema.sql");
    const clientDist = path.join(workspaceRoot, "dist", "client");
    const iconDir = path.join(workspaceRoot, "assets", "icons");
    const outputRoot = path.join(workspaceRoot, "dist", "server-exe");

    fs.mkdirSync(path.join(electronDist, "resources"), { recursive: true });
    fs.writeFileSync(path.join(electronDist, "electron.exe"), "electron");
    fs.writeFileSync(path.join(electronDist, "icudtl.dat"), "runtime");
    fs.mkdirSync(appSource, { recursive: true });
    fs.writeFileSync(path.join(appSource, "main.cjs"), "main");
    fs.writeFileSync(path.join(appSource, "preload.cjs"), "preload");
    fs.writeFileSync(path.join(appSource, "serverRuntimeConfig.cjs"), "runtime config");
    fs.writeFileSync(path.join(appSource, "serverConsoleView.cjs"), "console view");
    fs.writeFileSync(path.join(appSource, "lanAddress.cjs"), "lan address");
    fs.writeFileSync(path.join(appSource, "package.json"), JSON.stringify({ main: "main.cjs" }));
    fs.mkdirSync(path.dirname(serverBundle), { recursive: true });
    fs.writeFileSync(serverBundle, "console.log('server');");
    fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
    fs.writeFileSync(schemaPath, "CREATE TABLE settings(key TEXT);");
    fs.mkdirSync(clientDist, { recursive: true });
    fs.writeFileSync(path.join(clientDist, "index.html"), "<div>client</div>");
    fs.mkdirSync(iconDir, { recursive: true });
    fs.writeFileSync(path.join(iconDir, "pdf-approval-client.png"), "png");
    fs.writeFileSync(path.join(iconDir, "pdf-approval-client.ico"), "ico");
    fs.writeFileSync(path.join(iconDir, "pdf-approval-server.png"), "png");
    fs.writeFileSync(path.join(iconDir, "pdf-approval-server.ico"), "ico");

    const result = createServerExePackage({
      workspaceRoot,
      outputRoot,
      skipBundle: true,
      skipIconPatch: true
    });

    expect(path.basename(result.packageDir)).toBe("PDF图纸审批服务端");
    expect(fs.existsSync(path.join(result.packageDir, "PDF图纸审批服务端.exe"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "main.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "preload.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "serverRuntimeConfig.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "serverConsoleView.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "lanAddress.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "server", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "src", "server", "schema.sql"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "dist", "client", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "assets", "icons", "pdf-approval-client.png"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "assets", "icons", "pdf-approval-server.png"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "releases", "updates"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "releases", "installers", "client"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "releases", "installers", "server"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "启动说明.txt"))).toBe(true);
    const readme = fs.readFileSync(path.join(result.packageDir, "启动说明.txt"), "utf8");
    expect(readme).toContain("隐藏到系统托盘");
    expect(readme).toContain("releases");
    expect(fs.existsSync(path.join(result.packageDir, "node_modules"))).toBe(false);
  });

  it("runs esbuild through node so Windows paths with spaces are safe", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf approval server exe-"));
    const esbuildEntry = path.join(workspaceRoot, "node_modules", "esbuild", "bin", "esbuild");
    fs.mkdirSync(path.dirname(esbuildEntry), { recursive: true });
    fs.writeFileSync(esbuildEntry, "#!/usr/bin/env node\n");

    const command = resolveEsbuildCommand(workspaceRoot);

    expect(command.executable).toBe(process.execPath);
    expect(command.args).toEqual([esbuildEntry]);
  });
});
