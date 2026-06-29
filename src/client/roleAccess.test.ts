import { describe, expect, it } from "vitest";
import { defaultRouteForRole, navigationForRole, routeAllowedForRole } from "./roleAccess.ts";
import type { User } from "./api.ts";

function user(role: User["role"]): User {
  return { id: 1, username: role, role, displayName: role };
}

describe("role access", () => {
  it("keeps designers out of the review queue while allowing submission and printing work", () => {
    const labels = navigationForRole(user("designer")).map((item) => item.label);

    expect(labels).toEqual(["提交图纸", "全部图纸", "我的签名", "我的资料"]);
    expect(routeAllowedForRole(user("designer"), "tasks")).toBe(false);
    expect(routeAllowedForRole(user("designer"), "submit")).toBe(true);
    expect(routeAllowedForRole(user("designer"), "profile")).toBe(true);
    expect(defaultRouteForRole(user("designer"))).toBe("submit");
  });

  it("shows reviewers only review-oriented daily work", () => {
    const supervisorLabels = navigationForRole(user("supervisor")).map((item) => item.label);
    const processLabels = navigationForRole(user("process")).map((item) => item.label);

    expect(supervisorLabels).toEqual(["待我审核", "全部图纸", "我的签名", "我的资料"]);
    expect(processLabels).toEqual(["待我审核", "全部图纸", "我的签名", "我的资料"]);
    expect(routeAllowedForRole(user("supervisor"), "submit")).toBe(false);
    expect(routeAllowedForRole(user("process"), "profile")).toBe(true);
    expect(defaultRouteForRole(user("process"))).toBe("tasks");
  });

  it("keeps admins focused on operations and drawing maintenance", () => {
    expect(navigationForRole(user("admin")).map((item) => item.label)).toEqual(["系统管理", "全部图纸", "我的资料"]);
    expect(defaultRouteForRole(user("admin"))).toBe("settings");
    expect(routeAllowedForRole(user("admin"), "settings")).toBe(true);
    expect(routeAllowedForRole(user("admin"), "approvals")).toBe(true);
    expect(routeAllowedForRole(user("admin"), "profile")).toBe(true);
    expect(routeAllowedForRole(user("admin"), "submit")).toBe(false);
    expect(routeAllowedForRole(user("admin"), "signature")).toBe(false);
    expect(routeAllowedForRole(user("admin"), "tasks")).toBe(false);
  });

  it("keeps system management admin-only and does not expose a printer workflow", () => {
    expect(navigationForRole({ id: 2, username: "legacy_printer", role: "printer", displayName: "旧打印" } as unknown as User)).toEqual([]);
    expect(routeAllowedForRole(user("designer"), "settings")).toBe(false);
    expect(routeAllowedForRole(user("admin"), "settings")).toBe(true);
  });
});
