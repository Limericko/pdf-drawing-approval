import { describe, expect, it, vi } from "vitest";
import { runWorkerPrefixCleanupProbe } from "./workerPrefixProbe.ts";

describe("platform E2E Worker prefix probe", () => {
  it("queues cleanup before Worker start, preserves the outside sentinel, then removes it", async () => {
    const order: string[] = [];
    await runWorkerPrefixCleanupProbe({
      writePrefixedProbe: async () => { order.push("probe-written"); },
      writeOutsideSentinel: async () => { order.push("sentinel-written"); },
      enqueueCleanup: async () => { order.push("cleanup-enqueued"); },
      startWorker: async () => { order.push("worker-started"); },
      isPrefixedProbeDeleted: async () => { order.push("probe-checked"); return true; },
      isOutsideSentinelPresent: async () => { order.push("sentinel-checked"); return true; },
      removeOutsideSentinel: async () => { order.push("sentinel-removed"); },
      now: () => 0,
      delay: async () => undefined,
      timeoutMs: 1
    });
    expect(order).toEqual(["probe-written", "sentinel-written", "cleanup-enqueued", "worker-started",
      "sentinel-checked", "probe-checked", "sentinel-checked", "sentinel-removed"]);
  });

  it("fails if the Worker affects the outside sentinel and still attempts explicit cleanup", async () => {
    const removeOutsideSentinel = vi.fn(async () => undefined);
    await expect(runWorkerPrefixCleanupProbe({
      writePrefixedProbe: async () => undefined,
      writeOutsideSentinel: async () => undefined,
      enqueueCleanup: async () => undefined,
      startWorker: async () => undefined,
      isPrefixedProbeDeleted: async () => true,
      isOutsideSentinelPresent: async () => false,
      removeOutsideSentinel,
      now: () => 0,
      delay: async () => undefined,
      timeoutMs: 1
    })).rejects.toThrow("PLATFORM_E2E_WORKER_PREFIX_SENTINEL_MISSING");
    expect(removeOutsideSentinel).toHaveBeenCalledOnce();
  });

  it("checks the sentinel again after observing probe deletion before reporting success", async () => {
    const sentinelChecks = [true, false];
    const removeOutsideSentinel = vi.fn(async () => undefined);
    await expect(runWorkerPrefixCleanupProbe({
      writePrefixedProbe: async () => undefined,
      writeOutsideSentinel: async () => undefined,
      enqueueCleanup: async () => undefined,
      startWorker: async () => undefined,
      isPrefixedProbeDeleted: async () => true,
      isOutsideSentinelPresent: async () => sentinelChecks.shift() ?? false,
      removeOutsideSentinel,
      now: () => 0,
      delay: async () => undefined,
      timeoutMs: 1
    })).rejects.toThrow("PLATFORM_E2E_WORKER_PREFIX_SENTINEL_MISSING");
    expect(removeOutsideSentinel).toHaveBeenCalledOnce();
  });
});
