import path from "node:path";
import { pathToFileURL } from "node:url";
import { createLegacySnapshot } from "../../src/server/platform/migration/legacySnapshot.ts";

export async function runLegacySnapshotCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = await createLegacySnapshot(options);
  process.stdout.write(`LEGACY_SNAPSHOT_COMPLETE size=${result.sizeBytes} sha256=${result.sha256}\n`);
}

function parseArguments(argv: readonly string[]) {
  if (argv.length !== 4 || argv[0] !== "--source" || argv[2] !== "--target" || !argv[1] || !argv[3]) invalid();
  return { sourcePath: argv[1], targetPath: argv[3] };
}

function invalid(): never {
  const error = new Error("LEGACY_SNAPSHOT_ARGUMENTS_INVALID");
  Object.defineProperty(error, "code", { value: "LEGACY_SNAPSHOT_ARGUMENTS_INVALID", enumerable: true });
  throw error;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void runLegacySnapshotCli().catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : "LEGACY_SNAPSHOT_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

