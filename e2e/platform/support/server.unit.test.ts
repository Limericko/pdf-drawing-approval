import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { enqueueReadyStorageCleanupProbe, createStorageOwnershipLayout, formatCleanupFailures, formatStartupFailure,
  installPlatformE2EProcessControl, prepareLocalPlatformE2EStartup } from "./server.ts";

describe("platform E2E cleanup diagnostics", () => {
  it("preserves stable child cleanup codes without leaking arbitrary messages", () => {
    expect(formatCleanupFailures([
      new Error("PLATFORM_E2E_PORT_STILL_BOUND:24173"),
      new Error("secret database URL failed")
    ])).toBe("PLATFORM_E2E_CLEANUP_FAILED:PLATFORM_E2E_PORT_STILL_BOUND:24173,PLATFORM_E2E_CLEANUP_STEP_FAILED");
  });
});

describe("platform E2E process control", () => {
  it("acknowledges IPC shutdown only after async cleanup and then disconnects", async () => {
    const events: string[] = [];
    const target = Object.assign(new EventEmitter(), {
      connected: true,
      exitCode: undefined as number | undefined,
      send: vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
        events.push("ack");
        callback?.(null);
        return true;
      }),
      disconnect: vi.fn(() => {
        events.push("disconnect");
        target.connected = false;
      })
    });
    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const shutdown = vi.fn(async () => {
      events.push("cleanup:start");
      await cleanupBlocked;
      events.push("cleanup:done");
      target.exitCode = 0;
    });
    installPlatformE2EProcessControl({ target, shutdown });

    target.emit("message", { type: "shutdown" });
    await vi.waitFor(() => expect(events).toEqual(["cleanup:start"]));
    releaseCleanup();
    await vi.waitFor(() => expect(events).toEqual(["cleanup:start", "cleanup:done", "ack", "disconnect"]));

    expect(target.send).toHaveBeenCalledWith(
      { type: "shutdown-complete", exitCode: 0 },
      expect.any(Function)
    );
  });

  it("reports a forked startup failure but waits for the runner shutdown request before cleanup", async () => {
    const target = Object.assign(new EventEmitter(), {
      connected: true,
      exitCode: undefined as number | undefined,
      send: vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
        callback?.(null);
        return true;
      }),
      disconnect: vi.fn(() => { target.connected = false; })
    });
    const shutdown = vi.fn(async () => { target.exitCode = 0; });
    const control = installPlatformE2EProcessControl({ target, shutdown });

    await control.startupFailed();
    expect(target.send).toHaveBeenCalledWith({ type: "startup-failed" }, expect.any(Function));
    expect(shutdown).not.toHaveBeenCalled();
    expect(target.disconnect).not.toHaveBeenCalled();

    target.emit("message", { type: "shutdown" });
    await vi.waitFor(() => expect(target.disconnect).toHaveBeenCalledTimes(1));
    expect(shutdown).toHaveBeenCalledWith(0);
  });

  it("cleans up and disconnects when a startup failure cannot be reported over IPC", async () => {
    const target = Object.assign(new EventEmitter(), {
      connected: true,
      exitCode: undefined as number | undefined,
      send: vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
        callback?.(new Error("ipc closed"));
        return false;
      }),
      disconnect: vi.fn(() => { target.connected = false; })
    });
    const shutdown = vi.fn(async (exitCode: number) => { target.exitCode = exitCode; });
    const control = installPlatformE2EProcessControl({ target, shutdown });

    await control.startupFailed();

    expect(shutdown).toHaveBeenCalledWith(1);
    expect(target.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("platform E2E startup boundary", () => {
  it("removes stale state before rejecting an unsafe dependency environment", async () => {
    const order: string[] = [];
    await expect(prepareLocalPlatformE2EStartup({
      PDF_APPROVAL_STORAGE_S3_ENDPOINT: "https://production.example.test"
    }, async () => { order.push("state-removed"); })).rejects.toThrow("PLATFORM_E2E_DEPENDENCY_NOT_LOCAL");
    expect(order).toEqual(["state-removed"]);
  });

  it("redacts database URLs and secrets from startup failures", () => {
    const output = formatStartupFailure(new Error(
      "connect postgresql://platform_web:secret@db.example.test/pdf_approval failed"
    ));
    expect(output).toBe("PLATFORM_E2E_START_FAILED:PLATFORM_E2E_START_STEP_FAILED");
    expect(output).not.toContain("postgresql://");
    expect(output).not.toContain("secret");
  });
});

describe("platform E2E storage ownership", () => {
  it("keeps the Worker sentinel outside the adapter prefix but inside the owned cleanup root", () => {
    const runId = "0123456789abcdef0123456789abcdef";
    const layout = createStorageOwnershipLayout(runId);
    expect(layout).toEqual({
      cleanupRoot: `phase1-e2e/${runId}`,
      storagePrefix: `phase1-e2e/${runId}/objects`,
      sentinelPrefix: `phase1-e2e/${runId}/sentinel`
    });
    expect(layout.sentinelPrefix.startsWith(`${layout.cleanupRoot}/`)).toBe(true);
    expect(layout.sentinelPrefix.startsWith(`${layout.storagePrefix}/`)).toBe(false);
  });

  it("enqueues the Worker probe as ready deletion instead of stale staging cleanup", async () => {
    const now = new Date("2026-07-13T01:00:00.000Z");
    const id = "019805be-4c80-7000-8000-000000000001";
    const objectKey = `worker-prefix-probe/${id}`;
    const pending = {
      id, driver: "s3" as const, objectKey, cleanupTombstone: false, cleanupGeneration: 0
    };
    const repository = {
      createStaging: vi.fn(async () => undefined),
      markReady: vi.fn(async () => undefined),
      markDeletePending: vi.fn(async () => pending)
    };
    const publisher = { publish: vi.fn(async () => undefined) };
    const executor = { query: vi.fn() };

    await enqueueReadyStorageCleanupProbe({
      repository,
      publisher,
      executor,
      clock: () => now,
      payload: {
        id,
        driver: "s3",
        objectKey,
        sizeBytes: 19,
        sha256: Buffer.from("6c51ef04bd8520b56e1c9afd93f13c0b940bfba00c401bdc89c35fb4b4249a7b", "hex"),
        mediaType: "application/octet-stream"
      }
    });

    expect(repository.createStaging).toHaveBeenCalledWith({
      id,
      driver: "s3",
      objectKey,
      createdAt: new Date("2026-07-13T00:59:59.998Z"),
      uploadExpiresAt: new Date("2026-07-13T01:01:00.000Z")
    });
    expect(repository.markReady).toHaveBeenCalledWith(id, {
      sizeBytes: 19,
      sha256: Buffer.from("6c51ef04bd8520b56e1c9afd93f13c0b940bfba00c401bdc89c35fb4b4249a7b", "hex"),
      mediaType: "application/octet-stream",
      readyAt: new Date("2026-07-13T00:59:59.999Z")
    });
    expect(repository.markDeletePending).toHaveBeenCalledWith(
      id,
      now
    );
    expect(publisher.publish).toHaveBeenCalledWith(executor, {
      type: "storage_object_cleanup",
      payloadVersion: 1,
      idempotencyKey: `storage-object-cleanup:${id}:delete_pending`,
      storageObjectId: id,
      expectedStatus: "delete_pending",
      driver: "s3",
      objectKey
    });
    expect(repository.createStaging.mock.invocationCallOrder[0]).toBeLessThan(
      repository.markReady.mock.invocationCallOrder[0]!
    );
    expect(repository.markReady.mock.invocationCallOrder[0]).toBeLessThan(
      repository.markDeletePending.mock.invocationCallOrder[0]!
    );
    expect(repository.markDeletePending.mock.invocationCallOrder[0]).toBeLessThan(
      publisher.publish.mock.invocationCallOrder[0]!
    );
  });
});
