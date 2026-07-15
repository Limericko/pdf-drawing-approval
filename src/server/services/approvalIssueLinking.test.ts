import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalAnnotationRepository } from "../repositories/approvalAnnotations.ts";
import { ApprovalIssueRepository } from "../repositories/approvalIssues.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { UserRepository } from "../repositories/users.ts";
import { createLinkedApprovalIssue } from "./approvalIssueLinking.ts";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

function context() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const users = new UserRepository(db);
  const creator = users.create({ username: "linked_supervisor", password: "123456", role: "supervisor", displayName: "主管" });
  const assignee = users.create({ username: "linked_designer", password: "123456", role: "designer", displayName: "设计师" });
  const approval = new ApprovalRepository(db).create({
    projectName: "原子问题项目",
    partName: "联轴器",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: "C:\\drawings\\coupling.pdf",
    currentFilePath: "C:\\drawings\\coupling.pdf",
    source: "web_upload",
    submittedByUserId: assignee.id
  });
  return {
    db,
    creator,
    assignee,
    approval,
    annotations: new ApprovalAnnotationRepository(db),
    issues: new ApprovalIssueRepository(db)
  };
}

function linkedInput(current: ReturnType<typeof context>) {
  return {
    issue: {
      approvalId: current.approval.id,
      creatorUserId: current.creator.id,
      assigneeUserId: current.assignee.id,
      title: "孔径公差缺失",
      description: "请补充 H7 公差。",
      severity: "high" as const,
      dueAt: null,
      clientRequestId: "linked-request-001"
    },
    annotation: {
      approvalId: current.approval.id,
      authorUserId: current.creator.id,
      kind: "rect" as const,
      message: "请补充 H7 公差。",
      pageNumber: 1,
      xRatio: 0.2,
      yRatio: 0.3,
      widthRatio: 0.2,
      heightRatio: 0.1,
      color: "red" as const
    }
  };
}

describe("linked approval issue creation", () => {
  it("commits one annotation and one issue and deduplicates a retried request", () => {
    const current = context();
    const first = createLinkedApprovalIssue({
      db: current.db,
      approvalAnnotations: current.annotations,
      approvalIssues: current.issues
    }, linkedInput(current));
    const retried = createLinkedApprovalIssue({
      db: current.db,
      approvalAnnotations: current.annotations,
      approvalIssues: current.issues
    }, linkedInput(current));

    expect(first.created).toBe(true);
    expect(retried.created).toBe(false);
    expect(retried.issue).toEqual(first.issue);
    expect(retried.annotation).toEqual(first.annotation);
    expect(current.annotations.listForApproval(current.approval.id)).toHaveLength(1);
    expect(current.issues.listForApproval(current.approval.id)).toHaveLength(1);
    expect(first.issue.annotationId).toBe(first.annotation.id);
  });

  it("rolls back the annotation when issue insertion fails", () => {
    const current = context();
    const input = linkedInput(current);
    input.issue.title = "";

    expect(() => createLinkedApprovalIssue({
      db: current.db,
      approvalAnnotations: current.annotations,
      approvalIssues: current.issues
    }, input)).toThrow("INVALID_ISSUE_TITLE");
    expect(current.annotations.listForApproval(current.approval.id)).toEqual([]);
    expect(current.issues.listForApproval(current.approval.id)).toEqual([]);
  });
});
