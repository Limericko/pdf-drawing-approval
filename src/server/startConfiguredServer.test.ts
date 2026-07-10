import { describe, expect, it, vi } from "vitest";
import { startConfiguredServer } from "./startConfiguredServer.ts";

describe("startConfiguredServer", () => {
  it("starts legacy without loading the platform module by default", async () => {
    const legacyServer = { runtime: "legacy" } as const;
    const startLegacy = vi.fn(() => legacyServer);
    const loadPlatform = vi.fn(async () => ({
      startPlatformWebServer: vi.fn(() => ({ runtime: "platform" } as const))
    }));

    const server = await startConfiguredServer({ env: {}, startLegacy, loadPlatform });

    expect(server).toBe(legacyServer);
    expect(startLegacy).toHaveBeenCalledOnce();
    expect(loadPlatform).not.toHaveBeenCalled();
  });

  it("loads and starts only the platform module in platform mode", async () => {
    const platformServer = { runtime: "platform" } as const;
    const startLegacy = vi.fn(() => ({ runtime: "legacy" } as const));
    const startPlatformWebServer = vi.fn(() => platformServer);
    const loadPlatform = vi.fn(async () => ({ startPlatformWebServer }));

    const server = await startConfiguredServer({
      env: { PDF_APPROVAL_RUNTIME_MODE: "platform" },
      startLegacy,
      loadPlatform
    });

    expect(server).toBe(platformServer);
    expect(startLegacy).not.toHaveBeenCalled();
    expect(loadPlatform).toHaveBeenCalledOnce();
    expect(startPlatformWebServer).toHaveBeenCalledOnce();
  });
});
