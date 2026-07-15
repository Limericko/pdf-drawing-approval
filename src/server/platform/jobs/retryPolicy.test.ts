import { describe, expect, it } from "vitest";
import { createRetryPolicy } from "./retryPolicy.ts";

describe("createRetryPolicy", () => {
  it("uses full jitter after capping exponential backoff", () => {
    const samples = [0, 0.5, 0.999999];
    const policy = createRetryPolicy({
      baseDelayMs: 1_000,
      maxDelayMs: 5_000,
      random: () => samples.shift()!,
      clock: () => new Date("2026-07-12T00:00:00.000Z")
    });

    expect(policy.next(1)).toEqual({
      delayMs: 0,
      nextRunAt: new Date("2026-07-12T00:00:00.000Z")
    });
    expect(policy.next(3)).toEqual({
      delayMs: 2_000,
      nextRunAt: new Date("2026-07-12T00:00:02.000Z")
    });
    expect(policy.next(99)).toEqual({
      delayMs: 5_000,
      nextRunAt: new Date("2026-07-12T00:00:05.000Z")
    });
  });

  it("owns the clock value returned to callers", () => {
    const now = new Date("2026-07-12T00:00:00.000Z");
    const policy = createRetryPolicy({
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      random: () => 0,
      clock: () => now
    });

    const result = policy.next(1);
    now.setUTCFullYear(2030);

    expect(result.nextRunAt).toEqual(new Date("2026-07-12T00:00:00.000Z"));
  });

  it.each([
    ["attempt", { baseDelayMs: 1, maxDelayMs: 1, random: (): number => 0, clock: () => new Date() }, 0],
    ["base delay", { baseDelayMs: 0, maxDelayMs: 1, random: (): number => 0, clock: () => new Date() }, 1],
    ["maximum delay", { baseDelayMs: 2, maxDelayMs: 1, random: (): number => 0, clock: () => new Date() }, 1],
    ["random lower bound", { baseDelayMs: 1, maxDelayMs: 1, random: (): number => -0.1, clock: () => new Date() }, 1],
    ["random upper bound", { baseDelayMs: 1, maxDelayMs: 1, random: (): number => 1, clock: () => new Date() }, 1],
    ["clock", { baseDelayMs: 1, maxDelayMs: 1, random: (): number => 0, clock: () => new Date(Number.NaN) }, 1]
  ] as const)("rejects an invalid %s", (_name, options, attempt) => {
    expect(() => createRetryPolicy(options).next(attempt)).toThrowError(
      expect.objectContaining({ code: "INVALID_RETRY_POLICY" })
    );
  });

  it("rejects next-date overflow without silently clamping", () => {
    const policy = createRetryPolicy({
      baseDelayMs: Number.MAX_SAFE_INTEGER,
      maxDelayMs: Number.MAX_SAFE_INTEGER,
      random: () => 0.999,
      clock: () => new Date(8_640_000_000_000_000)
    });

    expect(() => policy.next(2)).toThrowError(expect.objectContaining({ code: "INVALID_RETRY_POLICY" }));
  });
});
