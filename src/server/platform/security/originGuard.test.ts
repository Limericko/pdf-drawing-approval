import { describe, expect, it, vi } from "vitest";
import { createOriginGuard } from "./originGuard.ts";

describe("originGuard", () => {
  const guard = createOriginGuard({ publicBaseUrl: "https://approval.example.test/app" });

  it("allows exact-origin JSON requests", () => {
    const next = vi.fn();
    guard(request({ origin: "https://approval.example.test", contentType: "application/json; charset=utf-8",
      fetchSite: "same-origin" }) as never, {} as never, next);
    expect(next).toHaveBeenCalledWith();
  });

  it.each([
    [{ origin: undefined, contentType: "application/json" }, "ORIGIN_REQUIRED"],
    [{ origin: "https://evil.example", contentType: "application/json" }, "ORIGIN_FORBIDDEN"],
    [{ origin: "https://approval.example.test", contentType: "text/plain" }, "JSON_CONTENT_TYPE_REQUIRED"],
    [{ origin: "https://approval.example.test", contentType: "application/json", fetchSite: "cross-site" },
      "CROSS_SITE_REQUEST_FORBIDDEN"]
  ])("rejects an unsafe request at the boundary", (input, code) => {
    const next = vi.fn();
    guard(request(input) as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code }));
  });
});

function request(input: { origin?: string; contentType?: string; fetchSite?: string }) {
  const headers: Record<string, string | undefined> = { origin: input.origin,
    "content-type": input.contentType, "sec-fetch-site": input.fetchSite };
  return { method: "POST", get(name: string) { return headers[name.toLowerCase()]; } };
}
