import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function createUpdateManifest(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const outputDir = path.resolve(options.outputDir ?? path.join(workspaceRoot, "dist", "updates"));
  const rootPackage = readJson(path.join(workspaceRoot, "package.json"));
  const changelogPath = path.join(workspaceRoot, "CHANGELOG.md");
  const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, "utf8") : "";
  const notes = extractLatestNotes(changelog, rootPackage.version);
  const clientInstaller = findInstaller(workspaceRoot, "client", rootPackage.version);
  const serverInstaller = findInstaller(workspaceRoot, "server", rootPackage.version);

  const manifest = {
    appName: "PDF图纸审批",
    version: rootPackage.version,
    channel: "stable",
    releaseDate: releaseDateFor(changelog, rootPackage.version),
    minimumApiCompatVersion: 1,
    notes,
    changelogUrl: "CHANGELOG.md",
    downloads: {
      clientInstaller: clientInstaller ? toPosixRelative(outputDir, clientInstaller) : undefined,
      serverInstaller: serverInstaller ? toPosixRelative(outputDir, serverInstaller) : undefined
    }
  };

  fs.mkdirSync(outputDir, { recursive: true });
  syncElectronUpdaterFeed(workspaceRoot, outputDir, rootPackage.version);
  fs.writeFileSync(path.join(outputDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (changelog) fs.writeFileSync(path.join(outputDir, "CHANGELOG.md"), changelog, "utf8");

  return { manifest, outputPath: path.join(outputDir, "latest.json") };
}

function syncElectronUpdaterFeed(workspaceRoot, outputDir, version) {
  const clientInstallerDir = path.join(workspaceRoot, "dist", "installers", "client");
  const clientInstallerName = `PDF图纸审批客户端-安装包-${version}.exe`;
  const files = [
    "latest.yml",
    clientInstallerName,
    `${clientInstallerName}.blockmap`
  ];

  for (const fileName of files) {
    const sourcePath = path.join(clientInstallerDir, fileName);
    if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
      fs.copyFileSync(sourcePath, path.join(outputDir, fileName));
    }
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findInstaller(workspaceRoot, kind, version) {
  const subdir = kind === "client" ? "client" : "server";
  const label = kind === "client" ? "客户端" : "服务端";
  const outputDir = path.join(workspaceRoot, "dist", "installers", subdir);
  if (!fs.existsSync(outputDir)) return null;
  const expectedName = `PDF图纸审批${label}-安装包-${version}.exe`;
  const expectedPath = path.join(outputDir, expectedName);
  if (fs.existsSync(expectedPath)) return expectedPath;
  return (
    fs
      .readdirSync(outputDir)
      .filter((name) => name.endsWith(".exe") && name.includes(`PDF图纸审批${label}-安装包-`))
      .map((name) => path.join(outputDir, name))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0] ?? null
  );
}

function extractLatestNotes(changelog, version) {
  const section = changelogSection(changelog, version);
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function releaseDateFor(changelog, version) {
  const match = changelog.match(new RegExp(`^##\\s+${escapeRegExp(version)}\\s+-\\s+(.+)$`, "m"));
  return match?.[1]?.trim() ?? new Date().toISOString().slice(0, 10);
}

function changelogSection(changelog, version) {
  const startMatch = new RegExp(`^##\\s+${escapeRegExp(version)}\\b.*$`, "m").exec(changelog);
  if (!startMatch) return "";
  const start = startMatch.index + startMatch[0].length;
  const rest = changelog.slice(start);
  const next = /^##\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function toPosixRelative(fromDir, targetPath) {
  return path.relative(fromDir, targetPath).split(path.sep).join("/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = createUpdateManifest();
  console.log(`Update manifest created: ${result.outputPath}`);
}
