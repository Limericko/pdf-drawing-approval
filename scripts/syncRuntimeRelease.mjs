import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const defaultRuntimeRoot = "E:\\PDF服务端\\pdf-approval";

export function syncRuntimeRelease(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const runtimeRoot = path.resolve(options.runtimeRoot ?? process.env.PDF_APPROVAL_RUNTIME_ROOT ?? defaultRuntimeRoot);
  if (!fs.existsSync(runtimeRoot)) {
    return { skipped: true, reason: "RUNTIME_ROOT_MISSING", runtimeRoot };
  }

  const version = options.version ?? readJson(path.join(workspaceRoot, "package.json")).version;
  const sourceUpdates = path.join(workspaceRoot, "dist", "updates");
  const sourceClientInstaller = path.join(workspaceRoot, "dist", "installers", "client", `PDF图纸审批客户端-安装包-${version}.exe`);
  const sourceServerInstaller = path.join(workspaceRoot, "dist", "installers", "server", `PDF图纸审批服务端-安装包-${version}.exe`);
  const releaseRoot = path.join(runtimeRoot, "releases");
  const targetUpdates = path.join(releaseRoot, "updates");
  const targetClient = path.join(releaseRoot, "installers", "client");
  const targetServer = path.join(releaseRoot, "installers", "server");

  assertFile(path.join(sourceUpdates, "latest.json"));
  assertFile(path.join(sourceUpdates, "CHANGELOG.md"));
  assertFile(path.join(sourceUpdates, "latest.yml"));
  assertFile(path.join(sourceUpdates, path.basename(sourceClientInstaller)));
  assertFile(path.join(sourceUpdates, `${path.basename(sourceClientInstaller)}.blockmap`));
  assertFile(sourceClientInstaller);
  assertFile(sourceServerInstaller);

  fs.mkdirSync(targetUpdates, { recursive: true });
  fs.mkdirSync(targetClient, { recursive: true });
  fs.mkdirSync(targetServer, { recursive: true });
  fs.copyFileSync(path.join(sourceUpdates, "latest.json"), path.join(targetUpdates, "latest.json"));
  fs.copyFileSync(path.join(sourceUpdates, "CHANGELOG.md"), path.join(targetUpdates, "CHANGELOG.md"));
  fs.copyFileSync(path.join(sourceUpdates, "latest.yml"), path.join(targetUpdates, "latest.yml"));
  fs.copyFileSync(path.join(sourceUpdates, path.basename(sourceClientInstaller)), path.join(targetUpdates, path.basename(sourceClientInstaller)));
  fs.copyFileSync(
    path.join(sourceUpdates, `${path.basename(sourceClientInstaller)}.blockmap`),
    path.join(targetUpdates, `${path.basename(sourceClientInstaller)}.blockmap`)
  );
  fs.copyFileSync(sourceClientInstaller, path.join(targetClient, path.basename(sourceClientInstaller)));
  fs.copyFileSync(sourceServerInstaller, path.join(targetServer, path.basename(sourceServerInstaller)));

  return {
    skipped: false,
    runtimeRoot,
    releaseRoot,
    version,
    files: [
      path.join(targetUpdates, "latest.json"),
      path.join(targetUpdates, "CHANGELOG.md"),
      path.join(targetUpdates, "latest.yml"),
      path.join(targetUpdates, path.basename(sourceClientInstaller)),
      path.join(targetUpdates, `${path.basename(sourceClientInstaller)}.blockmap`),
      path.join(targetClient, path.basename(sourceClientInstaller)),
      path.join(targetServer, path.basename(sourceServerInstaller))
    ]
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Required release file is missing: ${filePath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = syncRuntimeRelease();
  if (result.skipped) {
    console.log(`Runtime release sync skipped: ${result.reason} (${result.runtimeRoot})`);
  } else {
    console.log(`Runtime release synced: ${result.releaseRoot}`);
    for (const file of result.files) console.log(`- ${file}`);
  }
}
