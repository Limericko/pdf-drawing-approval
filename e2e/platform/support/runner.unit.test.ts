import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import platformPlaywrightConfig from "../../../playwright.platform.config.ts";
import { describe, expect, it, vi } from "vitest";
import { resolvePlatformE2ECommands, runPlatformE2E } from "../../../scripts/run-platform-e2e.mjs";

const prefix = ["test", "--config", "playwright.platform.config.ts"];

describe("platform E2E command matrix", () => {
  it("leaves harness ownership to the runner instead of Playwright webServer", () => {
    expect(platformPlaywrightConfig.webServer).toBeUndefined();
  });

  it("runs the three stateful groups as three fresh sequential harnesses by default", () => {
    expect(resolvePlatformE2ECommands([])).toEqual([
      [...prefix, "--project=desktop-chromium", "e2e/platform/identity-security.spec.ts"],
      [...prefix, "--project=desktop-chromium", "e2e/platform/session-csrf.spec.ts",
        "e2e/platform/project-access.spec.ts", "e2e/platform/business-workflow.spec.ts"],
      [...prefix, "--project=mobile-chromium", "e2e/platform/identity-security.spec.ts"]
    ]);
  });

  it("passes explicit Playwright arguments through one harness invocation", () => {
    expect(resolvePlatformE2ECommands(["--project=desktop-chromium", "e2e/platform/project-access.spec.ts"]))
      .toEqual([[...prefix, "--project=desktop-chromium", "e2e/platform/project-access.spec.ts"]]);
  });

  it("starts, tests, and gracefully shuts down one fresh harness per default group", async () => {
    const events: string[] = [];
    const harnesses: FakeChild[] = [];
    const fork = vi.fn(() => {
      const child = createHarness(events);
      harnesses.push(child);
      queueMicrotask(() => child.stdout.write("PLATFORM_E2E_READY http://127.0.0.1:24173\n"));
      return child;
    });
    const spawn = vi.fn(() => createPlaywright(events, 0));

    await expect(runPlatformE2E([], quietOptions({ fork, spawn }))).resolves.toBe(0);

    expect(fork).toHaveBeenCalledTimes(3);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(events).toEqual([
      "harness:start", "playwright:start", "harness:shutdown",
      "harness:start", "playwright:start", "harness:shutdown",
      "harness:start", "playwright:start", "harness:shutdown"
    ]);
    expect(harnesses.every(({ kill }) => !kill.mock.calls.length)).toBe(true);
  });

  it("shuts the harness down before returning a Playwright failure", async () => {
    const events: string[] = [];
    const fork = vi.fn(() => {
      const child = createHarness(events);
      queueMicrotask(() => child.stdout.write("PLATFORM_E2E_READY http://127.0.0.1:24173\n"));
      return child;
    });
    const spawn = vi.fn(() => createPlaywright(events, 7));

    await expect(runPlatformE2E([], quietOptions({ fork, spawn }))).resolves.toBe(7);

    expect(fork).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["harness:start", "playwright:start", "harness:shutdown"]);
  });

  it("shuts the harness down when Playwright cannot be started", async () => {
    const events: string[] = [];
    const fork = vi.fn(() => {
      const child = createHarness(events);
      queueMicrotask(() => child.stdout.write("PLATFORM_E2E_READY http://127.0.0.1:24173\n"));
      return child;
    });
    const spawn = vi.fn(() => { throw new Error("spawn denied"); });

    await expect(runPlatformE2E(["one.spec.ts"], quietOptions({ fork, spawn })))
      .rejects.toThrow("spawn denied");

    expect(events).toEqual(["harness:start", "harness:shutdown"]);
  });

  it("requests cleanup and returns a stable failure when readiness times out", async () => {
    const events: string[] = [];
    const fork = vi.fn(() => createHarness(events));

    await expect(runPlatformE2E(["one.spec.ts"], quietOptions({
      fork,
      spawn: vi.fn(),
      readinessTimeoutMs: 5
    }))).rejects.toThrow("PLATFORM_E2E_HARNESS_START_TIMEOUT");

    expect(events).toEqual(["harness:start", "harness:shutdown"]);
  });

  it("owns cleanup when the harness reports a startup failure", async () => {
    const events: string[] = [];
    const fork = vi.fn(() => {
      const child = createHarness(events);
      queueMicrotask(() => child.emit("message", { type: "startup-failed" }));
      return child;
    });

    await expect(runPlatformE2E(["one.spec.ts"], quietOptions({
      fork,
      spawn: vi.fn(),
      readinessTimeoutMs: 5
    }))).rejects.toThrow("PLATFORM_E2E_HARNESS_START_FAILED");

    expect(events).toEqual(["harness:start", "harness:shutdown"]);
  });

  it("bounds shutdown, force-stops the child only after timeout, and fails stably", async () => {
    const events: string[] = [];
    const child = createHarness(events, { acknowledgeShutdown: false });
    const fork = vi.fn(() => {
      queueMicrotask(() => child.stdout.write("PLATFORM_E2E_READY http://127.0.0.1:24173\n"));
      return child;
    });

    await expect(runPlatformE2E(["one.spec.ts"], quietOptions({
      fork,
      spawn: vi.fn(() => createPlaywright(events, 0)),
      shutdownTimeoutMs: 5
    }))).rejects.toThrow("PLATFORM_E2E_HARNESS_SHUTDOWN_TIMEOUT");

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not accept child exit as a substitute for the cleanup acknowledgement", async () => {
    const events: string[] = [];
    const child = createHarness(events, { exitWithoutAck: true });
    const fork = vi.fn(() => {
      queueMicrotask(() => child.stdout.write("PLATFORM_E2E_READY http://127.0.0.1:24173\n"));
      return child;
    });

    await expect(runPlatformE2E(["one.spec.ts"], quietOptions({
      fork,
      spawn: vi.fn(() => createPlaywright(events, 0))
    }))).rejects.toThrow("PLATFORM_E2E_HARNESS_EXITED_BEFORE_CLEANUP_ACK");
  });

  it("forwards harness stdout and stderr while using stdout readiness", async () => {
    const events: string[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    stderr.on("data", (chunk) => stderrChunks.push(chunk));
    const fork = vi.fn(() => {
      const child = createHarness(events);
      queueMicrotask(() => {
        child.stderr.write("harness diagnostic\n");
        child.stdout.write("PLATFORM_E2E_READY http://127.0.0.1:24173\n");
      });
      return child;
    });

    await runPlatformE2E(["one.spec.ts"], {
      ...quietOptions({ fork, spawn: vi.fn(() => createPlaywright(events, 0)) }), stdout, stderr
    });

    expect(Buffer.concat(stdoutChunks).toString()).toContain("PLATFORM_E2E_READY");
    expect(Buffer.concat(stderrChunks).toString()).toContain("harness diagnostic");
  });
});

