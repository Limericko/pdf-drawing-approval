import { describe, expect, it } from "vitest";
import viteConfig, {
  bypassFrontendApiSourceProxy,
  resolveApiProxyTarget
} from "../../vite.config.ts";

describe("vite dev server proxy", () => {
  it("does not proxy frontend modules whose filenames start with api", () => {
    const proxy = viteConfig.server?.proxy ?? {};
    expect(Object.keys(proxy)).not.toContain("/api");
    expect(proxy["/api/"]).toEqual(expect.objectContaining({ target: "http://localhost:8080" }));
    expect(proxy).toEqual(expect.objectContaining({ "/health": "http://localhost:8080" }));
  });

  it.each([
    "/api/identityClient.ts",
    "/api/identityClient.ts?import",
    "/api/PlatformIdentityApp.tsx?t=123",
    "/api/PlatformIdentityApp.tsx?import&t=123",
    "/api/PlatformIdentityApp.tsx?t=123&import"
  ])("bypasses the API proxy only for canonical frontend TypeScript source requests: %s", (requestUrl) => {
    expect(bypassFrontendApiSourceProxy(requestUrl)).toBe(requestUrl);
  });

  it.each([
    "/api/v2",
    "/api/v2/session",
    "/api/v2.ts",
    "/api/v2.tsx?import",
    "/api/v2anything.ts",
    "/api/identityClient.js",
    "/api/identityClient.ts/extra",
    "/api/features/identity/PlatformIdentityApp.tsx?t=123",
    "/api//identityClient.ts",
    "/api/%2e%2e/identityClient.ts",
    "//api/identityClient.ts",
    "/api/identityClient.ts?token=secret",
    "/api/identityClient.ts?arbitrary=value",
    "/api/identityClient.ts?t=not-digits",
    "/api/identityClient.ts?import=1",
    "/api/identityClient.ts?t=123&token=secret",
    "/api/identityClient.ts?import&import"
  ])("keeps API endpoints and non-canonical paths on the backend proxy: %s", (requestUrl) => {
    expect(bypassFrontendApiSourceProxy(requestUrl)).toBeUndefined();
  });

  it("allows the isolated browser harness to override the backend target", () => {
    expect(resolveApiProxyTarget({ PDF_APPROVAL_DEV_API_TARGET: "http://127.0.0.1:18080" })).toBe("http://127.0.0.1:18080");
    expect(resolveApiProxyTarget({})).toBe("http://localhost:8080");
  });
});
