import { spawn as nodeSpawn } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const timeoutExitCode = 124;
export const terminationFailureExitCode = 125;
export const commandErrorExitCode = 127;

const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };

export async function runWithTimeout(timeout, command, args, options = {}) {
  const writeError = options.writeError ?? ((value) => process.stderr.write(value));
  let resolved;
  try {
    resolved = (options.resolveCommand ?? resolveCommand)(command, args);
  } catch (error) {
    writeError(`COMMAND_START_FAILED:${errorMessage(error)}\n`);
    return commandErrorExitCode;
  }

  let child;
  try {
    child = (options.spawnCommand ?? nodeSpawn)(resolved.command, resolved.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
      detached: process.platform !== "win32"
    });
  } catch (error) {
    writeError(`COMMAND_START_FAILED:${errorMessage(error)}\n`);
    return commandErrorExitCode;
  }

  const terminateTree = options.terminateTree ?? terminateProcessTree;
  const signalSource = options.signalSource ?? process;
  const terminationTimeoutMs = options.terminationTimeoutMs ?? 15_000;

  return await new Promise((resolve) => {
    let settled = false;
    let terminating = false;

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signalSource.removeListener?.("SIGINT", onSigint);
      signalSource.removeListener?.("SIGTERM", onSigterm);
      resolve(exitCode);
    };

    const requestTermination = async (successExitCode) => {
      if (settled || terminating) return;
      terminating = true;
      clearTimeout(timer);
      try {
        await withDeadline(
          Promise.resolve().then(() => terminateTree(child.pid)),
          terminationTimeoutMs,
          `termination timed out after ${terminationTimeoutMs} ms`
        );
        finish(successExitCode);
      } catch (error) {
        writeError(`COMMAND_TREE_TERMINATION_FAILED:${errorMessage(error)}\n`);
        finish(terminationFailureExitCode);
      }
    };

    const onSigint = () => void requestTermination(signalExitCodes.SIGINT);
    const onSigterm = () => void requestTermination(signalExitCodes.SIGTERM);
    signalSource.once?.("SIGINT", onSigint);
    signalSource.once?.("SIGTERM", onSigterm);

    const timer = setTimeout(() => void requestTermination(timeoutExitCode), timeout);

    child.once("error", (error) => {
      if (terminating) return;
      writeError(`COMMAND_START_FAILED:${errorMessage(error)}\n`);
      finish(commandErrorExitCode);
    });
    child.once("exit", (code, signal) => {
      if (terminating) return;
      if (typeof code === "number") {
        finish(code);
        return;
      }
      writeError(`COMMAND_EXIT_SIGNAL:${signal ?? "unknown"}\n`);
      finish(1);
    });
  });
}

export function resolveCommand(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !/^(npm|npm\.cmd)$/i.test(command)) return { command, args };

  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? nodeExistsSync;
  const npmCliCandidates = [
    env.npm_execpath,
    path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);
  const npmCli = npmCliCandidates.find((candidate) => existsSync(candidate));
  if (!npmCli) throw new Error("Unable to locate npm-cli.js for npm.cmd on Windows.");
  return { command: execPath, args: [npmCli, ...args] };
}

export async function terminateProcessTree(pid, options = {}) {
  if (!pid) throw new Error("target process id is unavailable");
  const platform = options.platform ?? process.platform;
  const processExists = options.processExists ?? defaultProcessExists;
  const commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 5_000;

  if (platform === "win32") {
    const spawnTermination =
      options.spawnTermination ??
      ((targetPid) =>
        nodeSpawn("taskkill.exe", ["/pid", String(targetPid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true
        }));
    const taskkill = spawnTermination(pid);
    await waitForTerminationCommand(taskkill, commandTimeoutMs);
    await waitForTargetExit(pid, processExists, verifyTimeoutMs);
    return;
  }

  const signalGroup = options.signalGroup ?? defaultSignalGroup;
  signalGroup(pid, "SIGTERM");
  const graceMs = options.graceMs ?? 250;
  if (await targetExitedWithin(pid, processExists, graceMs)) return;
  signalGroup(pid, "SIGKILL");
  await waitForTargetExit(pid, processExists, verifyTimeoutMs);
}

function waitForTerminationCommand(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill?.();
      finish(() => reject(new Error(`taskkill timed out after ${timeoutMs} ms`)));
    }, timeoutMs);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish(resolve);
        return;
      }
      const detail = typeof code === "number" ? `code ${code}` : `signal ${signal ?? "unknown"}`;
      finish(() => reject(new Error(`taskkill exited with ${detail}`)));
    });
  });
}

async function waitForTargetExit(pid, processExists, timeoutMs) {
  if (await targetExitedWithin(pid, processExists, timeoutMs)) return;
  throw new Error(`target process ${pid} is still running after ${timeoutMs} ms`);
}

async function targetExitedWithin(pid, processExists, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
  return true;
}

function defaultProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function defaultSignalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function withDeadline(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
