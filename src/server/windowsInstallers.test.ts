import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-ignore The installer script is a Node ESM utility verified by this Vitest test.
import { createInstallerBuildPlan, createInstallerConfig, createInstallerEnv } from "../../scripts/windowsInstallers.mjs";

function createWorkspaceRoot() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-installer-"));
  const iconDir = path.join(workspaceRoot, "assets", "icons");
  fs.mkdirSync(iconDir, { recursive: true });
  for (const kind of ["client", "server"]) {
    fs.writeFileSync(path.join(iconDir, `pdf-approval-${kind}.png`), "png");
    fs.writeFileSync(path.join(iconDir, `pdf-approval-${kind}.ico`), "ico");
  }
  return workspaceRoot;
}

describe("windows installer packaging", () => {
  it("creates NSIS installer configs for the client and server", () => {
    const workspaceRoot = createWorkspaceRoot();
    const clientIcon = path.join(workspaceRoot, "assets", "icons", "pdf-approval-client.ico");
    const serverIcon = path.join(workspaceRoot, "assets", "icons", "pdf-approval-server.ico");

    expect(createInstallerConfig("client", workspaceRoot)).toMatchObject({
      appId: "local.pdf-approval.desktop-client",
      productName: "PDF图纸审批客户端",
      directories: { output: path.join(workspaceRoot, "dist", "installers", "client") },
      publish: [{ provider: "generic", url: "http://127.0.0.1:8080/updates/" }],
      win: {
        target: [{ target: "nsis", arch: ["x64"] }],
        icon: clientIcon,
        artifactName: "PDF图纸审批客户端-安装包-${version}.${ext}"
      },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowElevation: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: "PDF图纸审批客户端",
        installerIcon: clientIcon,
        uninstallerIcon: clientIcon,
        include: path.join(workspaceRoot, "build", "installer.nsh")
      }
    });

    expect(createInstallerConfig("server", workspaceRoot)).toMatchObject({
      appId: "local.pdf-approval.server",
      productName: "PDF图纸审批服务端",
      directories: { output: path.join(workspaceRoot, "dist", "installers", "server") },
      win: {
        target: [{ target: "nsis", arch: ["x64"] }],
        icon: serverIcon,
        artifactName: "PDF图纸审批服务端-安装包-${version}.${ext}"
      },
      nsis: {
        shortcutName: "PDF图纸审批服务端",
        installerIcon: serverIcon,
        uninstallerIcon: serverIcon,
        include: path.join(workspaceRoot, "build", "installer.nsh")
      }
    });
  });

  it("uses an exact app executable process check so installers can run from release directories", () => {
    const include = fs.readFileSync(path.resolve("build", "installer.nsh"), "utf8");

    expect(include).toContain("customCheckAppRunning");
    expect(include).toContain("$$_.Name -ieq $$name");
    expect(include).toContain("${PRODUCT_NAME}.exe");
    expect(include).not.toContain("${APP_EXECUTABLE_FILENAME}");
    expect(include).not.toContain("StartsWith('$INSTDIR'");
  });

  it("preserves server runtime state and update releases during reinstall", () => {
    const include = fs.readFileSync(path.resolve("build", "installer.nsh"), "utf8");

    expect(include).toContain("customRemoveFiles");
    expect(include).toContain("PDF_APPROVAL_INSTALL_DIR");
    expect(include).toContain("'releases'");
    expect(include).toContain("'data'");
    expect(include).toContain("'backups'");
    expect(include).toContain("'logs'");
    expect(include).toContain("'server-config.json'");
    expect(include).not.toContain("RMDir /r $INSTDIR");
  });

  it("builds electron-builder commands from prepackaged portable app directories", () => {
    const workspaceRoot = createWorkspaceRoot();
    const plan = createInstallerBuildPlan({ workspaceRoot });

    expect(plan.client.prepackagedDir).toBe(path.join(workspaceRoot, "dist", "desktop-client", "PDF图纸审批客户端"));
    expect(plan.server.prepackagedDir).toBe(path.join(workspaceRoot, "dist", "server-exe", "PDF图纸审批服务端"));
    expect(plan.client.args).toContain("--prepackaged");
    expect(plan.client.args).toContain(plan.client.prepackagedDir);
    expect(plan.client.args).toContain("--config");
    expect(plan.server.args).toContain("--prepackaged");
    expect(plan.server.args).toContain(plan.server.prepackagedDir);
    expect(plan.server.args).toContain("--win");
    expect(plan.server.args).toContain("nsis");
  });

  it("keeps electron-builder cache inside the workspace", () => {
    const workspaceRoot = "G:\\Work\\PDF审批";
    const env = createInstallerEnv(workspaceRoot, { PATH: "x" });

    expect(env.PATH).toBe("x");
    expect(env.ELECTRON_BUILDER_CACHE).toBe(path.join(workspaceRoot, ".cache", "electron-builder"));
  });
});
