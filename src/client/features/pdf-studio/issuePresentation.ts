import type { ApprovalIssue, ApprovalIssueTransitionAction, User } from "../../api.ts";

export const issueSeverityLabels = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重"
} as const;

export const issueStatusLabels = {
  open: "待处理",
  in_progress: "处理中",
  review: "待复核",
  closed: "已关闭"
} as const;

export function availableIssueActions(issue: ApprovalIssue, user: User): ApprovalIssueTransitionAction[] {
  if (issue.status === "closed") return [];
  if (user.role === "admin") {
    const lifecycle = lifecycleActions(issue);
    return [...lifecycle, "force_close"];
  }
  if (issue.status === "open" && user.id === issue.assigneeUserId) return ["start"];
  if (issue.status === "in_progress" && user.id === issue.assigneeUserId) return ["submit_review"];
  if (issue.status === "review" && user.id !== issue.assigneeUserId && isReviewerOrCreator(issue, user)) {
    return ["return", "close"];
  }
  return [];
}

export function issueActionLabel(action: ApprovalIssueTransitionAction) {
  return ({
    start: "开始处理",
    submit_review: "提交复核",
    return: "退回修改",
    close: "复核关闭",
    force_close: "强制关闭"
  } as const)[action];
}

export function issueActionNeedsNote(action: ApprovalIssueTransitionAction) {
  return action !== "start";
}

function lifecycleActions(issue: ApprovalIssue): ApprovalIssueTransitionAction[] {
  if (issue.status === "open") return ["start"];
  if (issue.status === "in_progress") return ["submit_review"];
  if (issue.status === "review") return ["return", "close"];
  return [];
}

function isReviewerOrCreator(issue: ApprovalIssue, user: User) {
  return user.role === "supervisor" || user.role === "process" || user.id === issue.creatorUserId;
}
