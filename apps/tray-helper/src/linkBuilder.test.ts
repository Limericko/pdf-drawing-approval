import { describe, expect, it } from "vitest";
import { approvalUrl, routeUrl } from "./linkBuilder.ts";

describe("linkBuilder", () => {
  it("normalizes base urls and approval hashes", () => {
    expect(approvalUrl("http://192.168.1.20:8080/", 12)).toBe("http://192.168.1.20:8080/#/approvals/12");
    expect(routeUrl("http://192.168.1.20:8080", "#/settings")).toBe("http://192.168.1.20:8080/#/settings");
  });
});
