import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as profilePage from "./ProfilePage.tsx";

const source = fs.readFileSync(path.resolve("src/client/pages/ProfilePage.tsx"), "utf8");

describe("ProfilePage", () => {
  it("renders profile, common project, and notification preference sections", () => {
    expect(source).toContain("我的资料");
    expect(source).toContain("基础资料");
    expect(source).toContain("常用项目");
    expect(source).toContain("通知偏好");
    expect(source).toContain("getProfile");
    expect(source).toContain("updateProfile");
    expect(source).toContain("sendProfileTestEmail");
    expect(source).toContain("给自己发送测试邮件");
  });

  it("manages common project chips without duplicates", () => {
    const helpers = profilePage as unknown as {
      addCommonProject?: (projects: string[], project: string) => string[];
      removeCommonProject?: (projects: string[], project: string) => string[];
      roleUsesCommonProjects?: (role: string) => boolean;
      profileIntroText?: (role: string) => string;
      updateNotificationPreference?: (
        preferences: { email: Record<string, boolean> },
        key: string,
        enabled: boolean
      ) => { email: Record<string, boolean> };
    };

    expect(helpers.addCommonProject).toBeTypeOf("function");
    expect(helpers.removeCommonProject).toBeTypeOf("function");
    expect(helpers.roleUsesCommonProjects).toBeTypeOf("function");
    expect(helpers.profileIntroText).toBeTypeOf("function");
    expect(helpers.updateNotificationPreference).toBeTypeOf("function");
    expect(helpers.addCommonProject!(["项目A"], " 项目A ")).toEqual(["项目A"]);
    expect(helpers.addCommonProject!(["项目A"], "项目B")).toEqual(["项目A", "项目B"]);
    expect(helpers.removeCommonProject!(["项目A", "项目B"], "项目A")).toEqual(["项目B"]);
    expect(helpers.roleUsesCommonProjects!("designer")).toBe(true);
    expect(helpers.roleUsesCommonProjects!("supervisor")).toBe(true);
    expect(helpers.roleUsesCommonProjects!("process")).toBe(true);
    expect(helpers.roleUsesCommonProjects!("admin")).toBe(false);
    expect(helpers.profileIntroText!("admin")).not.toContain("常用项目");
    expect(helpers.profileIntroText!("designer")).toContain("常用项目");
    expect(helpers.updateNotificationPreference!({ email: { approvalRejected: true } }, "approvalRejected", false)).toEqual({
      email: { approvalRejected: false }
    });
  });
});
