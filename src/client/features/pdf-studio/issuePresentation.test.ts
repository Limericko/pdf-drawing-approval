import { describe, expect, it } from "vitest";
import type { ApprovalIssue, User } from "../../api.ts";
import { availableIssueActions, filterApprovalIssues, issueFilterPageNumbers, issueStatusLabels } from "./issuePresentation.ts";

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
  it("offers every PDF page while preserving annotation pages before the document is ready", () => {
    expect(issueFilterPageNumbers(4, { 11: 2, 12: 7 })).toEqual([1, 2, 3, 4, 7]);
    expect(issueFilterPageNumbers(0, { 12: 7 })).toEqual([7]);
  });

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

  it("filters by lifecycle, severity, assignee and linked PDF page", () => {
    const first = { ...issue, id: 1, status: "open" as const, severity: "high" as const, assigneeUserId: 20, annotationId: 101 };
    const second = { ...issue, id: 2, status: "review" as const, severity: "medium" as const, assigneeUserId: 21, annotationId: 102 };
    const pages = { 101: 1, 102: 7 };

    expect(filterApprovalIssues([first, second], {
      status: "review",
      severity: "medium",
      assigneeUserId: 21,
      pageNumber: 7
    }, pages)).toEqual([second]);
    expect(filterApprovalIssues([first, second], {
      status: "all",
      severity: "high",
      assigneeUserId: "all",
      pageNumber: 7
    }, pages)).toEqual([]);
  });
});
