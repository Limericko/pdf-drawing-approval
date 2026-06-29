import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The release manifest script is a Node ESM utility verified by this Vitest test.
import { createUpdateManifest } from "../../scripts/createUpdateManifest.mjs";

describe("update manifest packaging", () => {
  it("creates an update manifest that points at the versioned installers", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-update-manifest-"));
    fs.mkdirSync(path.join(workspaceRoot, "dist", "installers", "client"), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, "dist", "installers", "server"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({ version: "0.8.0" }));
    fs.writeFileSync(
      path.join(workspaceRoot, "CHANGELOG.md"),
      ["# 更新日志", "", "## 0.8.0 - 2026-06-23", "", "- 增加在线更新检查。", ""].join("\n")
    );
    fs.writeFileSync(path.join(workspaceRoot, "dist", "installers", "client", "PDF图纸审批客户端-安装包-0.8.0.exe"), "client");
    fs.writeFileSync(path.join(workspaceRoot, "dist", "installers", "server", "PDF图纸审批服务端-安装包-0.8.0.exe"), "server");

    const result = createUpdateManifest({ workspaceRoot });

    expect(result.manifest).toMatchObject({
      version: "0.8.0",
      releaseDate: "2026-06-23",
      notes: ["增加在线更新检查。"],
      downloads: {
        clientInstaller: "../installers/client/PDF图纸审批客户端-安装包-0.8.0.exe",
        serverInstaller: "../installers/server/PDF图纸审批服务端-安装包-0.8.0.exe"
      }
    });
    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(fs.existsSync(path.join(workspaceRoot, "dist", "updates", "CHANGELOG.md"))).toBe(true);
  });
});
