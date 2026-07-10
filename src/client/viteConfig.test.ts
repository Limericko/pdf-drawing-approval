import { describe, expect, it } from "vitest";
import viteConfig, { resolveApiProxyTarget } from "../../vite.config.ts";

describe("vite dev server proxy", () => {
  it("does not proxy frontend modules whose filenames start with api", () => {
    const proxy = viteConfig.server?.proxy ?? {};
    expect(Object.keys(proxy)).not.toContain("/api");
    expect(proxy).toEqual(expect.objectContaining({ "/api/": "http://localhost:8080" }));
    expect(proxy).toEqual(expect.objectContaining({ "/health": "http://localhost:8080" }));
  });

  it("allows the isolated browser harness to override the backend target", () => {
    expect(resolveApiProxyTarget({ PDF_APPROVAL_DEV_API_TARGET: "http://127.0.0.1:18080" })).toBe("http://127.0.0.1:18080");
    expect(resolveApiProxyTarget({})).toBe("http://localhost:8080");
  });
});
