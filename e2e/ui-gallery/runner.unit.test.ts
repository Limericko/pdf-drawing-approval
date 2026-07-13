import { EventEmitter } from "node:events";
import uiConfig from "../../playwright.ui.config.ts";
import { describe, expect, it, vi } from "vitest";
import { resolveUiGalleryE2ECommand, runUiGalleryE2E } from "../../scripts/run-ui-gallery-e2e.mjs";

describe("UI Gallery E2E lifecycle", () => {
  it("keeps Vite ownership out of Playwright webServer", () => {
    expect(uiConfig.webServer).toBeUndefined();
  });

  it("passes explicit Playwright arguments through without a shell", () => {
    expect(resolveUiGalleryE2ECommand(["--update-snapshots=all"])).toEqual([
      "test", "--config", "playwright.ui.config.ts", "--update-snapshots=all"
    ]);
  });

  it("starts Vite, runs Playwright and closes Vite after success", async () => {
    const events: string[] = [];
    const createServer = vi.fn(async () => ({
      listen: vi.fn(async () => { events.push("vite:listen"); }),
      close: vi.fn(async () => { events.push("vite:close"); })
    }));
    const spawn = vi.fn(() => fakeChild(events, 0));

    await expect(runUiGalleryE2E([], { createServer, spawn })).resolves.toBe(0);
    expect(events).toEqual(["vite:listen", "playwright:start", "vite:close"]);
  });

  it("closes Vite before returning a Playwright failure", async () => {
    const events: string[] = [];
    const createServer = vi.fn(async () => ({
      listen: vi.fn(async () => { events.push("vite:listen"); }),
      close: vi.fn(async () => { events.push("vite:close"); })
    }));

    await expect(runUiGalleryE2E([], { createServer, spawn: vi.fn(() => fakeChild(events, 7)) })).resolves.toBe(7);
    expect(events).toEqual(["vite:listen", "playwright:start", "vite:close"]);
  });
});

function fakeChild(events: string[], exitCode: number) {
  const child = new EventEmitter();
  events.push("playwright:start");
  queueMicrotask(() => child.emit("exit", exitCode, null));
  return child;
}
