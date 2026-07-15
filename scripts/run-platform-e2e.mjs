import { fork as nodeFork, spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configArgs = ["test", "--config", "playwright.platform.config.ts"];
const defaultGroups = Object.freeze([
  ["--project=desktop-chromium", "e2e/platform/identity-security.spec.ts"],
  ["--project=desktop-chromium", "e2e/platform/session-csrf.spec.ts", "e2e/platform/project-access.spec.ts",
    "e2e/platform/business-workflow.spec.ts"],
  ["--project=mobile-chromium", "e2e/platform/identity-security.spec.ts"]
]);
const READY_MARKER = "PLATFORM_E2E_READY ";
const DEFAULT_TIMEOUT_MS = 30_000;

export function resolvePlatformE2ECommands(args) {
  const groups = args.length > 0 ? [Array.from(args)] : defaultGroups;
  return groups.map((group) => [...configArgs, ...group]);
}

export async function runPlatformE2E(args, options = {}) {
  for (const command of resolvePlatformE2ECommands(args)) {
    const status = await runPlatformE2EGroup(command, options);
    if (status !== 0) return status;
  }
  return 0;
}

async function runPlatformE2EGroup(command, options) {
  const harness = startHarness(options);
  let failure;
  let status;
  try {
    await harness.ready;
    status = await runPlaywright(command, options);
  } catch (error) {
    failure = error;
  }

  try {
    await stopHarness(harness.child, options.shutdownTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (cleanupError) {
    if (failure) throw new AggregateError([failure, cleanupError], errorCode(failure));
    throw cleanupError;
  }
  if (failure) throw failure;
  return status;
}

function startHarness(options) {
  const cwd = options.cwd ?? process.cwd();
  const fork = options.fork ?? nodeFork;
  const serverPath = options.serverPath ?? path.resolve(cwd, "e2e/platform/support/server.ts");
  const envFile = path.resolve(cwd, "infra/local/.env.example");
  const child = fork(serverPath, [], {
    cwd,
    env: options.env ?? process.env,
    execArgv: [`--env-file=${envFile}`, "--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  forward(child.stdout, options.stdout ?? process.stdout);
  forward(child.stderr, options.stderr ?? process.stderr);
  return {
    child,
    ready: waitForHarnessReady(child, options.readinessTimeoutMs ?? DEFAULT_TIMEOUT_MS)
  };
}

function waitForHarnessReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-4096);
      if (output.includes(READY_MARKER)) finish(resolve);
    };
    const onError = (error) => finish(() => reject(stableError("PLATFORM_E2E_HARNESS_START_FAILED", error)));
    const onExit = () => finish(() => reject(new Error("PLATFORM_E2E_HARNESS_EXITED_BEFORE_READY")));
    const onMessage = (message) => {
      if (message && typeof message === "object" && message.type === "startup-failed") {
        finish(() => reject(new Error("PLATFORM_E2E_HARNESS_START_FAILED")));
      }
    };
    const timer = setTimeout(() => finish(() => reject(new Error("PLATFORM_E2E_HARNESS_START_TIMEOUT"))), timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);

    function finish(action) {
      clearTimeout(timer);
      child.stdout?.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("message", onMessage);
      action();
    }
  });
}

function runPlaywright(command, options) {
  const spawn = options.spawn ?? nodeSpawn;
  const cwd = options.cwd ?? process.cwd();
  const playwrightCli = options.playwrightCli ?? path.resolve(cwd, "node_modules/@playwright/test/cli.js");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [playwrightCli, ...command], {
        cwd,
        env: options.env ?? process.env,
        stdio: "inherit",
        shell: false
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function stopHarness(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.reject(new Error("PLATFORM_E2E_HARNESS_EXITED_BEFORE_CLEANUP_ACK"));
  }
  return new Promise((resolve, reject) => {
    let acknowledged = false;
    let acknowledgementExitCode;
    let exited = false;
    let childExitCode;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      finish(() => reject(new Error("PLATFORM_E2E_HARNESS_SHUTDOWN_TIMEOUT")));
    }, timeoutMs);
    timer.unref?.();

    const onMessage = (message) => {
      if (!message || typeof message !== "object" || message.type !== "shutdown-complete") return;
      acknowledged = true;
      acknowledgementExitCode = message.exitCode;
      completeIfReady();
    };
    const onExit = (code) => {
      exited = true;
      childExitCode = code;
      if (!acknowledged) {
        finish(() => reject(new Error("PLATFORM_E2E_HARNESS_EXITED_BEFORE_CLEANUP_ACK")));
        return;
      }
      completeIfReady();
    };
    const onError = (error) => finish(() => reject(stableError("PLATFORM_E2E_HARNESS_SHUTDOWN_FAILED", error)));
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);

    try {
      child.send({ type: "shutdown" }, (error) => {
        if (error) finish(() => reject(stableError("PLATFORM_E2E_HARNESS_SHUTDOWN_SEND_FAILED", error)));
      });
    } catch (error) {
      finish(() => reject(stableError("PLATFORM_E2E_HARNESS_SHUTDOWN_SEND_FAILED", error)));
    }

    function completeIfReady() {
      if (!acknowledged || !exited) return;
      if (acknowledgementExitCode !== 0 || childExitCode !== 0) {
        finish(() => reject(new Error("PLATFORM_E2E_HARNESS_CLEANUP_FAILED")));
        return;
      }
      finish(resolve);
    }

    function finish(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      action();
    }
  });
}

function forward(source, destination) {
  source?.on("data", (chunk) => destination.write(chunk));
}

function stableError(code, cause) {
  return new Error(code, { cause });
}

function errorCode(error) {
  return error instanceof Error ? error.message : "PLATFORM_E2E_RUN_FAILED";
}

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  runPlatformE2E(process.argv.slice(2)).then(
    (status) => { process.exitCode = status; },
    (error) => {
      process.stderr.write(`${errorCode(error)}\n`);
      process.exitCode = 1;
    }
  );
}
