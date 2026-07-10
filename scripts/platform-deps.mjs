import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(workspaceRoot, "infra", "local", "compose.yaml");
const envFile = path.join(workspaceRoot, "infra", "local", ".env.example");
const rolesFile = path.join(workspaceRoot, "infra", "local", "postgres", "init", "001-roles.sql");
const managedVolumes = ["pdf-approval-phase1-postgres-data", "pdf-approval-phase1-minio-data"];
const composeArgs = ["compose", "--env-file", envFile, "-f", composeFile];

const [action, ...args] = process.argv.slice(2);

function main() {
  try {
    if (action === "up") {
      runDocker([...composeArgs, "up", "-d", "--wait"]);
      provisionPostgresRoles();
      runDocker([...composeArgs, "--profile", "tools", "run", "--rm", "minio-init"]);
    } else if (action === "down") {
      runDocker([...composeArgs, "down", "--remove-orphans"]);
    } else if (action === "status") {
      runDocker([...composeArgs, "ps"]);
    } else if (action === "reset") {
      resetLocalData(args);
    } else {
      throw new UsageError("Usage: node scripts/platform-deps.mjs up|down|status|reset [--confirm-local-data-loss]");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

function provisionPostgresRoles() {
  const sql = fs.readFileSync(rolesFile, "utf8");
  runDocker(
    [
      ...composeArgs,
      "exec",
      "-T",
      "postgres",
      "sh",
      "-ec",
      'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
    ],
    sql
  );
}

function resetLocalData(args) {
  process.stdout.write(`Managed volumes scheduled for deletion:\n${managedVolumes.map((volume) => `- ${volume}`).join("\n")}\n`);
  if (!args.includes("--confirm-local-data-loss")) {
    throw new UsageError("Reset refused. Re-run with --confirm-local-data-loss to delete only the listed local volumes.");
  }
  runDocker([...composeArgs, "down", "--volumes", "--remove-orphans"]);
}

function runDocker(args, input) {
  const result = spawnSync("docker", args, {
    cwd: workspaceRoot,
    env: process.env,
    input,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker command failed with exit code ${result.status ?? "unknown"}.`);
}

class UsageError extends Error {}

main();
