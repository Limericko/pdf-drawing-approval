import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectLegacyDatabase } from "../../src/server/platform/migration/legacyInventory.ts";

type Options = { databasePath: string; sourceId: string; outputPath: string };

export async function runLegacyInventoryCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const report = await inspectLegacyDatabase({ databasePath: options.databasePath, sourceId: options.sourceId });
  await mkdir(path.dirname(options.outputPath), { recursive: true, mode: 0o700 });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode: 0o600
  });
  process.stdout.write(`LEGACY_INVENTORY_COMPLETE eligible=${report.eligibleForPreflight} blocking=${report.blockingIssueCount}\n`);
  if (!report.eligibleForPreflight) process.exitCode = 2;
}

function parseArguments(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!name || !value || !["--database", "--source-id", "--output"].includes(name) || values.has(name)) invalid();
    values.set(name, value);
  }
  const databasePath = values.get("--database");
  const sourceId = values.get("--source-id");
  const outputPath = values.get("--output");
  if (!databasePath || !sourceId || !outputPath || !path.isAbsolute(outputPath)) invalid();
  return { databasePath, sourceId, outputPath: path.normalize(outputPath) };
}

function invalid(): never {
  const error = new Error("LEGACY_INVENTORY_ARGUMENTS_INVALID");
  Object.defineProperty(error, "code", { value: "LEGACY_INVENTORY_ARGUMENTS_INVALID", enumerable: true });
  throw error;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void runLegacyInventoryCli().catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : "LEGACY_INVENTORY_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