type FakeChild = EventEmitter & {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  connected: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};

function createHarness(events: string[], options: {
  readonly acknowledgeShutdown?: boolean;
  readonly exitWithoutAck?: boolean;
} = {}): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: true,
    exitCode: null,
    signalCode: null,
    send: vi.fn(),
    kill: vi.fn(() => true)
  }) as FakeChild;
  events.push("harness:start");
  child.send.mockImplementation((message: unknown, callback?: (error: Error | null) => void) => {
    if (message && typeof message === "object" && "type" in message && message.type === "shutdown") {
      events.push("harness:shutdown");
      callback?.(null);
      if (options.exitWithoutAck) queueMicrotask(() => {
        child.connected = false;
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      else if (options.acknowledgeShutdown !== false) queueMicrotask(() => {
        child.emit("message", { type: "shutdown-complete", exitCode: 0 });
        queueMicrotask(() => {
          child.connected = false;
          child.exitCode = 0;
          child.emit("exit", 0, null);
        });
      });
    }
    return true;
  });
  return child;
}

function createPlaywright(events: string[], exitCode: number) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null
  });
  events.push("playwright:start");
  queueMicrotask(() => {
    child.exitCode = exitCode;
    child.emit("exit", exitCode, null);
  });
  return child;
}

function quietOptions(overrides: Record<string, unknown>) {
  return {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    ...overrides
  };
}
