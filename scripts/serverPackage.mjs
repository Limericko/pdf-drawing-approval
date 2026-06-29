import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageFolderName = "PDF图纸审批服务端";
const runtimeDependencyNames = [
  "@pdf-lib/fontkit",
  "bcryptjs",
  "chokidar",
  "express",
  "jsonwebtoken",
  "nodemailer",
  "pdf-lib",
  "zod"
];

export function createServerPackage(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const outputRoot = path.resolve(options.outputRoot ?? path.join(workspaceRoot, "dist", "server-package"));
  const packageDir = path.join(outputRoot, packageFolderName);

  assertFile(path.join(workspaceRoot, "src", "server", "index.ts"), "Server source is missing.");
  assertFile(path.join(workspaceRoot, "dist", "client", "index.html"), "Client build is missing. Run npm run build first.");
  assertFile(path.join(workspaceRoot, "scripts", "dev-server.mjs"), "Server supervisor script is missing.");

  fs.rmSync(packageDir, { recursive: true, force: true });
  fs.mkdirSync(packageDir, { recursive: true });

  copyDirectory(path.join(workspaceRoot, "src", "server"), path.join(packageDir, "src", "server"));
  copyDirectory(path.join(workspaceRoot, "dist", "client"), path.join(packageDir, "dist", "client"));
  copySelectedFiles(path.join(workspaceRoot, "scripts"), path.join(packageDir, "scripts"), [
    "dev-server.mjs",
    "start-server.ps1",
    "install-startup-task.ps1",
    "backup-database.ps1"
  ]);

  fs.writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify(createPackageJson(workspaceRoot), null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(packageDir, "部署说明.txt"), deploymentReadme(), "utf8");
  fs.mkdirSync(path.join(packageDir, "data"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "backups"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "logs"), { recursive: true });

  return { packageDir };
}

function createPackageJson(workspaceRoot) {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
  const dependencies = {};
  for (const name of runtimeDependencyNames) {
    if (rootPackage.dependencies?.[name]) dependencies[name] = rootPackage.dependencies[name];
  }
  if (rootPackage.devDependencies?.tsx) dependencies.tsx = rootPackage.devDependencies.tsx;

  return {
    name: "pdf-approval-server-package",
    version: rootPackage.version ?? "0.1.0",
    private: true,
    type: "module",
    scripts: {
      start: "node scripts/dev-server.mjs",
      dev: "node scripts/dev-server.mjs"
    },
    dependencies
  };
}

function deploymentReadme() {
  return [
    "PDF 图纸审批服务端",
    "",
    "首次部署：",
    "1. 安装 Node.js。",
    "2. 在本目录执行 npm install --omit=dev --registry=https://registry.npmmirror.com。",
    "3. 执行 powershell -ExecutionPolicy Bypass -File scripts\\start-server.ps1。",
    "4. 浏览器访问 http://本机IP:8080/health，确认返回 {\"ok\":true}。",
    "",
    "开机启动：",
    "powershell -ExecutionPolicy Bypass -File scripts\\install-startup-task.ps1",
    "",
    "数据目录：data",
    "备份目录：backups",
    "服务日志：server.log / server.err.log",
    ""
  ].join("\r\n");
}

function assertFile(filePath, message) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(message);
  }
}

function copySelectedFiles(sourceDir, targetDir, fileNames) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const fileName of fileNames) {
    copyIfExists(path.join(sourceDir, fileName), path.join(targetDir, fileName));
  }
}

function copyIfExists(source, target) {
  if (fs.existsSync(source) && fs.statSync(source).isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
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
  const result = createServerPackage();
  console.log(`Server package created: ${result.packageDir}`);
}
