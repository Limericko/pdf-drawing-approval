import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "./approvals.ts";
import { ApprovalIssueRepository } from "./approvalIssues.ts";
import { UserRepository } from "./users.ts";

function createContext() {
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const creator = users.create({ username: "supervisor_issue", password: "123456", role: "supervisor", displayName: "主管审阅" });
  const assignee = users.create({ username: "designer_issue", password: "123456", role: "designer", displayName: "设计人员" });
  const admin = users.create({ username: "admin_issue", password: "123456", role: "admin", displayName: "系统管理员" });
  const approvals = new ApprovalRepository(db);
  const approval = approvals.create({
    projectName: "精密传动项目",
    partName: "减速器壳体",
    version: "A03",
    minorVersion: "A03",
    majorVersion: "A0",
    originalFilePath: "original.pdf",
    currentFilePath: "current.pdf"
  });
  return { approval, creator, assignee, admin, issues: new ApprovalIssueRepository(db) };
}

describe("ApprovalIssueRepository", () => {
  it("creates formal issues with assignment, severity and an auditable creation event", () => {
    const { approval, creator, assignee, issues } = createContext();
    const issue = issues.create({
      approvalId: approval.id,
      annotationId: null,
      creatorUserId: creator.id,
      assigneeUserId: assignee.id,
      title: "轴承孔公差未标注",
      description: "请补充 H7 公差与基准关系。",
      severity: "high",
      dueAt: "2026-07-18T09:00:00.000Z"
    });

    expect(issue).toMatchObject({
      approvalId: approval.id,
      status: "open",
      severity: "high",
      creatorDisplayName: "主管审阅",
      assigneeDisplayName: "设计人员",
      resolutionSummary: null,
      forcedCloseReason: null
    });
    expect(issues.listForApproval(approval.id)).toHaveLength(1);
    expect(issues.listEvents(issue.id)).toEqual([
      expect.objectContaining({ action: "created", fromStatus: null, toStatus: "open", actorUserId: creator.id })
    ]);
  });

  it("enforces the review lifecycle and records handling and review notes", () => {
    const { approval, creator, assignee, issues } = createContext();
    const issue = issues.create({
      approvalId: approval.id,
      creatorUserId: creator.id,
      assigneeUserId: assignee.id,
      title: "倒角尺寸冲突",
      description: "剖视图与明细不一致。",
      severity: "medium",
      dueAt: null
    });

    expect(issues.transition(issue.id, { action: "start", actorUserId: assignee.id })).toMatchObject({ status: "in_progress" });
    expect(issues.transition(issue.id, { action: "submit_review", actorUserId: assignee.id, note: "已统一修改为 C1.5。" }))
      .toMatchObject({ status: "review", resolutionSummary: "已统一修改为 C1.5。" });
    expect(issues.transition(issue.id, { action: "return", actorUserId: creator.id, note: "请同步更新技术要求。" }))
      .toMatchObject({ status: "in_progress", reviewNote: "请同步更新技术要求。" });
    expect(issues.transition(issue.id, { action: "submit_review", actorUserId: assignee.id, note: "技术要求已同步。" }))
      .toMatchObject({ status: "review" });
    expect(issues.transition(issue.id, { action: "close", actorUserId: creator.id, note: "复核通过。" }))
      .toMatchObject({ status: "closed", closedByUserId: creator.id, reviewNote: "复核通过。" });

    expect(issues.listEvents(issue.id).map((event) => event.action)).toEqual([
      "created", "started", "submitted_review", "returned", "submitted_review", "closed"
    ]);
  });

  it("rejects skipped states and missing transition notes", () => {
    const { approval, creator, assignee, issues } = createContext();
    const issue = issues.create({ approvalId: approval.id, creatorUserId: creator.id, assigneeUserId: assignee.id,
      title: "材料牌号缺失", description: "标题栏未填写材料。", severity: "low", dueAt: null });

    expect(() => issues.transition(issue.id, { action: "close", actorUserId: creator.id, note: "直接关闭" }))
      .toThrow("INVALID_ISSUE_TRANSITION");
    issues.transition(issue.id, { action: "start", actorUserId: assignee.id });
    expect(() => issues.transition(issue.id, { action: "submit_review", actorUserId: assignee.id, note: "" }))
      .toThrow("ISSUE_TRANSITION_NOTE_REQUIRED");
  });

  it("counts only open high severity issues as approval blockers", () => {
    const { approval, creator, assignee, admin, issues } = createContext();
    const high = issues.create({ approvalId: approval.id, creatorUserId: creator.id, assigneeUserId: assignee.id,
      title: "关键尺寸缺失", description: "无法加工。", severity: "high", dueAt: null });
    issues.create({ approvalId: approval.id, creatorUserId: creator.id, assigneeUserId: assignee.id,
      title: "文字建议", description: "建议优化表述。", severity: "low", dueAt: null });
    expect(issues.countBlockingForApproval(approval.id)).toBe(1);

    expect(issues.transition(high.id, { action: "force_close", actorUserId: admin.id, note: "已由线下评审确认，管理员强制关闭。" }))
      .toMatchObject({ status: "closed", forcedCloseReason: "已由线下评审确认，管理员强制关闭。" });
    expect(issues.countBlockingForApproval(approval.id)).toBe(0);
  });

  it("deduplicates retried creates and rejects stale concurrent transitions", () => {
    const { approval, creator, assignee, issues } = createContext();
    const input = {
      approvalId: approval.id,
      creatorUserId: creator.id,
      assigneeUserId: assignee.id,
      title: "基准符号缺失",
      description: "网络重试不应创建重复问题。",
      severity: "high" as const,
      clientRequestId: "issue-request-001"
    };
    const first = issues.create(input);
    const retried = issues.create(input);

    expect(retried.id).toBe(first.id);
    expect(issues.listForApproval(approval.id)).toHaveLength(1);
    expect(first.version).toBe(1);
    const started = issues.transition(first.id, { action: "start", actorUserId: assignee.id, expectedVersion: 1 });
    expect(started.version).toBe(2);
    expect(() => issues.transition(first.id, {
      action: "submit_review",
      actorUserId: assignee.id,
      note: "已补充。",
      expectedVersion: 1
    })).toThrow("ISSUE_VERSION_CONFLICT");
  });
});
