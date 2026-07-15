import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error The production watchdog core is plain ESM executed directly by Node.
import { commandErrorExitCode, runWithTimeout, terminateProcessTree, terminationFailureExitCode } from "../../../../scripts/run-with-timeout-core.mjs";

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

  it("normalizes command resolution errors to exit 127", async () => {
    const errors: string[] = [];

    const exitCode = await runWithTimeout(1_000, "npm", [], {
      resolveCommand: () => {
        throw new Error("npm shim unavailable");
      },
      writeError: (value: string) => errors.push(value)
    });

    expect(exitCode).toBe(commandErrorExitCode);
    expect(errors.join("")).toContain("COMMAND_START_FAILED:npm shim unavailable");
  });

  it("returns a failure instead of 124 when tree termination rejects", async () => {
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = 123;
    const errors: string[] = [];

    const exitCode = await runWithTimeout(1, "fake", [], {
      spawnCommand: () => child,
      terminateTree: async () => {
        throw new Error("taskkill exited with code 1");
      },
      signalSource: new EventEmitter(),
      writeError: (value: string) => errors.push(value)
    });

    expect(exitCode).toBe(terminationFailureExitCode);
    expect(errors.join("")).toContain("COMMAND_TREE_TERMINATION_FAILED:taskkill exited with code 1");
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143]
  ] as const)("cleans the child tree when the watchdog receives %s", async (signal, expectedExitCode) => {
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = 456;
    const signalSource = new EventEmitter();
    const terminateTree = vi.fn(async () => undefined);

    const result = runWithTimeout(10_000, "fake", [], {
      spawnCommand: () => child,
      terminateTree,
      signalSource,
      writeError: () => undefined
    });
    signalSource.emit(signal);

    await expect(result).resolves.toBe(expectedExitCode);
    expect(terminateTree).toHaveBeenCalledWith(456);
  });
});

describe("terminateProcessTree on Windows", () => {
  function terminationChild(event: "success" | "non-zero" | "error" | "never") {
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn();
    if (event === "success") queueMicrotask(() => child.emit("exit", 0, null));
    if (event === "non-zero") queueMicrotask(() => child.emit("exit", 7, null));
    if (event === "error") queueMicrotask(() => child.emit("error", new Error("taskkill spawn failed")));
    return child;
  }

  it("rejects a non-zero taskkill exit", async () => {
    await expect(
      terminateProcessTree(123, {
        platform: "win32",
        spawnTermination: () => terminationChild("non-zero"),
        processExists: () => true,
        commandTimeoutMs: 50,
        verifyTimeoutMs: 20
      })
    ).rejects.toThrow("taskkill exited with code 7");
  });

  it("rejects a taskkill spawn error", async () => {
    await expect(
      terminateProcessTree(123, {
        platform: "win32",
        spawnTermination: () => terminationChild("error"),
        processExists: () => true,
        commandTimeoutMs: 50,
        verifyTimeoutMs: 20
      })
    ).rejects.toThrow("taskkill spawn failed");
  });

  it("bounds a hung taskkill command", async () => {
    const child = terminationChild("never");

    await expect(
      terminateProcessTree(123, {
        platform: "win32",
        spawnTermination: () => child,
        processExists: () => true,
        commandTimeoutMs: 20,
        verifyTimeoutMs: 20
      })
    ).rejects.toThrow("taskkill timed out");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("rejects when taskkill reports success but the target survives", async () => {
    await expect(
      terminateProcessTree(123, {
        platform: "win32",
        spawnTermination: () => terminationChild("success"),
        processExists: () => true,
        commandTimeoutMs: 50,
        verifyTimeoutMs: 20
      })
    ).rejects.toThrow("target process 123 is still running");
  });
});
