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

  it("reuses a bounded timeout without new races until the underlying probe settles", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const releases: Array<() => void> = [];
    const probe = vi.fn(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    const cache = createDependencyHealthCache({ probe, timeoutMs: 20, ttlMs: 50, now: () => now });
    try {
      const first = cache.check();
      await vi.advanceTimersByTimeAsync(21);
      await expect(first).resolves.toEqual({ ok: false, code: "DEPENDENCY_TIMEOUT" });

      for (let cycle = 0; cycle < 3; cycle += 1) {
        now += 51;
        let settled = false;
        const repeated = cache.check().then((result) => { settled = true; return result; });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(true);
        await expect(repeated).resolves.toEqual({ ok: false, code: "DEPENDENCY_TIMEOUT" });
        expect(vi.getTimerCount()).toBe(0);
        expect(probe).toHaveBeenCalledOnce();
      }

      releases[0]!();
      await vi.advanceTimersByTimeAsync(0);
      now += 51;
      const afterSettle = cache.check();
      expect(probe).toHaveBeenCalledTimes(2);
      releases[1]!();
      await expect(afterSettle).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
