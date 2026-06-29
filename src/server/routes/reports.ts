import { Router } from "express";
import type { SQLInputValue } from "node:sqlite";
import { requireAuth } from "../auth.ts";
import type { DatabaseConnection } from "../db.ts";

type ApprovalReportRow = {
  id: number;
  project_name: string;
  part_name: string;
  version: string;
  status: string;
  submitted_by: string | null;
  submitted_by_display_name: string | null;
  submitted_at: string;
  supervisor_status: string;
  supervisor_reviewed_at: string | null;
  process_status: string;
  process_reviewed_at: string | null;
  signature_status: string;
  signed_file_path: string | null;
  original_file_hash: string | null;
  signed_file_hash: string | null;
  archived_at: string | null;
  comment_summary: string | null;
  version_count: number;
};

export function reportRoutes(deps: { db: DatabaseConnection; jwtSecret: string }) {
  const router = Router();

  router.get("/approvals.csv", requireAuth(deps.jwtSecret, ["admin"]), (req, res) => {
    const rows = listApprovalReportRows(deps.db, {
      projectName: typeof req.query.projectName === "string" ? req.query.projectName.trim() : "",
      status: typeof req.query.status === "string" ? req.query.status.trim() : "",
      from: typeof req.query.from === "string" ? req.query.from.trim() : "",
      to: typeof req.query.to === "string" ? req.query.to.trim() : ""
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="approvals-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows));
  });

  return router;
}

function listApprovalReportRows(
  db: DatabaseConnection,
  filters: { projectName: string; status: string; from: string; to: string }
) {
  const conditions: string[] = [];
  const params: Record<string, SQLInputValue> = {};

  if (filters.projectName) {
    conditions.push("approvals.project_name = @projectName");
    params.projectName = filters.projectName;
  }

  if (filters.status) {
    conditions.push("approvals.status = @status");
    params.status = filters.status;
  }

  if (filters.from) {
    conditions.push("approvals.submitted_at >= @from");
    params.from = normalizeDateBoundary(filters.from, "start");
  }

  if (filters.to) {
    conditions.push("approvals.submitted_at <= @to");
    params.to = normalizeDateBoundary(filters.to, "end");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT
         approvals.*,
         users.display_name AS submitted_by_display_name,
         (
           SELECT COUNT(*)
           FROM approvals AS related_approvals
           WHERE related_approvals.project_name = approvals.project_name
             AND related_approvals.part_name = approvals.part_name
         ) AS version_count,
         (
           SELECT group_concat(summary, ' | ')
           FROM (
             SELECT
               CASE approval_comments.kind
                 WHEN 'issue' THEN '问题'
                 ELSE '评论'
               END || ': ' || approval_comments.message AS summary
             FROM approval_comments
             WHERE approval_comments.approval_id = approvals.id
             ORDER BY approval_comments.created_at DESC, approval_comments.id DESC
             LIMIT 3
           )
         ) AS comment_summary
       FROM approvals
       LEFT JOIN users ON users.id = approvals.submitted_by_user_id
       ${where}
       ORDER BY approvals.submitted_at DESC, approvals.id DESC`
    )
    .all(params) as ApprovalReportRow[];
}

function toCsv(rows: ApprovalReportRow[]) {
  const header = [
    "审批单ID",
    "项目",
    "零件",
    "版本",
    "同零件版本数",
    "状态",
    "提交人",
    "提交时间",
    "主管状态",
    "主管时间",
    "工艺状态",
    "工艺时间",
    "签名状态",
    "签后文件",
    "原始哈希",
    "签后哈希",
    "归档时间",
    "最近问题/评论摘要"
  ];

  return [
    header.map(csvCell).join(","),
    ...rows.map((row) =>
      [
        row.id,
        row.project_name,
        row.part_name,
        row.version,
        row.version_count,
        row.status,
        row.submitted_by_display_name ?? row.submitted_by ?? "",
        row.submitted_at,
        row.supervisor_status,
        row.supervisor_reviewed_at ?? "",
        row.process_status,
        row.process_reviewed_at ?? "",
        row.signature_status,
        row.signed_file_path ?? "",
        row.original_file_hash ?? "",
        row.signed_file_hash ?? "",
        row.archived_at ?? "",
        row.comment_summary ?? ""
      ]
        .map(csvCell)
        .join(",")
    )
  ].join("\r\n");
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function normalizeDateBoundary(value: string, boundary: "start" | "end") {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return boundary === "start" ? `${value} 00:00:00` : `${value} 23:59:59`;
  }
  return value;
}
