import { describe, expect, it } from "vitest";
import type { ApprovalIssue, User } from "../../api.ts";
import { availableIssueActions, issueStatusLabels } from "./issuePresentation.ts";

const issue = {
  id: 1,
  approvalId: 2,
  annotationId: null,
  creatorUserId: 10,
  creatorDisplayName: "主管",
  assigneeUserId: 20,
  assigneeDisplayName: "设计师",
  title: "尺寸缺失",
  description: "无法加工",
  severity: "high",
  status: "review",
  dueAt: null,
  version: 3,
  resolutionSummary: "已补充",
  reviewNote: null,
  forcedCloseReason: null,
  submittedForReviewAt: null,
  closedByUserId: null,
  closedByDisplayName: null,
  closedAt: null,
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z"
} satisfies ApprovalIssue;

function user(id: number, role: User["role"]): User {
  return { id, username: `u${id}`, displayName: `用户${id}`, role, email: null, active: true };
}

describe("PDF Studio issue presentation", () => {
  it("uses the four-stage Chinese lifecycle", () => {
    expect(Object.values(issueStatusLabels)).toEqual(["待处理", "处理中", "待复核", "已关闭"]);
  });

  it("prevents assignees from closing their own issue", () => {
    expect(availableIssueActions(issue, user(20, "designer"))).toEqual([]);
    expect(availableIssueActions(issue, user(10, "supervisor"))).toEqual(["return", "close"]);
    expect(availableIssueActions(issue, user(30, "process"))).toEqual(["return", "close"]);
  });

  it("gives administrators the audited force-close path", () => {
    expect(availableIssueActions({ ...issue, status: "open" }, user(30, "admin"))).toEqual(["start", "force_close"]);
  });
});
