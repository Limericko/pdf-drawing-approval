import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workerMain } from "../../../src/server/platform/jobs/workerMain.ts";
import { createStorage } from "../../../src/server/platform/storage/createStorage.ts";
import { createPrefixedStorage } from "./storage.ts";

const WORKER_CHILD_ARGUMENT = "--platform-e2e-worker-child";
const WORKER_STOP_TIMEOUT_MS = 5_000;

export type PlatformE2EWorker = { readonly processId: number; stop(): Promise<void> };

export function startPlatformE2EWorker(env: NodeJS.ProcessEnv, options: { readonly storagePrefix: string }): PlatformE2EWorker {
  const child = fork(fileURLToPath(import.meta.url), [WORKER_CHILD_ARGUMENT, options.storagePrefix], {
    env,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"]
  });
  let stopInFlight: Promise<void> | undefined;
  return Object.freeze({
    processId: child.pid ?? 0,
    stop() {
      stopInFlight ??= stopWorkerChild(child);
      return stopInFlight;
    }
  });
}

async function stopWorkerChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode && child.exitCode !== 0) throw new Error("PLATFORM_E2E_WORKER_EXITED");
    return;
  }
  child.send({ type: "shutdown" });
  const exit = waitForExit(child);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("PLATFORM_E2E_WORKER_STOP_TIMEOUT")), WORKER_STOP_TIMEOUT_MS);
    timer.unref();
  });
  try {
    const result = await Promise.race([exit, timeout]);
    if (result.code !== 0) throw new Error("PLATFORM_E2E_WORKER_EXITED");
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitForExit(child: ChildProcess) {
  return new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function runWorkerChild() {
  const storagePrefix = process.argv[3];
  if (!storagePrefix) throw new Error("PLATFORM_E2E_STORAGE_PREFIX_MISSING");
  const controller = new AbortController();
  const stop = () => controller.abort();
  const onMessage = (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "shutdown") {
      controller.abort();
    }
  };
  process.on("message", onMessage);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await workerMain(process.env, {
      storageFactory: (config) => createPrefixedStorage(createStorage(config), storagePrefix),
      signal: controller.signal
    });
  } finally {
    process.removeListener("message", onMessage);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (process.argv[2] === WORKER_CHILD_ARGUMENT) {
  runWorkerChild().then(
    () => { process.exitCode = 0; },
    (error: unknown) => {
      process.stderr.write(`${formatPlatformE2EWorkerFailure(error)}\n`);
      process.exitCode = 1;
    }
  );
}

const E2E_WORKER_FAILURE_CODES = new Set([
  "PLATFORM_E2E_DEPENDENCY_NOT_LOCAL",
  "PLATFORM_E2E_STORAGE_PREFIX_MISSING",
  "PLATFORM_E2E_STORAGE_PREFIX_INVALID",
  "WORKER_POOL_CAPACITY_INSUFFICIENT"
]);

export function formatPlatformE2EWorkerFailure(error: unknown) {
  const candidate = error instanceof Error ? error.message : undefined;
  return candidate && E2E_WORKER_FAILURE_CODES.has(candidate) ? candidate : "PLATFORM_E2E_WORKER_FAILED";
}
