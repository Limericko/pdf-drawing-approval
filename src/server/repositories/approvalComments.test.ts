import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "./approvals.ts";
import { ApprovalCommentRepository } from "./approvalComments.ts";
import { UserRepository } from "./users.ts";

function createContext() {
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const approvals = new ApprovalRepository(db);
  const comments = new ApprovalCommentRepository(db);
  const author = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
  const approval = approvals.create({
    projectName: "项目A",
    partName: "轴承座",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: "G:\\Nutstore\\01-待提交\\项目A\\轴承座-a0A0.pdf",
    currentFilePath: "G:\\Nutstore\\02-审批中\\项目A\\轴承座-a0A0.pdf"
  });
  return { comments, author, approval };
}

describe("approval comment repository", () => {
  it("creates comments and issues for an approval", () => {
    const { comments, approval, author } = createContext();

    const comment = comments.create({
      approvalId: approval.id,
      authorUserId: author.id,
      kind: "comment",
      message: "请注意倒角尺寸"
    });
    const issue = comments.create({
      approvalId: approval.id,
      authorUserId: author.id,
      kind: "issue",
      message: "标题栏缺少材料"
    });

    expect(comment.kind).toBe("comment");
    expect(comment.resolved).toBe(false);
    expect(issue.kind).toBe("issue");
    expect(issue.resolved).toBe(false);
  });

  it("lists comments for an approval with author metadata", () => {
    const { comments, approval, author } = createContext();
    comments.create({ approvalId: approval.id, authorUserId: author.id, kind: "comment", message: "第一条" });
    comments.create({ approvalId: approval.id, authorUserId: author.id, kind: "issue", message: "第二条" });

    const result = comments.listForApproval(approval.id);

    expect(result.map((item) => item.message)).toEqual(["第一条", "第二条"]);
    expect(result[0].authorDisplayName).toBe("设计师");
    expect(result[0].authorRole).toBe("designer");
  });

  it("resolves unresolved issues", () => {
    const { comments, approval, author } = createContext();
    const issue = comments.create({ approvalId: approval.id, authorUserId: author.id, kind: "issue", message: "待处理问题" });

    const resolved = comments.resolveIssue(approval.id, issue.id);

    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedAt).toBeTruthy();
  });
});
