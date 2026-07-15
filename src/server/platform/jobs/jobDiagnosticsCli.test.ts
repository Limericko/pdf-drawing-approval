import { describe, expect, it, vi } from "vitest";
import { runJobDiagnosticsCli } from "./jobDiagnosticsCli.ts";

describe("job diagnostics CLI", () => {
  it("lists summaries and dead jobs without payloads", async () => {
    const output = vi.fn();
    const diagnostics = { summary: vi.fn(async () => ({ queueDepth: 2, deadCount: 1 })), listDead: vi.fn(async () => [{ id: "job", errorCode: "FAILED" }]), retryDead: vi.fn() };
    await runJobDiagnosticsCli(["list"], { diagnostics, output });
    await runJobDiagnosticsCli(["dead"], { diagnostics, output });
    expect(output).toHaveBeenCalledWith({ queueDepth: 2, deadCount: 1 });
    expect(output).toHaveBeenCalledWith([{ id: "job", errorCode: "FAILED" }]);
  });

  it("requires one UUID job and a non-empty manual reason", async () => {
    const retryDead = vi.fn(async () => ({ id: "retried" }));
    const deps = { diagnostics: { summary: vi.fn(), listDead: vi.fn(), retryDead }, output: vi.fn() };
    await expect(runJobDiagnosticsCli(["retry", "--job", "all", "--reason", "because"], deps)).rejects.toThrow("INVALID_JOB_DIAGNOSTICS_ARGUMENTS");
    await expect(runJobDiagnosticsCli(["retry", "--job", "018f47a0-7b90-7cc1-8d73-123456789abc", "--reason", ""], deps)).rejects.toThrow("INVALID_JOB_DIAGNOSTICS_ARGUMENTS");
    expect(retryDead).not.toHaveBeenCalled();
  });
});
