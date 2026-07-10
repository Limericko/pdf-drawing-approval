import { spawnSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../../");
const watchdogPath = path.join(workspaceRoot, "scripts", "run-with-timeout.mjs");

function runWatchdog(timeoutMs: number, source: string) {
  return runCommand(timeoutMs, process.execPath, ["-e", source]);
}

function runCommand(timeoutMs: number, command: string, args: string[]) {
  return spawnSync(process.execPath, [watchdogPath, String(timeoutMs), command, ...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: 30_000
  });
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number) {
  const deadline = Date.now() + 5_000;
  while (processExists(pid) && Date.now() < deadline) await delay(100);
}

describe("run-with-timeout", () => {
  it("preserves stdout and a successful exit code", () => {
    const result = runWatchdog(10_000, 'process.stdout.write("watchdog-ok")');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("watchdog-ok");
  }, 30_000);

  it("preserves stderr and a non-zero exit code", () => {
    const result = runWatchdog(10_000, 'process.stderr.write("watchdog-failed"); process.exit(7)');

    expect(result.status).toBe(7);
    expect(result.stderr).toBe("watchdog-failed");
  }, 30_000);

  it("runs npm through the platform command shim", () => {
    const result = runCommand(10_000, "npm", ["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 30_000);

  it("returns 124 and terminates the complete process tree on timeout", async () => {
    const childSource = [
      'const { spawn } = require("node:child_process")',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      'process.stdout.write(`${child.pid}\\n`)',
      'setInterval(() => {}, 1000)'
    ].join(";");

    const result = runWatchdog(250, childSource);
    const grandchildPid = Number(result.stdout.trim());

    expect(result.status).toBe(124);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    await waitForProcessExit(grandchildPid);
    expect(processExists(grandchildPid)).toBe(false);
  }, 30_000);
});
