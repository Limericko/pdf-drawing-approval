import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The release sync script is a Node ESM utility verified by this Vitest test.
import { defaultRuntimeRoot, syncRuntimeRelease } from "../../scripts/syncRuntimeRelease.mjs";

describe("runtime release sync", () => {
  it("defaults to the real deployed server directory", () => {
    expect(defaultRuntimeRoot).toBe("E:\\PDF服务端\\pdf-approval");
  });

  it("copies update manifests and versioned installers into the real server release layout", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-release-sync-"));
    const runtimeRoot = path.join(workspaceRoot, "runtime", "pdf-approval");
    fs.mkdirSync(path.join(workspaceRoot, "dist", "updates"), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, "dist", "installers", "client"), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, "dist", "installers", "server"), { recursive: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({ version: "0.8.2" }), "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "dist", "updates", "latest.json"), JSON.stringify({ version: "0.8.2" }), "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "dist", "updates", "latest.yml"), "version: 0.8.2\n", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "dist", "updates", "CHANGELOG.md"), "# 更新日志\n", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "dist", "updates", "PDF图纸审批客户端-安装包-0.8.2.exe"), "client-updater", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "dist", "updates", "PDF图纸审批客户端-安装包-0.8.2.exe.blockmap"), "blockmap", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "dist", "installers", "client", "PDF图纸审批客户端-安装包-0.8.2.exe"), "client", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "dist", "installers", "server", "PDF图纸审批服务端-安装包-0.8.2.exe"), "server", "utf8");

    const result = syncRuntimeRelease({ workspaceRoot, runtimeRoot });

    expect(result.skipped).toBe(false);
    expect(fs.readFileSync(path.join(runtimeRoot, "releases", "updates", "latest.json"), "utf8")).toContain("0.8.2");
    expect(fs.readFileSync(path.join(runtimeRoot, "releases", "updates", "latest.yml"), "utf8")).toContain("0.8.2");
    expect(fs.readFileSync(path.join(runtimeRoot, "releases", "updates", "CHANGELOG.md"), "utf8")).toContain("更新日志");
    expect(fs.readFileSync(path.join(runtimeRoot, "releases", "updates", "PDF图纸审批客户端-安装包-0.8.2.exe"), "utf8")).toBe("client-updater");
    expect(fs.readFileSync(path.join(runtimeRoot, "releases", "updates", "PDF图纸审批客户端-安装包-0.8.2.exe.blockmap"), "utf8")).toBe("blockmap");
    expect(fs.readFileSync(path.join(runtimeRoot, "releases", "installers", "client", "PDF图纸审批客户端-安装包-0.8.2.exe"), "utf8")).toBe("client");
    expect(fs.readFileSync(path.join(runtimeRoot, "releases", "installers", "server", "PDF图纸审批服务端-安装包-0.8.2.exe"), "utf8")).toBe("server");
  });
});
