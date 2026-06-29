import { describe, expect, it } from "vitest";
import { roleGuideForRole } from "./roleGuide.ts";
import type { User } from "./api.ts";

describe("roleGuideForRole", () => {
  it("returns workflow steps for each active role", () => {
    expect(roleGuideForRole("designer")).toMatchObject({
      title: "设计师流程",
      primaryHref: "#/submit"
    });
    expect(roleGuideForRole("designer")?.steps).toEqual(["配置签名", "上传 PDF", "放置签名框", "提交审批", "打印归档"]);

    expect(roleGuideForRole("supervisor")?.steps).toEqual(["查看待审", "打开图纸", "核对评论", "通过或驳回"]);
    expect(roleGuideForRole("process")?.steps).toEqual(["查看待审", "检查工艺", "核对版本", "通过或驳回"]);
    expect(roleGuideForRole("admin")?.primaryHref).toBe("#/settings");
    expect(roleGuideForRole("admin")?.steps).toEqual(["配置目录", "维护用户", "管理模板", "查看日志风险", "备份维护"]);
  });

  it("does not return a guide for removed printer role data", () => {
    expect(roleGuideForRole("printer" as unknown as User["role"])).toBeNull();
  });
});
