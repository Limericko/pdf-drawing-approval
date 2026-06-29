import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAppIcons, copyAppIconsToPackage, patchExecutableIcon } from "./appIcons.mjs";

const packageFolderName = "PDF图纸审批客户端";
const executableName = "PDF图纸审批客户端.exe";

export function createPortableDesktopPackage(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const outputRoot = path.resolve(options.outputRoot ?? path.join(workspaceRoot, "dist", "desktop-client"));
  const electronDist = path.join(workspaceRoot, "node_modules", "electron", "dist");
  const appSource = path.join(workspaceRoot, "apps", "desktop-client");
  const clientDist = path.join(workspaceRoot, "dist", "client");
  const packageDir = path.join(outputRoot, packageFolderName);
  const appTarget = path.join(packageDir, "resources", "app");

  assertFile(path.join(electronDist, "electron.exe"), "Electron runtime is missing. Run node node_modules\\electron\\install.js first.");
  assertFile(path.join(appSource, "main.cjs"), "Desktop client main.cjs is missing.");
  assertFile(path.join(clientDist, "index.html"), "Client build is missing. Run npm run build first.");
  const icons = assertAppIcons("client", workspaceRoot);

  fs.rmSync(packageDir, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  copyDirectory(electronDist, packageDir);
  fs.rmSync(path.join(packageDir, "electron.exe"), { force: true });
  fs.copyFileSync(path.join(electronDist, "electron.exe"), path.join(packageDir, executableName));

  fs.mkdirSync(appTarget, { recursive: true });
  for (const fileName of ["main.cjs", "preload.cjs", "desktopConfig.cjs", "package.json"]) {
    fs.copyFileSync(path.join(appSource, fileName), path.join(appTarget, fileName));
  }
  copyPackageDependencyClosure(workspaceRoot, appTarget, ["electron-updater"]);
  copyAppIconsToPackage(workspaceRoot, appTarget);
  copyDirectory(clientDist, path.join(appTarget, "dist", "client"));

  patchExecutableIcon({
    workspaceRoot,
    executablePath: path.join(packageDir, executableName),
    iconPath: icons.ico,
    skip: options.skipIconPatch
  });

  fs.writeFileSync(
    path.join(packageDir, "启动说明.txt"),
    [
      "PDF 图纸审批客户端",
      "",
      `双击 ${executableName} 启动。`,
      "首次启动填写审批服务器地址，例如 http://192.168.1.20:8080。",
      "服务端仍负责数据库、坚果云目录监听、PDF 签名和审批权限。",
      ""
    ].join("\r\n"),
    "utf8"
  );

  return { packageDir, executablePath: path.join(packageDir, executableName) };
}

function assertFile(filePath, message) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(message);
  }
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

function copyPackageDependencyClosure(workspaceRoot, appTarget, packageNames) {
  const rootNodeModules = path.join(workspaceRoot, "node_modules");
  const targetNodeModules = path.join(appTarget, "node_modules");
  const copied = new Set();

  for (const packageName of packageNames) {
    copyPackage(packageName, rootNodeModules);
  }

  function copyPackage(packageName, fromDir) {
    const packageDir = resolvePackageDir(rootNodeModules, packageName, fromDir);
    const realPackageDir = fs.realpathSync(packageDir);
    if (copied.has(realPackageDir)) return;
    copied.add(realPackageDir);

    const targetDir = path.join(targetNodeModules, ...packageName.split("/"));
    copyDirectory(packageDir, targetDir);

    const packageJson = readPackageJson(packageDir);
    const dependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.optionalDependencies ?? {})
    };
    for (const dependencyName of Object.keys(dependencies)) {
      copyPackage(dependencyName, packageDir);
    }
  }
}

function resolvePackageDir(rootNodeModules, packageName, fromDir) {
  const packagePathParts = packageName.split("/");
  const candidates = [
    path.join(fromDir, "node_modules", ...packagePathParts),
    path.join(rootNodeModules, ...packagePathParts)
  ];
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
  if (!found) throw new Error(`Required desktop runtime dependency is missing: ${packageName}`);
  return found;
}

function readPackageJson(packageDir) {
  return JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = createPortableDesktopPackage();
  console.log(`Desktop client package created: ${result.packageDir}`);
}
