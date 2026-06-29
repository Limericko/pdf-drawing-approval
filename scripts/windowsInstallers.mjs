import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAppIcons } from "./appIcons.mjs";

const products = {
  client: {
    appId: "local.pdf-approval.desktop-client",
    productName: "PDF图纸审批客户端",
    portableSubdir: path.join("dist", "desktop-client", "PDF图纸审批客户端"),
    outputSubdir: path.join("dist", "installers", "client"),
    shortcutName: "PDF图纸审批客户端",
    artifactName: "PDF图纸审批客户端-安装包-${version}.${ext}",
    executableName: "PDF图纸审批客户端.exe"
  },
  server: {
    appId: "local.pdf-approval.server",
    productName: "PDF图纸审批服务端",
    portableSubdir: path.join("dist", "server-exe", "PDF图纸审批服务端"),
    outputSubdir: path.join("dist", "installers", "server"),
    shortcutName: "PDF图纸审批服务端",
    artifactName: "PDF图纸审批服务端-安装包-${version}.${ext}",
    executableName: "PDF图纸审批服务端.exe"
  }
};

export function createInstallerConfig(kind, workspaceRoot = defaultWorkspaceRoot()) {
  const product = getProduct(kind);
  const icons = assertAppIcons(kind, workspaceRoot);

  const config = {
    appId: product.appId,
    productName: product.productName,
    copyright: "Copyright © 2026 PDF Approval Team",
    directories: {
      output: path.join(workspaceRoot, product.outputSubdir)
    },
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      icon: icons.ico,
      artifactName: product.artifactName
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: product.shortcutName,
      uninstallDisplayName: product.shortcutName,
      installerIcon: icons.ico,
      uninstallerIcon: icons.ico,
      include: path.join(workspaceRoot, "build", "installer.nsh"),
      deleteAppDataOnUninstall: false
    },
    compression: "normal"
  };

  if (kind === "client") {
    config.publish = [{ provider: "generic", url: "http://127.0.0.1:8080/updates/" }];
  }

  return config;
}

export function createInstallerBuildPlan(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? defaultWorkspaceRoot());
  const configRoot = path.join(workspaceRoot, "dist", "installer-configs");
  const electronBuilderCli = getElectronBuilderCliPath(workspaceRoot);

  return {
    client: createBuildTarget("client", workspaceRoot, configRoot, electronBuilderCli),
    server: createBuildTarget("server", workspaceRoot, configRoot, electronBuilderCli)
  };
}

export function createInstallerEnv(workspaceRoot, baseEnv = process.env) {
  return {
    ...baseEnv,
    ELECTRON_BUILDER_CACHE: path.join(workspaceRoot, ".cache", "electron-builder")
  };
}

export function buildWindowsInstallers(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? defaultWorkspaceRoot());
  const plan = createInstallerBuildPlan({ workspaceRoot });
  fs.mkdirSync(path.join(workspaceRoot, ".cache", "electron-builder"), { recursive: true });
  assertFile(getElectronBuilderCliPath(workspaceRoot), "electron-builder is missing. Run npm install first.");

  for (const target of [plan.client, plan.server]) {
    assertFile(path.join(target.prepackagedDir, target.executableName), `${target.label} portable executable is missing. Build portable packages first.`);
    fs.mkdirSync(path.dirname(target.configPath), { recursive: true });
    fs.writeFileSync(target.configPath, `${JSON.stringify(target.config, null, 2)}\n`, "utf8");
    fs.rmSync(target.config.directories.output, { recursive: true, force: true });

    const result = spawnSync(process.execPath, [target.electronBuilderCli, ...target.args], {
      cwd: workspaceRoot,
      env: createInstallerEnv(workspaceRoot),
      stdio: "inherit",
      shell: false
    });

    if (result.status !== 0) {
      throw new Error(`${target.label} installer build failed with exit code ${result.status ?? "unknown"}.`);
    }
  }

  return {
    clientOutputDir: plan.client.config.directories.output,
    serverOutputDir: plan.server.config.directories.output
  };
}

function createBuildTarget(kind, workspaceRoot, configRoot, electronBuilderCli) {
  const product = getProduct(kind);
  const configPath = path.join(configRoot, `${kind}.electron-builder.json`);
  const prepackagedDir = path.join(workspaceRoot, product.portableSubdir);

  return {
    kind,
    label: product.productName,
    electronBuilderCli,
    prepackagedDir,
    executableName: product.executableName,
    configPath,
    config: createInstallerConfig(kind, workspaceRoot),
    args: ["--win", "nsis", "--prepackaged", prepackagedDir, "--config", configPath, "--publish", "never"]
  };
}

function getElectronBuilderCliPath(workspaceRoot) {
  return path.join(workspaceRoot, "node_modules", "electron-builder", "cli.js");
}

function getProduct(kind) {
  const product = products[kind];
  if (!product) throw new Error(`Unknown installer kind: ${kind}`);
  return product;
}

function assertFile(filePath, message) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(message);
  }
}

function defaultWorkspaceRoot() {
  return path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildWindowsInstallers();
  console.log(`Client installer output: ${result.clientOutputDir}`);
  console.log(`Server installer output: ${result.serverOutputDir}`);
}
