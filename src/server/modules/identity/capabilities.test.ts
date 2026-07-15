import { describe, expect, it } from "vitest";
import { globalCapabilitiesFor, projectCapabilitiesFor } from "./capabilities.ts";

describe("capabilities", () => {
  it("gives only active admins global security and project creation capabilities", () => {
    expect(globalCapabilitiesFor({ platformRole: "admin", status: "active" }))
      .toEqual(["platform.security.manage", "projects.create"]);
    expect(globalCapabilitiesFor({ platformRole: "member", status: "active" })).toEqual([]);
    expect(globalCapabilitiesFor({ platformRole: "admin", status: "disabled" })).toEqual([]);
  });

  it.each([
    ["manager", ["project.read", "project.members.manage", "project.invitations.create",
      "drawings.submit", "drawings.review", "drawings.process"]],
    ["designer", ["project.read", "drawings.submit"]],
    ["supervisor", ["project.read", "drawings.review"]],
    ["process", ["project.read", "drawings.process"]],
    ["viewer", ["project.read"]]
  ] as const)("defines the active %s matrix", (role, expected) => {
    expect(projectCapabilitiesFor({ role, status: "active" })).toEqual(expected);
    expect(projectCapabilitiesFor({ role, status: "disabled" })).toEqual([]);
  });
});
