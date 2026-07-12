import { describe, expect, it, vi } from "vitest";
import { runWorkerResourceLifecycle } from "./workerMain.ts";

describe("worker process resource lifecycle", () => {
  it("closes storage and pool once when the schema gate fails and never starts loops", async () => {
    const pool = { end: vi.fn(async () => undefined) };
    const storage = { destroy: vi.fn() };
    const run = vi.fn();
    await expect(runWorkerResourceLifecycle({
      createPool: () => pool,
      createStorage: () => storage,
      assertReady: async () => { throw new Error("SCHEMA_GATE_FAILED"); },
      run
    })).rejects.toThrow("SCHEMA_GATE_FAILED");
    expect(run).not.toHaveBeenCalled();
    expect(storage.destroy).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("closes the pool once when storage construction fails", async () => {
    const pool = { end: vi.fn(async () => undefined) };
    await expect(runWorkerResourceLifecycle({
      createPool: () => pool,
      createStorage: () => { throw new Error("STORAGE_GATE_FAILED"); },
      assertReady: vi.fn(),
      run: vi.fn()
    })).rejects.toThrow("STORAGE_GATE_FAILED");
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
