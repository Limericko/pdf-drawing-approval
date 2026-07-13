import { describe, expect, it, vi } from "vitest";
import type { WorkerPlatformConfig } from "../config/types.ts";
import { assertWorkerCapacity, formatWorkerProcessFailure, runWorkerResourceLifecycle, workerMain } from "./workerMain.ts";

describe("worker process resource lifecycle", () => {
  it("never trusts arbitrary error codes in process diagnostics", () => {
    const output = formatWorkerProcessFailure({
      code: "postgresql://platform_worker:secret@production.example.test/database"
    });
    expect(output).toBe("WORKER_FAILED");
    expect(output).not.toContain("secret");
  });

  it("uses an explicitly injected storage factory without changing the default worker contract", async () => {
    const storage = { driver: "s3" };
    const storageFactory = vi.fn(() => storage);
    const config = { storage: { driver: "s3" } } as WorkerPlatformConfig;
    const runLifecycle = vi.fn(async (options: { createStorage(): unknown }) => {
      expect(options.createStorage()).toBe(storage);
    });

    await workerMain({}, {
      loadConfig: () => config,
      storageFactory: storageFactory as never,
      runLifecycle: runLifecycle as never
    });

    expect(storageFactory).toHaveBeenCalledOnce();
    expect(storageFactory).toHaveBeenCalledWith(config.storage);
  });

  it("closes storage and pool once when the schema gate fails and never starts loops", async () => {
    const pool = { end: vi.fn(async () => undefined) };
    const storage = { destroy: vi.fn() };
    const createStorage = vi.fn(() => storage);
    const run = vi.fn();
    await expect(runWorkerResourceLifecycle({
      createPool: () => pool,
      createStorage,
      assertReady: async () => { throw new Error("SCHEMA_GATE_FAILED"); },
      run
    })).rejects.toThrow("SCHEMA_GATE_FAILED");
    expect(run).not.toHaveBeenCalled();
    expect(createStorage).not.toHaveBeenCalled();
    expect(storage.destroy).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("preserves a shutdown requested during startup and performs no later storage I/O", async () => {
    const controller = new AbortController();
    const pool = { end: vi.fn(async () => undefined) };
    const createStorage = vi.fn(() => ({ destroy: vi.fn() }));
    const run = vi.fn();
    await expect(runWorkerResourceLifecycle({
      createPool: () => pool,
      createStorage,
      assertReady: async () => { controller.abort(); },
      run,
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(createStorage).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("destroys storage and closes the pool once when a started run fails", async () => {
    const pool = { end: vi.fn(async () => undefined) };
    const storage = { destroy: vi.fn() };
    await expect(runWorkerResourceLifecycle({
      createPool: () => pool,
      createStorage: () => storage,
      assertReady: async () => undefined,
      run: async () => { throw new Error("RUN_FAILED"); }
    })).rejects.toThrow("RUN_FAILED");
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

  it("fails a runtime capacity gate before storage creation and closes the pool", async () => {
    const pool = { end: vi.fn(async () => undefined) };
    const createStorage = vi.fn(() => ({}));
    await expect(runWorkerResourceLifecycle({
      createPool: () => pool,
      createStorage,
      assertReady: async () => assertWorkerCapacity({ database: { poolMax: 3 }, worker: { concurrency: 2 } } as never),
      run: vi.fn()
    })).rejects.toThrow("WORKER_POOL_CAPACITY_INSUFFICIENT");
    expect(createStorage).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
