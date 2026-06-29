import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { quickLoginPresets } from "./LoginPage.tsx";

const source = fs.readFileSync(path.resolve("src/client/pages/LoginPage.tsx"), "utf8");

describe("quickLoginPresets", () => {
  it("provides username shortcuts for administrator, supervisor and process reviewer", () => {
    expect(quickLoginPresets.map((preset) => preset.label)).toEqual(["管理员", "主管", "工艺"]);
    expect(quickLoginPresets.map((preset) => preset.username)).toEqual(["admin", "supervisor", "process"]);
    expect(quickLoginPresets.every((preset) => !("password" in preset))).toBe(true);
  });

  it("uses workbench-oriented login copy", () => {
    expect(source).toContain("PDF 图纸审批工作台");
    expect(source).toContain("登录后处理提交、审核、签名和归档。");
  });

  it("uses browser autocomplete hints for account and password fields", () => {
    expect(source).toContain('autoComplete="username"');
    expect(source).toContain('autoComplete="current-password"');
  });

  it("offers designer self-registration on the login page", () => {
    expect(source).toContain("设计师注册");
    expect(source).toContain("registerDesigner");
    expect(source).toContain('autoComplete="new-password"');
    expect(source).toContain("注册后将以设计师身份进入工作台");
  });

  it("offers email password reset from the login page", () => {
    expect(source).toContain("忘记密码");
    expect(source).toContain("requestPasswordReset");
    expect(source).toContain("confirmPasswordReset");
    expect(source).toContain("如果账号和邮箱匹配，将收到密码重置邮件。");
    expect(source).toContain("resetToken");
  });
});
