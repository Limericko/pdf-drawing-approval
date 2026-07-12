import { describe, expect, it, vi } from "vitest";
import { createDependencyHealthCache } from "./dependencyHealthCache.ts";

describe("dependency health cache", () => {
  it("singleflights concurrent probes and reuses the result until the TTL expires", async () => {
    let now = 1_000;
    let release!: () => void;
    const probe = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const cache = createDependencyHealthCache({ probe, timeoutMs: 100, ttlMs: 50, now: () => now });

    const first = cache.check();
    const second = cache.check();
    expect(probe).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);

    await expect(cache.check()).resolves.toEqual({ ok: true });
    expect(probe).toHaveBeenCalledOnce();
    now += 51;
    await cache.check();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("turns dependency failures and timeouts into bounded sanitized results", async () => {
    vi.useFakeTimers();
    try {
      const rejected = createDependencyHealthCache({
        probe: async () => { throw new Error("postgresql://user:secret@example.test/internal"); },
        timeoutMs: 20,
        ttlMs: 50
      });
      await expect(rejected.check()).resolves.toEqual({ ok: false, code: "DEPENDENCY_UNAVAILABLE" });

      const hanging = createDependencyHealthCache({
        probe: () => new Promise<void>(() => undefined),
        timeoutMs: 20,
        ttlMs: 50
      });
      const result = hanging.check();
      await vi.advanceTimersByTimeAsync(21);
      await expect(result).resolves.toEqual({ ok: false, code: "DEPENDENCY_TIMEOUT" });
      expect(JSON.stringify(await result)).not.toMatch(/secret|example\.test|postgresql/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overlap dependency I/O after a response timeout", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    let release!: () => void;
    const probe = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const cache = createDependencyHealthCache({ probe, timeoutMs: 20, ttlMs: 50, now: () => now });
    try {
      const first = cache.check();
      await vi.advanceTimersByTimeAsync(21);
      await expect(first).resolves.toEqual({ ok: false, code: "DEPENDENCY_TIMEOUT" });

      now += 51;
      const second = cache.check();
      expect(probe).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(21);
      await expect(second).resolves.toEqual({ ok: false, code: "DEPENDENCY_TIMEOUT" });
      release();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
});
