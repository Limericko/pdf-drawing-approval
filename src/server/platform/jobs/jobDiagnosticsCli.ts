import { pathToFileURL } from "node:url";
import { v7 as uuidv7 } from "uuid";
import { loadPlatformConfig } from "../config/loadPlatformConfig.ts";
import { loadMigrationFiles } from "../database/migrationFiles.ts";
import { createPlatformPool } from "../database/pool.ts";
import { assertExpectedSchema } from "../database/schemaVersion.ts";
import { withTransaction } from "../database/transaction.ts";
import { JobDiagnostics } from "./jobDiagnostics.ts";

type DiagnosticsPort = {
  summary(): Promise<unknown>;
  listDead(limit?: number): Promise<unknown>;
  retryDead(input: { jobId: string; reason: string; actor: string; requestId: string }): Promise<unknown>;
};

type CliDependencies = {
  readonly diagnostics: DiagnosticsPort;
  readonly output: (value: unknown) => void;
  readonly actor?: string;
  readonly createRequestId?: () => string;
};

export async function runJobDiagnosticsCli(argv: readonly string[], dependencies: CliDependencies) {
  if (!Array.isArray(argv) || !dependencies || typeof dependencies.output !== "function") throw invalidArguments();
  const args = [...argv];
  const command = args.shift();
  if (command === "list" && args.length === 0) {
    dependencies.output(await dependencies.diagnostics.summary());
    return;
  }
  if (command === "dead") {
    const limit = args.length === 0 ? 50 : parseLimit(args);
    dependencies.output(await dependencies.diagnostics.listDead(limit));
    return;
  }
  if (command === "retry") {
    const parsed = parseNamedArguments(args);
    const jobId = parsed.get("--job");
    const reason = parsed.get("--reason");
    if (!jobId || !UUID_V7_PATTERN.test(jobId) || !reason?.trim() || reason !== reason.trim()) throw invalidArguments();
    const result = await dependencies.diagnostics.retryDead({
      jobId,
      reason,
      actor: dependencies.actor ?? "cli-operator",
      requestId: dependencies.createRequestId?.() ?? uuidv7()
    });
    dependencies.output(result);
    return;
  }
  throw invalidArguments();
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseLimit(args: string[]) {
  if (args.length !== 2 || args[0] !== "--limit" || !/^[1-9]\d*$/.test(args[1]!)) throw invalidArguments();
  const limit = Number(args[1]);
  if (!Number.isSafeInteger(limit) || limit > 100) throw invalidArguments();
  return limit;
}

function parseNamedArguments(args: string[]) {
  if (args.length !== 4) throw invalidArguments();
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1]!;
    if ((name !== "--job" && name !== "--reason") || parsed.has(name)) throw invalidArguments();
    parsed.set(name, value);
  }
  if (parsed.size !== 2) throw invalidArguments();
  return parsed;
}

function invalidArguments() { return new Error("INVALID_JOB_DIAGNOSTICS_ARGUMENTS"); }

export async function jobDiagnosticsMain(env: NodeJS.ProcessEnv = process.env, argv = process.argv.slice(2)) {
  const config = loadPlatformConfig(env, "worker");
  const pool = createPlatformPool(config.database, "pdf-approval-job-diagnostics");
  try {
    await assertExpectedSchema(pool, await loadMigrationFiles());
    const diagnostics = new JobDiagnostics({
      executor: pool,
      transactionRunner: (callback) => withTransaction(pool, callback),
      clock: () => new Date(),
      createId: uuidv7
    });
    await runJobDiagnosticsCli(argv, {
      diagnostics,
      output: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
      actor: safeActor(env.USERNAME ?? env.USER ?? "cli-operator"),
      createRequestId: uuidv7
    });
  } finally {
    await pool.end();
  }
}

function safeActor(value: string) {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 255 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : "cli-operator";
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isMainModule()) {
  jobDiagnosticsMain().catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "JOB_DIAGNOSTICS_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
