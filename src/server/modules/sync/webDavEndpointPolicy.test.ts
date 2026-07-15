import { describe, expect, it } from "vitest";
import { createWebDavEndpointPolicy } from "./webDavEndpointPolicy.ts";

describe("WebDAV endpoint policy", () => {
  it("allows explicit public HTTPS hosts and rejects lookalikes", () => {
    const allow = createWebDavEndpointPolicy({ environment: "production", allowedHosts: ["dav.company.com"] });
    expect(allow(new URL("https://dav.company.com/root/"))).toBe(true);
    expect(allow(new URL("https://dav.company.com.evil.test/root/"))).toBe(false);
    expect(allow(new URL("http://dav.company.com/root/"))).toBe(false);
  });

  it("rejects production hosts without an explicit allowlist or with private addresses", () => {
    expect(createWebDavEndpointPolicy({ environment: "production", allowedHosts: [] })(
      new URL("https://dav.company.com/root/")
    )).toBe(false);
    expect(createWebDavEndpointPolicy({ environment: "production", allowedHosts: ["10.0.0.8"] })(
      new URL("https://10.0.0.8/root/")
    )).toBe(false);
  });

  it("allows only loopback HTTP during development unless HTTPS host is explicit", () => {
    const allow = createWebDavEndpointPolicy({ environment: "development", allowedHosts: ["dav.example.test"] });
    expect(allow(new URL("http://127.0.0.1:1900/root/"))).toBe(true);
    expect(allow(new URL("https://dav.example.test/root/"))).toBe(true);
    expect(allow(new URL("http://dav.example.test/root/"))).toBe(false);
  });
});
