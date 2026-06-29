import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAppIcons, copyAppIconsToPackage, patchExecutableIcon } from "./appIcons.mjs";

const packageFolderName = "PDF图纸审批服务端";
const executableName = "PDF图纸审批服务端.exe";

export function createServerExePackage(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const outputRoot = path.resolve(options.outputRoot ?? path.join(workspaceRoot, "dist", "server-exe"));
  const electronDist = path.join(workspaceRoot, "node_modules", "electron", "dist");
  const appSource = path.join(workspaceRoot, "apps", "server-exe");
  const serverBundle = path.join(workspaceRoot, "dist", "server-electron", "server", "index.js");
  const clientDist = path.join(workspaceRoot, "dist", "client");
  const schemaPath = path.join(workspaceRoot, "src", "server", "schema.sql");
  const packageDir = path.join(outputRoot, packageFolderName);
  const appTarget = path.join(packageDir, "resources", "app");

  assertFile(path.join(electronDist, "electron.exe"), "Electron runtime is missing. Run node node_modules\\electron\\install.js first.");
  assertFile(path.join(appSource, "main.cjs"), "Server exe main.cjs is missing.");
  assertFile(path.join(appSource, "package.json"), "Server exe package.json is missing.");
  assertFile(path.join(clientDist, "index.html"), "Client build is missing. Run npm run build first.");
  assertFile(schemaPath, "Server schema.sql is missing.");
  const icons = assertAppIcons("server", workspaceRoot);

  if (!options.skipBundle) {
    bundleServer(workspaceRoot, serverBundle);
  }
  assertFile(serverBundle, "Server bundle is missing. Run npm run server:exe first.");

  fs.rmSync(packageDir, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  copyDirectory(electronDist, packageDir);
  fs.rmSync(path.join(packageDir, "electron.exe"), { force: true });
  fs.copyFileSync(path.join(electronDist, "electron.exe"), path.join(packageDir, executableName));

  fs.mkdirSync(appTarget, { recursive: true });
  for (const fileName of ["main.cjs", "preload.cjs", "serverRuntimeConfig.cjs", "serverConsoleView.cjs", "lanAddress.cjs", "package.json"]) {
    fs.copyFileSync(path.join(appSource, fileName), path.join(appTarget, fileName));
  }
  fs.mkdirSync(path.join(appTarget, "server"), { recursive: true });
  fs.copyFileSync(serverBundle, path.join(appTarget, "server", "index.js"));
  fs.mkdirSync(path.join(appTarget, "src", "server"), { recursive: true });
  fs.copyFileSync(schemaPath, path.join(appTarget, "src", "server", "schema.sql"));
  copyAppIconsToPackage(workspaceRoot, appTarget);
  copyDirectory(clientDist, path.join(appTarget, "dist", "client"));

  patchExecutableIcon({
    workspaceRoot,
    executablePath: path.join(packageDir, executableName),
    iconPath: icons.ico,
    skip: options.skipIconPatch
  });

  for (const dirName of ["data", "backups", "logs", path.join("releases", "updates"), path.join("releases", "installers", "client"), path.join("releases", "installers", "server")]) {
    fs.mkdirSync(path.join(packageDir, dirName), { recursive: true });
  }

  fs.writeFileSync(path.join(packageDir, "启动说明.txt"), startupReadme(), "utf8");

  return { packageDir, executablePath: path.join(packageDir, executableName) };
}

function bundleServer(workspaceRoot, outputFile) {
  const esbuildCommand = resolveEsbuildCommand(workspaceRoot);
  fs.rmSync(path.dirname(outputFile), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  const result = spawnSync(
    esbuildCommand.executable,
    [
      ...esbuildCommand.args,
      "src/server/serverExeEntry.ts",
      "--bundle",
      "--platform=node",
      "--target=node24",
      "--format=cjs",
      `--outfile=${path.relative(workspaceRoot, outputFile)}`,
      "--external:node:*",
      "--log-level=info"
    ],
    {
      cwd: workspaceRoot,
      stdio: "inherit",
      shell: false
    }
  );

  if (result.status !== 0) {
    throw new Error(`Server bundle failed with exit code ${result.status ?? "unknown"}.`);
  }
}

export function resolveEsbuildCommand(workspaceRoot) {
  const binPath = path.join(workspaceRoot, "node_modules", "esbuild", "bin", "esbuild");
  assertFile(binPath, "esbuild is missing. Run npm install first.");
  return { executable: process.execPath, args: [binPath] };
}

function startupReadme() {
  return [
    "PDF 图纸审批服务端（免 Node 版）",
    "",
    `双击 ${executableName} 启动服务。`,
    "关闭服务端窗口会隐藏到系统托盘，审批服务仍在后台运行。",
    "需要停止服务时，请在系统托盘菜单选择“退出服务端”。",
    "",
    "首次部署：",
    "1. 将整个 PDF图纸审批服务端 文件夹复制到服务器电脑。",
    `2. 双击 ${executableName}。`,
    "3. 在服务端窗口点击“打开本机工作台”，用 admin / admin123 登录。",
    "4. 在系统设置里配置审批根目录、签名、用户等信息。",
    "5. 其他电脑访问窗口中显示的局域网地址，例如 http://192.168.1.20:8080。",
    "",
    "目录说明：",
    "data：数据库和上传文件",
    "backups：数据库备份",
    "logs：服务日志，管理端服务日志也读取这里",
    "releases：内网更新发布目录，包含 updates 和 installers",
    "",
    "在线更新发布：",
    "1. 将 latest.json 和 CHANGELOG.md 放入 releases\\updates。",
    "2. 将客户端安装包放入 releases\\installers\\client。",
    "3. 将服务端安装包放入 releases\\installers\\server。",
    "4. 服务端会自动通过 http://服务器IP:端口/updates/latest.json 提供更新清单，网页端无需填写更新地址。",
    "",
    "端口设置：",
    "服务端窗口右侧可以修改 HTTP 端口，点击“保存并重启”后生效。",
    "端口配置保存到 server-config.json。",
    "如启动前设置了环境变量 PORT，会优先使用环境变量。",
    ""
  ].join("\r\n");
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = createServerExePackage();
  console.log(`Server exe package created: ${result.packageDir}`);
}
