import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { preflightLegacyFiles } from "../../src/server/platform/migration/legacyFilePreflight.ts";

export async function runLegacyFilePreflightCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const roots = await readRoots(options.rootsPath);
  const report = await preflightLegacyFiles({ databasePath: options.databasePath, roots });
  await mkdir(path.dirname(options.outputPath), { recursive: true, mode: 0o700 });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode: 0o600
  });
  process.stdout.write(`LEGACY_FILE_PREFLIGHT_COMPLETE eligible=${report.eligibleForImport} ` +
    `verified=${report.verifiedFiles} blocking=${report.blockingIssueCount}\n`);
  if (!report.eligibleForImport) process.exitCode = 2;
}

function parseArguments(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!name || !value || !["--database", "--roots", "--output"].includes(name) || values.has(name)) invalid();
    values.set(name, value);
  }
  const databasePath = values.get("--database"); const rootsPath = values.get("--roots");
  const outputPath = values.get("--output");
  if (!databasePath || !rootsPath || !outputPath || !path.isAbsolute(rootsPath) || !path.isAbsolute(outputPath)) invalid();
  return { databasePath, rootsPath: path.normalize(rootsPath), outputPath: path.normalize(outputPath) };
}

async function readRoots(filePath: string) {
  let bytes: Buffer;
  try { bytes = await readFile(filePath); } catch { invalid(); }
  if (bytes.byteLength < 2 || bytes.byteLength > 64 * 1024 || bytes.includes(0)) invalid();
  try { return JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
}

function invalid(): never {
  const error = new Error("LEGACY_FILE_PREFLIGHT_ARGUMENTS_INVALID");
  Object.defineProperty(error, "code", { value: "LEGACY_FILE_PREFLIGHT_ARGUMENTS_INVALID", enumerable: true });
  throw error;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void runLegacyFilePreflightCli().catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : "LEGACY_FILE_PREFLIGHT_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

