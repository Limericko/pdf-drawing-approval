import type { DatabaseConnection } from "../db.ts";
import type { UserRole } from "./users.ts";

export type ApprovalCommentKind = "comment" | "issue";

export type ApprovalComment = {
  id: number;
  approvalId: number;
  authorUserId: number;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorRole: UserRole | null;
  kind: ApprovalCommentKind;
  message: string;
  resolved: boolean;
  createdAt: string;
  resolvedAt: string | null;
};

type ApprovalCommentRow = {
  id: number;
  approval_id: number;
  author_user_id: number;
  author_username: string | null;
  author_display_name: string | null;
  author_role: UserRole | null;
  kind: ApprovalCommentKind;
  message: string;
  resolved: number;
  created_at: string;
  resolved_at: string | null;
};

export class ApprovalCommentRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(input: {
    approvalId: number;
    authorUserId: number;
    kind: ApprovalCommentKind;
    message: string;
  }): ApprovalComment {
    const result = this.db
      .prepare(
        `INSERT INTO approval_comments (approval_id, author_user_id, kind, message)
         VALUES (@approvalId, @authorUserId, @kind, @message)`
      )
      .run({
        approvalId: input.approvalId,
        authorUserId: input.authorUserId,
        kind: input.kind,
        message: input.message
      });
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): ApprovalComment | null {
    const row = this.db
      .prepare(
        `SELECT
           approval_comments.*,
           users.username AS author_username,
           users.display_name AS author_display_name,
           users.role AS author_role
         FROM approval_comments
         LEFT JOIN users ON users.id = approval_comments.author_user_id
         WHERE approval_comments.id = ?`
      )
      .get(id) as ApprovalCommentRow | undefined;
    return row ? mapApprovalComment(row) : null;
  }

  listForApproval(approvalId: number): ApprovalComment[] {
    const rows = this.db
      .prepare(
        `SELECT
           approval_comments.*,
           users.username AS author_username,
           users.display_name AS author_display_name,
           users.role AS author_role
         FROM approval_comments
         LEFT JOIN users ON users.id = approval_comments.author_user_id
         WHERE approval_comments.approval_id = ?
         ORDER BY approval_comments.created_at ASC, approval_comments.id ASC`
      )
      .all(approvalId) as ApprovalCommentRow[];
    return rows.map(mapApprovalComment);
  }

  resolveIssue(approvalId: number, commentId: number): ApprovalComment {
    const existing = this.getById(commentId);
    if (!existing || existing.approvalId !== approvalId) {
      throw new Error("COMMENT_NOT_FOUND");
    }
    if (existing.kind !== "issue") {
      throw new Error("COMMENT_NOT_ISSUE");
    }

    this.db
      .prepare("UPDATE approval_comments SET resolved = 1, resolved_at = ? WHERE id = ?")
      .run(new Date().toISOString(), commentId);
    return this.getById(commentId)!;
  }
}

function mapApprovalComment(row: ApprovalCommentRow): ApprovalComment {
  return {
    id: row.id,
    approvalId: row.approval_id,
    authorUserId: row.author_user_id,
    authorUsername: row.author_username,
    authorDisplayName: row.author_display_name,
    authorRole: row.author_role,
    kind: row.kind,
    message: row.message,
    resolved: row.resolved === 1,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}
