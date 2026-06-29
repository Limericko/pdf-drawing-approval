import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPortableDesktopPackage } from "../../scripts/desktopPackage.mjs";

describe("desktop portable package layout", () => {
  it("creates a portable Electron package with app and client assets", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-package-"));
    const electronDist = path.join(workspaceRoot, "node_modules", "electron", "dist");
    const appSource = path.join(workspaceRoot, "apps", "desktop-client");
    const clientDist = path.join(workspaceRoot, "dist", "client");
    const iconDir = path.join(workspaceRoot, "assets", "icons");
    const outputRoot = path.join(workspaceRoot, "dist", "desktop-client");

    fs.mkdirSync(path.join(electronDist, "resources"), { recursive: true });
    fs.writeFileSync(path.join(electronDist, "electron.exe"), "electron");
    fs.writeFileSync(path.join(electronDist, "icudtl.dat"), "runtime");
    fs.mkdirSync(appSource, { recursive: true });
    fs.writeFileSync(path.join(appSource, "main.cjs"), "main");
    fs.writeFileSync(path.join(appSource, "preload.cjs"), "preload");
    fs.writeFileSync(path.join(appSource, "desktopConfig.cjs"), "config");
    fs.writeFileSync(path.join(appSource, "package.json"), JSON.stringify({ main: "main.cjs" }));
    createPackage(path.join(workspaceRoot, "node_modules"), "electron-updater", {
      main: "index.js",
      dependencies: { "builder-util-runtime": "1.0.0" }
    });
    createPackage(path.join(workspaceRoot, "node_modules"), "builder-util-runtime", { main: "index.js" });
    fs.mkdirSync(clientDist, { recursive: true });
    fs.writeFileSync(path.join(clientDist, "index.html"), "<div>client</div>");
    fs.mkdirSync(iconDir, { recursive: true });
    fs.writeFileSync(path.join(iconDir, "pdf-approval-client.png"), "png");
    fs.writeFileSync(path.join(iconDir, "pdf-approval-client.ico"), "ico");
    fs.writeFileSync(path.join(iconDir, "pdf-approval-server.png"), "png");
    fs.writeFileSync(path.join(iconDir, "pdf-approval-server.ico"), "ico");

    const result = createPortableDesktopPackage({ workspaceRoot, outputRoot, skipIconPatch: true });

    expect(path.basename(result.packageDir)).toBe("PDF图纸审批客户端");
    expect(fs.existsSync(path.join(result.packageDir, "PDF图纸审批客户端.exe"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "main.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "dist", "client", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "assets", "icons", "pdf-approval-client.png"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "assets", "icons", "pdf-approval-server.png"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "node_modules", "electron-updater", "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "resources", "app", "node_modules", "builder-util-runtime", "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "启动说明.txt"))).toBe(true);
  });
});

function createPackage(nodeModulesDir, name, packageJson) {
  const packageDir = path.join(nodeModulesDir, ...name.split("/"));
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...packageJson }));
  fs.writeFileSync(path.join(packageDir, packageJson.main ?? "index.js"), "module.exports = {};");
}
