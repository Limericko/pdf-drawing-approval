import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  getConfigPath,
  loadRuntimeConfig,
  resolveEffectivePort,
  saveRuntimeConfig
} = require("../../apps/server-exe/serverRuntimeConfig.cjs");

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("server exe runtime config", () => {
  it("uses 8080 when no config or environment port exists", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-server-config-"));
    delete process.env.PORT;

    expect(loadRuntimeConfig(packageRoot)).toEqual({ port: 8080 });
    expect(resolveEffectivePort(loadRuntimeConfig(packageRoot), process.env)).toBe(8080);
  });

  it("loads a saved port and lets PORT override it", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-server-config-"));
    fs.writeFileSync(getConfigPath(packageRoot), JSON.stringify({ port: 18080 }), "utf8");

    expect(loadRuntimeConfig(packageRoot)).toEqual({ port: 18080 });

    process.env.PORT = "19090";
    expect(resolveEffectivePort(loadRuntimeConfig(packageRoot), process.env)).toBe(19090);
  });

  it("falls back to 8080 for invalid saved ports", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-server-config-"));
    fs.writeFileSync(getConfigPath(packageRoot), JSON.stringify({ port: 70000 }), "utf8");

    expect(loadRuntimeConfig(packageRoot)).toEqual({ port: 8080 });
  });

  it("validates and saves the port as formatted JSON", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-server-config-"));

    saveRuntimeConfig(packageRoot, { port: "18081" });

    expect(JSON.parse(fs.readFileSync(getConfigPath(packageRoot), "utf8"))).toEqual({ port: 18081 });
    expect(() => saveRuntimeConfig(packageRoot, { port: "abc" })).toThrow("INVALID_PORT");
  });
});
