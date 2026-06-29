import { describe, expect, it } from "vitest";
import { buildPublicHealth } from "./publicHealth.ts";

describe("buildPublicHealth", () => {
  it("returns safe version and address metadata without sensitive paths", () => {
    const health = buildPublicHealth({
      port: 8080,
      lanAddresses: ["192.168.1.20"],
      startedAt: "2026-06-23T00:00:00.000Z"
    });

    expect(health).toEqual({
      ok: true,
      appName: "PDF图纸审批",
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      apiCompatVersion: 1,
      port: 8080,
      lanUrls: ["http://192.168.1.20:8080"],
      startedAt: "2026-06-23T00:00:00.000Z"
    });
    expect(JSON.stringify(health)).not.toContain("smtp");
    expect(JSON.stringify(health)).not.toContain("database");
    expect(JSON.stringify(health)).not.toContain("watch_root");
  });
});
