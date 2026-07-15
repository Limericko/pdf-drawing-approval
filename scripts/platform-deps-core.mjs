import { spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_NAME = "pdf-approval-phase1";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(workspaceRoot, "infra", "local", "compose.yaml");
const envFile = path.join(workspaceRoot, "infra", "local", ".env.example");
const rolesFile = path.join(workspaceRoot, "infra", "local", "postgres", "init", "001-roles.sql");
const managedVolumes = [
  { name: "pdf-approval-phase1-postgres-data", composeName: "postgres-data" },
  { name: "pdf-approval-phase1-minio-data", composeName: "minio-data" }
];
const composeArgs = ["compose", "--project-name", PROJECT_NAME, "--env-file", envFile, "-f", composeFile];
const timeouts = {
  context: 10_000,
  config: 15_000,
  status: 15_000,
  up: 180_000,
  provision: 45_000,
  minioInit: 60_000,
  down: 60_000,
  inspect: 10_000,
  remove: 60_000
};

export class UsageError extends Error {}

export function runPlatformDeps({
  action,
  args = [],
  env = process.env,
  runner = createDockerRunner({ cwd: workspaceRoot }),
  writeOutput = (value) => process.stdout.write(value)
}) {
  validateInvocation(action, args, writeOutput);
  const dockerEnv = withoutProjectOverride(env);
  assertLocalDockerEndpoint(dockerEnv, runner);

  if (action === "up") {
    execute(runner, [...composeArgs, "config", "--quiet"], { env: dockerEnv, timeoutMs: timeouts.config });
    execute(runner, [...composeArgs, "up", "-d", "--wait"], { env: dockerEnv, timeoutMs: timeouts.up });
    provisionPostgresRoles(runner, dockerEnv);
    execute(runner, [...composeArgs, "--profile", "tools", "run", "--rm", "minio-init"], {
      env: dockerEnv,
      timeoutMs: timeouts.minioInit
    });
    return;
  }

  if (action === "down") {
    execute(runner, [...composeArgs, "down", "--remove-orphans"], { env: dockerEnv, timeoutMs: timeouts.down });
    return;
  }

  if (action === "status") {
    execute(runner, [...composeArgs, "ps"], { env: dockerEnv, timeoutMs: timeouts.status });
    return;
  }

  resetLocalData(runner, dockerEnv, writeOutput);
}

export function createDockerRunner({ spawnSync = nodeSpawnSync, cwd = workspaceRoot } = {}) {
  return (args, options) => {
    const capture = options.capture === true;
    const input = options.input;
    const result = spawnSync("docker", args, {
      cwd,
      env: options.env,
      input,
      timeout: options.timeoutMs,
      stdio: capture ? [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] : input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
      encoding: "utf8",
      windowsHide: true
    });
    if (result.error?.code === "ETIMEDOUT") {
      throw new Error(
        `Docker command timed out after ${options.timeoutMs} ms: ${formatDockerCommand(args, options.env)}`
      );
    }
    if (result.error) throw new Error(`Docker command could not start: ${redact(String(result.error.message), options.env)}`);
    return {
      status: result.status ?? 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : ""
    };
  };
}

function validateInvocation(action, args, writeOutput) {
  if (!["up", "down", "status", "reset"].includes(action)) {
    throw new UsageError("Usage: node scripts/platform-deps.mjs up|down|status|reset [--confirm-local-data-loss]");
  }
  if (action !== "reset" && args.length > 0) throw new UsageError(`UNKNOWN_ARGUMENT:${args.join(",")}`);
  if (action === "reset" && (args.length !== 1 || args[0] !== "--confirm-local-data-loss")) {
    writeOutput(
      `Managed volumes require explicit confirmation:\n${managedVolumes.map((volume) => `- ${volume.name}`).join("\n")}\n`
    );
    if (args.length > 0) throw new UsageError(`UNKNOWN_ARGUMENT:${args.join(",")}`);
    throw new UsageError("Reset refused. Re-run with --confirm-local-data-loss to inspect and delete only verified local resources.");
  }
}

function withoutProjectOverride(env) {
  const sanitized = { ...env };
  delete sanitized.COMPOSE_PROJECT_NAME;
  return sanitized;
}

function assertLocalDockerEndpoint(env, runner) {
  const configuredHost = env.DOCKER_HOST?.trim();
  if (configuredHost) {
    if (!isLocalNamedPipe(configuredHost)) throw new Error(`LOCAL_DOCKER_REQUIRED:${configuredHost}`);
    return;
  }
  const result = execute(runner, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
    capture: true,
    env,
    timeoutMs: timeouts.context
  });
  const currentHost = result.stdout.trim();
  if (!isLocalNamedPipe(currentHost)) throw new Error(`LOCAL_DOCKER_REQUIRED:${currentHost || "unknown"}`);
}

