import { describe, expect, it } from "vitest";
import { appVersion } from "../../shared/appVersion.ts";
import { buildUpdateInfo, compareVersions, type UpdateManifest } from "./updateInfo.ts";

describe("update info service", () => {
  it("compares semantic versions without treating 0.10 as older than 0.9", () => {
    expect(compareVersions("0.8.0", "0.7.9")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
  });

  it("reports an available update from a configured manifest source", async () => {
    const manifest: UpdateManifest = {
      version: "0.9.0",
      releaseDate: "2026-06-24",
      channel: "stable",
      notes: ["新增在线更新检查"],
      downloads: {
        clientInstaller: "http://192.168.1.20/downloads/PDF图纸审批客户端-安装包-0.9.0.exe",
        serverInstaller: "http://192.168.1.20/downloads/PDF图纸审批服务端-安装包-0.9.0.exe"
      }
    };

    const info = await buildUpdateInfo({
      currentVersion: "0.8.0",
      currentApiCompatVersion: 1,
      updateSourceUrl: "http://192.168.1.20/updates/latest.json",
      fetchManifest: async () => manifest,
      now: () => new Date("2026-06-23T10:00:00.000Z")
    });

    expect(info).toEqual(
      expect.objectContaining({
        currentVersion: "0.8.0",
        currentApiCompatVersion: 1,
        updateSourceUrl: "http://192.168.1.20/updates/latest.json",
        checkedAt: "2026-06-23T10:00:00.000Z",
        updateAvailable: true,
        error: null,
        latest: manifest
      })
    );
    expect(info.releaseNotes[0]).toMatchObject({ version: appVersion });
  });

  it("keeps update checks non-blocking when the manifest cannot be read", async () => {
    const info = await buildUpdateInfo({
      currentVersion: "0.8.0",
      currentApiCompatVersion: 1,
      updateSourceUrl: "http://192.168.1.20/updates/latest.json",
      fetchManifest: async () => {
        throw new Error("HTTP_404");
      },
      now: () => new Date("2026-06-23T10:00:00.000Z")
    });

    expect(info.latest).toBeNull();
    expect(info.updateAvailable).toBe(false);
    expect(info.error).toBe("HTTP_404");
    expect(info.releaseNotes.length).toBeGreaterThan(0);
  });
});
