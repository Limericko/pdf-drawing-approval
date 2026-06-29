import { describe, expect, it } from "vitest";
import { analyzeServerAddress, isApiCompatible } from "./connectionCheck.ts";

describe("connectionCheck", () => {
  it("warns when a teammate client uses a local-only address", () => {
    expect(analyzeServerAddress("http://127.0.0.1:8080")).toEqual({
      normalizedUrl: "http://127.0.0.1:8080",
      level: "warning",
      message: "127.0.0.1 只代表当前电脑，同事电脑请填写服务端显示的局域网地址。"
    });
  });

  it("accepts LAN addresses", () => {
    expect(analyzeServerAddress("http://192.168.1.20:8080")).toEqual({
      normalizedUrl: "http://192.168.1.20:8080",
      level: "ok",
      message: "服务器地址格式正常。"
    });
  });

  it("checks API compatibility", () => {
    expect(isApiCompatible({ clientApiCompatVersion: 1, serverApiCompatVersion: 1 })).toBe(true);
    expect(isApiCompatible({ clientApiCompatVersion: 1, serverApiCompatVersion: 2 })).toBe(false);
  });
});