function isLocalNamedPipe(value) {
  return /^npipe:\/{2,5}\.\/pipe\/[a-z0-9._-]+$/i.test(value);
}

function provisionPostgresRoles(runner, env) {
  const sql = fs.readFileSync(rolesFile, "utf8");
  execute(
    runner,
    [
      ...composeArgs,
      "exec",
      "-T",
      "postgres",
      "sh",
      "-ec",
      'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
    ],
    { env, input: sql, timeoutMs: timeouts.provision }
  );
}

function resetLocalData(runner, env, writeOutput) {
  const containers = inspectProjectContainers(runner, env);
  const volumes = inspectManagedVolumes(runner, env);

  writeOutput("Verified local resources scheduled for deletion:\n");
  for (const container of containers) writeOutput(`- container ${container.name} (${container.id})\n`);
  for (const volume of volumes) writeOutput(`- volume ${volume.name}\n`);
  if (containers.length === 0 && volumes.length === 0) writeOutput("- none\n");

  if (containers.length > 0) {
    execute(runner, ["rm", "--force", ...containers.map((container) => container.id)], {
      env,
      timeoutMs: timeouts.remove
    });
  }
  if (volumes.length > 0) {
    execute(runner, ["volume", "rm", ...volumes.map((volume) => volume.name)], {
      env,
      timeoutMs: timeouts.remove
    });
  }
}

function inspectProjectContainers(runner, env) {
  const listed = execute(
    runner,
    ["ps", "-a", "--filter", `label=com.docker.compose.project=${PROJECT_NAME}`, "--format", "{{.ID}}"],
    { capture: true, env, timeoutMs: timeouts.inspect }
  );
  const ids = listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  return ids.map((id) => {
    const inspected = execute(runner, ["inspect", id, "--format", "{{json .}}"], {
      capture: true,
      env,
      timeoutMs: timeouts.inspect
    });
    const record = parseJsonLine(inspected.stdout, `container ${id}`);
    const labels = record.Config?.Labels ?? record.Labels ?? {};
    if (labels["com.docker.compose.project"] !== PROJECT_NAME) throw new Error(`RESOURCE_BOUNDARY_MISMATCH:container:${id}`);
    return { id: record.Id ?? id, name: String(record.Name ?? id).replace(/^\//, "") };
  });
}

function inspectManagedVolumes(runner, env) {
  const verified = [];
  for (const expected of managedVolumes) {
    const result = runner(["volume", "inspect", expected.name, "--format", "{{json .}}"], {
      capture: true,
      env,
      timeoutMs: timeouts.inspect
    });
    if (result.status !== 0 && /no such volume/i.test(result.stderr || "")) continue;
    assertSuccessfulResult(result, ["volume", "inspect", expected.name], env);
    const record = parseJsonLine(result.stdout, `volume ${expected.name}`);
    const labels = record.Labels ?? {};
    if (
      record.Name !== expected.name ||
      labels["com.docker.compose.project"] !== PROJECT_NAME ||
      labels["com.docker.compose.volume"] !== expected.composeName
    ) {
      throw new Error(`RESOURCE_BOUNDARY_MISMATCH:volume:${expected.name}`);
    }
    verified.push(expected);
  }
  return verified;
}

function execute(runner, args, options) {
  const result = runner(args, { capture: false, ...options });
  assertSuccessfulResult(result, args, options.env);
  return result;
}

function assertSuccessfulResult(result, args, env) {
  if (result.error) throw result.error;
  if (result.status === 0) return;
  const detail = redact((result.stderr || result.stdout || "").trim(), env);
  throw new Error(`Docker command failed: ${formatDockerCommand(args, env)}${detail ? `\n${detail}` : ""}`);
}

function parseJsonLine(value, description) {
  const line = value.trim().split(/\r?\n/, 1)[0];
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`DOCKER_INSPECT_INVALID:${description}`);
  }
}

function formatDockerCommand(args, env) {
  return redact(`docker ${args.join(" ")}`, env);
}

function redact(value, env) {
  let redacted = String(value).replace(/(\w+:\/\/[^:\s]+:)[^@\s]+@/g, "$1[REDACTED]@");
  for (const [key, secret] of Object.entries(env ?? {})) {
    if (!/(PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL)/i.test(key) || typeof secret !== "string" || secret.length < 4) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}
