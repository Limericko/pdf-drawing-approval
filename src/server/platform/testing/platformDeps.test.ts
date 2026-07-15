import { describe, expect, it, vi } from "vitest";

// @ts-expect-error The production CLI core is plain ESM executed directly by Node.
import { PROJECT_NAME, createDockerRunner, runPlatformDeps } from "../../../../scripts/platform-deps-core.mjs";

type DockerResult = { status: number; stdout?: string; stderr?: string; error?: NodeJS.ErrnoException };
type DockerCall = { args: string[]; options: { capture?: boolean; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number } };

function localRunner(handler?: (call: DockerCall) => DockerResult) {
  const calls: DockerCall[] = [];
  const run = vi.fn((args: string[], options: DockerCall["options"]) => {
    const call = { args, options };
    calls.push(call);
    if (handler) return handler(call);
    if (args[0] === "context") return { status: 0, stdout: "npipe:////./pipe/dockerDesktopLinuxEngine\n" };
    return { status: 0, stdout: "" };
  });
  return { calls, run };
}

describe("platform-deps", () => {
  it("pins every compose command to the Phase 1 project and removes the parent project override", () => {
    const runner = localRunner();

    runPlatformDeps({
      action: "status",
      args: [],
      env: { ...process.env, COMPOSE_PROJECT_NAME: "unrelated" },
      runner: runner.run
    });

    const composeCall = runner.calls.find((call) => call.args[0] === "compose");
    expect(composeCall?.args).toEqual(expect.arrayContaining(["--project-name", PROJECT_NAME]));
    expect(composeCall?.options.env.COMPOSE_PROJECT_NAME).toBeUndefined();
  });

  it("rejects a remote DOCKER_HOST before invoking Docker", () => {
    const runner = localRunner();

    expect(() =>
      runPlatformDeps({ action: "status", args: [], env: { DOCKER_HOST: "tcp://db.example:2376" }, runner: runner.run })
    ).toThrow("LOCAL_DOCKER_REQUIRED");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects a remote current Docker context", () => {
    const runner = localRunner(({ args }) =>
      args[0] === "context" ? { status: 0, stdout: "ssh://builder.example\n" } : { status: 0 }
    );

    expect(() => runPlatformDeps({ action: "status", args: [], env: {}, runner: runner.run })).toThrow(
      "LOCAL_DOCKER_REQUIRED"
    );
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects unknown arguments without touching Docker", () => {
    const runner = localRunner();

    expect(() => runPlatformDeps({ action: "status", args: ["--surprise"], env: {}, runner: runner.run })).toThrow(
      "UNKNOWN_ARGUMENT"
    );
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("refuses reset without explicit local data loss confirmation", () => {
    const runner = localRunner();
    const output: string[] = [];

    expect(() =>
      runPlatformDeps({ action: "reset", args: [], env: {}, runner: runner.run, writeOutput: (value: string) => output.push(value) })
    ).toThrow("--confirm-local-data-loss");
    expect(output.join("")).toContain("pdf-approval-phase1-postgres-data");
    expect(output.join("")).toContain("pdf-approval-phase1-minio-data");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("removes only containers and managed volumes carrying the exact project labels", () => {
    const runner = localRunner(({ args }) => {
      if (args[0] === "context") return { status: 0, stdout: "npipe:////./pipe/dockerDesktopLinuxEngine\n" };
      if (args[0] === "ps") return { status: 0, stdout: "container-one\n" };
      if (args[0] === "inspect") {
        return {
          status: 0,
          stdout: `${JSON.stringify({
            Id: "container-one",
            Name: "/pdf-approval-phase1-postgres-1",
            Labels: { "com.docker.compose.project": PROJECT_NAME }
          })}\n`
        };
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        const name = args[2];
        const composeVolume = name.endsWith("postgres-data") ? "postgres-data" : "minio-data";
        return {
          status: 0,
          stdout: `${JSON.stringify({
            Name: name,
            Labels: {
              "com.docker.compose.project": PROJECT_NAME,
              "com.docker.compose.volume": composeVolume
            }
          })}\n`
        };
      }
      return { status: 0, stdout: "" };
    });
    const output: string[] = [];

    runPlatformDeps({
      action: "reset",
      args: ["--confirm-local-data-loss"],
      env: {},
      runner: runner.run,
      writeOutput: (value: string) => output.push(value)
    });

    expect(output.join("")).toContain("pdf-approval-phase1-postgres-1");
    expect(runner.calls.some((call) => call.args.includes("down"))).toBe(false);
    expect(runner.calls).toContainEqual(
      expect.objectContaining({ args: ["rm", "--force", "container-one"] })
    );
    expect(runner.calls).toContainEqual(
      expect.objectContaining({
        args: ["volume", "rm", "pdf-approval-phase1-postgres-data", "pdf-approval-phase1-minio-data"]
      })
    );
  });

  it("rejects a managed volume whose project label does not match", () => {
    const runner = localRunner(({ args }) => {
      if (args[0] === "context") return { status: 0, stdout: "npipe:////./pipe/dockerDesktopLinuxEngine\n" };
      if (args[0] === "ps") return { status: 0, stdout: "" };
      if (args[0] === "volume" && args[1] === "inspect") {
        return {
          status: 0,
          stdout: `${JSON.stringify({
            Name: args[2],
            Labels: { "com.docker.compose.project": "unrelated", "com.docker.compose.volume": "postgres-data" }
          })}\n`
        };
      }
      return { status: 0, stdout: "" };
    });

    expect(() =>
      runPlatformDeps({ action: "reset", args: ["--confirm-local-data-loss"], env: {}, runner: runner.run })
    ).toThrow("RESOURCE_BOUNDARY_MISMATCH");
    expect(runner.calls.some((call) => call.args[0] === "rm")).toBe(false);
  });

  it("propagates a Docker daemon error deterministically", () => {
    const runner = localRunner(() => ({ status: 1, stderr: "daemon unavailable" }));

    expect(() => runPlatformDeps({ action: "status", args: [], env: {}, runner: runner.run })).toThrow(
      "daemon unavailable"
    );
  });

  it("reports a timed out Docker subcommand without leaking configured secrets", () => {
    const spawnSync = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" })
    }));
    const runner = createDockerRunner({ spawnSync, cwd: process.cwd() });

    expect(() =>
      runner(["compose", "exec", "postgres", "local-only-secret"], {
        env: { PLATFORM_WEB_PASSWORD: "local-only-secret" },
        timeoutMs: 123
      })
    ).toThrowError(/timed out after 123 ms.*docker compose exec postgres \[REDACTED\]/i);
  });
});
