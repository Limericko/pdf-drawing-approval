import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve("src/client/pages/ServerConnectionPage.tsx"), "utf8");

describe("ServerConnectionPage", () => {
  it("checks server health before persisting the desktop server URL", () => {
    expect(source).toContain("checkServerHealth(serverUrl)");
    expect(source).toContain("persistServerBaseUrl(serverUrl)");
    expect(source.indexOf("checkServerHealth(serverUrl)")).toBeLessThan(source.indexOf("persistServerBaseUrl(serverUrl)"));
  });

  it("uses first-run desktop connection copy", () => {
    expect(source).toContain("连接公司审批服务端");
    expect(source).toContain("首次使用客户端时填写服务端地址");
  });

  it("uses URL autocomplete for the server address field", () => {
    expect(source).toContain('autoComplete="url"');
  });

  it("shows address advice and version compatibility before saving", () => {
    expect(source).toContain("analyzeServerAddress(serverUrl)");
    expect(source).toContain("isApiCompatible");
    expect(source).toContain("连接自检");
  });
});
