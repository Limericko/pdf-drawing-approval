import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const appIconFiles = {
  client: {
    png: "pdf-approval-client.png",
    ico: "pdf-approval-client.ico"
  },
  server: {
    png: "pdf-approval-server.png",
    ico: "pdf-approval-server.ico"
  }
};

export function getIconAssetDir(workspaceRoot = defaultWorkspaceRoot()) {
  return path.join(workspaceRoot, "assets", "icons");
}

export function getIconPaths(kind, workspaceRoot = defaultWorkspaceRoot()) {
  const files = appIconFiles[kind];
  if (!files) throw new Error(`Unknown app icon kind: ${kind}`);
  const directory = getIconAssetDir(workspaceRoot);
  return {
    directory,
    png: path.join(directory, files.png),
    ico: path.join(directory, files.ico)
  };
}

export function assertAppIcons(kind, workspaceRoot = defaultWorkspaceRoot()) {
  const icons = getIconPaths(kind, workspaceRoot);
  assertFile(icons.png, `${kind} PNG icon is missing. Run npm run icons:generate first.`);
  assertFile(icons.ico, `${kind} ICO icon is missing. Run npm run icons:generate first.`);
  return icons;
}

export function copyAppIconsToPackage(workspaceRoot, appTarget) {
  const source = getIconAssetDir(workspaceRoot);
  const target = path.join(appTarget, "assets", "icons");

  assertAppIcons("client", workspaceRoot);
  assertAppIcons("server", workspaceRoot);
  copyDirectory(source, target);
  return target;
}

export function patchExecutableIcon(options) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? defaultWorkspaceRoot());
  const executablePath = path.resolve(options.executablePath);
  const iconPath = path.resolve(options.iconPath);

  if (options.skip) {
    return { skipped: true, executablePath, iconPath };
  }
  if (process.platform !== "win32") {
    return { skipped: true, reason: "rcedit only runs on Windows.", executablePath, iconPath };
  }

  assertFile(executablePath, `Executable is missing: ${executablePath}`);
  assertFile(iconPath, `ICO icon is missing: ${iconPath}`);

  const rceditPath = path.join(workspaceRoot, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");
  assertFile(rceditPath, "rcedit.exe is missing. Run npm install first.");

  if (requiresAsciiRelay([executablePath, iconPath])) {
    return patchExecutableIconViaAsciiRelay({ workspaceRoot, executablePath, iconPath, rceditPath });
  }

  runRcedit(rceditPath, executablePath, iconPath, workspaceRoot);
  return { skipped: false, executablePath, iconPath, rceditPath };
}

function patchExecutableIconViaAsciiRelay(options) {
  const tempBase = path.join(path.parse(options.workspaceRoot).root, "pdf-approval-rcedit-cache");
  fs.mkdirSync(tempBase, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tempBase, "job-"));
  const tempExe = path.join(tempDir, "app.exe");
  const tempIcon = path.join(tempDir, "app.ico");

  try {
    fs.copyFileSync(options.executablePath, tempExe);
    fs.copyFileSync(options.iconPath, tempIcon);
    runRcedit(options.rceditPath, tempExe, tempIcon, options.workspaceRoot);
    fs.copyFileSync(tempExe, options.executablePath);
    return {
      skipped: false,
      relayed: true,
      executablePath: options.executablePath,
      iconPath: options.iconPath,
      rceditPath: options.rceditPath
    };
  } finally {
    removeTempDir(tempDir, tempBase);
  }
}

function runRcedit(rceditPath, executablePath, iconPath, workspaceRoot) {
  const result = spawnSync(rceditPath, [executablePath, "--set-icon", iconPath], {
    cwd: workspaceRoot,
    stdio: "inherit",
    shell: false
  });

  if (result.status !== 0) {
    throw new Error(`Failed to set executable icon for ${path.basename(executablePath)}.`);
  }
}

function requiresAsciiRelay(paths) {
  return paths.some((item) => /[^\x00-\x7F]/.test(item));
}

function removeTempDir(tempDir, tempBase) {
  const resolvedTempDir = path.resolve(tempDir);
  const resolvedTempBase = path.resolve(tempBase);
  if (!resolvedTempDir.startsWith(`${resolvedTempBase}${path.sep}`)) {
    throw new Error(`Refusing to remove unexpected temp directory: ${resolvedTempDir}`);
  }
  fs.rmSync(resolvedTempDir, { recursive: true, force: true });
}

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function assertFile(filePath, message) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(message);
  }
}

function defaultWorkspaceRoot() {
  return path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
