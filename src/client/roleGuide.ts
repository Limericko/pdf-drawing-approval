import type { User } from "./api.ts";

export type RoleGuide = {
  title: string;
  summary: string;
  steps: string[];
  primaryHref: string;
  primaryLabel: string;
};

const guides: Record<User["role"], RoleGuide> = {
  designer: {
    title: "设计师流程",
    summary: "从上传图纸到签后 PDF 打印归档，重点确认版本和签名框位置。",
    steps: ["配置签名", "上传 PDF", "放置签名框", "提交审批", "打印归档"],
    primaryHref: "#/submit",
    primaryLabel: "提交图纸"
  },
  supervisor: {
    title: "主管审核流程",
    summary: "优先处理待审队列，结合图纸、评论和版本记录给出审核结论。",
    steps: ["查看待审", "打开图纸", "核对评论", "通过或驳回"],
    primaryHref: "#/",
    primaryLabel: "查看待审"
  },
  process: {
    title: "工艺审核流程",
    summary: "聚焦加工可行性、版本变化和工艺风险，审核结论与主管并行生效。",
    steps: ["查看待审", "检查工艺", "核对版本", "通过或驳回"],
    primaryHref: "#/",
    primaryLabel: "查看待审"
  },
  admin: {
    title: "管理员维护流程",
    summary: "维护审批目录、人员、模板、日志和备份，保证局域网审批服务稳定运行。",
    steps: ["配置目录", "维护用户", "管理模板", "查看日志风险", "备份维护"],
    primaryHref: "#/settings",
    primaryLabel: "系统管理"
  }
};

export function roleGuideForRole(role: User["role"]): RoleGuide | null {
  return guides[role] ?? null;
}
