import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const timeoutExitCode = 124;
const commandErrorExitCode = 127;
const terminationGraceMs = 250;

const [timeoutText, requestedCommand, ...requestedArgs] = process.argv.slice(2);
const timeoutMs = Number(timeoutText);

if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !requestedCommand) {
  process.stderr.write("Usage: node scripts/run-with-timeout.mjs <positive-ms> <command> [args...]\n");
  process.exitCode = 2;
} else {
  process.exitCode = await runWithTimeout(timeoutMs, requestedCommand, requestedArgs);
}

async function runWithTimeout(timeout, command, args) {
  const resolved = resolveCommand(command, args);
  const child = spawn(resolved.command, resolved.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    detached: process.platform !== "win32"
  });

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exitCode);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child.pid).then(() => finish(timeoutExitCode));
    }, timeout);

    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      finish(commandErrorExitCode);
    });
    child.once("exit", (code, signal) => {
      if (timedOut) return;
      if (typeof code === "number") {
        finish(code);
        return;
      }
      process.stderr.write(`Command terminated by signal ${signal ?? "unknown"}.\n`);
      finish(1);
    });
  });
}

function resolveCommand(command, args) {
  if (process.platform !== "win32" || !/^(npm|npm\.cmd)$/i.test(command)) {
    return { command, args };
  }

  const npmCliCandidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);
  const npmCli = npmCliCandidates.find((candidate) => existsSync(candidate));
  if (!npmCli) {
    throw new Error("Unable to locate npm-cli.js for npm.cmd on Windows.");
  }
  return { command: process.execPath, args: [npmCli, ...args] };
}

async function terminateProcessTree(pid) {
  if (!pid) return;

  if (process.platform === "win32") {
    await waitForExit(
      spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      })
    );
    return;
  }

  signalProcessGroup(pid, "SIGTERM");
  await delay(terminationGraceMs);
  signalProcessGroup(pid, "SIGKILL");
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("error", resolve);
    child.once("exit", resolve);
  });
}
