import type { QueryResultRow } from "pg";
import { taskListQuerySchema, type TaskResponse } from "../../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../../shared/contracts/common.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";

type UserContextRow = QueryResultRow & {
  id: string;
  platform_role: "admin" | "member";
};

type TaskRow = QueryResultRow & {
  id: string;
  project_id: string | null;
  kind: TaskResponse["kind"];
  priority: TaskResponse["priority"];
  title: string;
  summary: string;
  due_at: Date | null;
  created_at: Date;
  route: string;
  resource_id: string | null;
};

export class TaskServiceError extends Error {
  constructor(readonly code:
    | "TASK_INPUT_INVALID"
    | "TASK_PROJECT_NOT_FOUND"
    | "TASK_DEPENDENCY_UNAVAILABLE",
  options?: ErrorOptions) {
    super(code, options);
    this.name = "TaskServiceError";
  }
}

export function createTaskService(options: { readonly pool: PlatformPool }) {
  if (!options?.pool) throw invalid();
  return Object.freeze({
    async listMyTasks(input: { readonly actorUserId: string; readonly projectId?: string }) {
      const actorUserId = ownId(input?.actorUserId);
      const parsed = taskListQuerySchema.safeParse(input?.projectId ? { projectId: input.projectId } : {});
      if (!parsed.success) throw invalid();
      const projectId = parsed.data.projectId;
      try {
        const context = await options.pool.query<UserContextRow>(
          "SELECT id,platform_role FROM platform.users WHERE id=$1 AND status='active'",
          [actorUserId]
        );
        const actor = context.rows[0];
        if (!actor) throw new TaskServiceError("TASK_PROJECT_NOT_FOUND");
        if (projectId) {
          const access = await options.pool.query<{ allowed: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM platform.project_members
             WHERE project_id=$1 AND user_id=$2 AND status='active') AS allowed`,
            [projectId, actorUserId]
          );
          if (!access.rows[0]?.allowed) throw new TaskServiceError("TASK_PROJECT_NOT_FOUND");
        }

        const rows = await options.pool.query<TaskRow>(taskProjectionSql(actor.platform_role === "admin"), [
          actorUserId,
          projectId ?? null
        ]);
        const items = rows.rows.map(mapTask).sort(compareTasks);
        return Object.freeze({
          items,
          counts: {
            blocking: items.filter(({ priority }) => priority === "blocking").length,
            total: items.length
          }
        });
      } catch (error) {
        if (error instanceof TaskServiceError) throw error;
        throw dependency(error);
      }
    }
  });
}

function taskProjectionSql(includeAdministration: boolean) {
  return `
    SELECT
      'approval:' || decision.id::text AS id,
      decision.project_id,
      'approval_review'::text AS kind,
      'high'::text AS priority,
      '待审核 · ' || document.name AS title,
      revision.revision_code || ' · ' || CASE decision.reviewer_role
        WHEN 'supervisor' THEN '主管审核' ELSE '工艺审核' END AS summary,
      NULL::timestamptz AS due_at,
      decision.created_at,
      '/projects/' || decision.project_id::text || '/approvals/' || approval.id::text AS route,
      approval.id AS resource_id
    FROM platform.review_decisions decision
    INNER JOIN platform.approval_cases approval ON approval.id=decision.approval_case_id AND approval.status='pending'
    INNER JOIN platform.drawing_revisions revision ON revision.id=approval.revision_id
    INNER JOIN platform.documents document ON document.id=revision.document_id
    WHERE decision.assigned_user_id=$1 AND decision.status='pending'
      AND ($2::uuid IS NULL OR decision.project_id=$2)

    UNION ALL

    SELECT
      'issue-assigned:' || issue.id::text,
      issue.project_id,
      'issue_assigned',
      CASE issue.severity WHEN 'critical' THEN 'blocking' WHEN 'high' THEN 'blocking'
        WHEN 'medium' THEN 'high' ELSE 'normal' END,
      '需处理 · ' || issue.title,
      document.document_code || ' · ' || revision.revision_code,
      issue.due_at,
      issue.created_at,
      '/projects/' || issue.project_id::text || '/approvals/' || issue.approval_case_id::text,
      issue.id
    FROM platform.issues issue
    INNER JOIN platform.approval_cases approval ON approval.id=issue.approval_case_id
    INNER JOIN platform.drawing_revisions revision ON revision.id=approval.revision_id
    INNER JOIN platform.documents document ON document.id=revision.document_id
    WHERE issue.assignee_user_id=$1 AND issue.status IN ('open','in_progress')
      AND ($2::uuid IS NULL OR issue.project_id=$2)

    UNION ALL

    SELECT
      'issue-review:' || issue.id::text,
      issue.project_id,
      'issue_review',
      CASE issue.severity WHEN 'critical' THEN 'blocking' WHEN 'high' THEN 'high' ELSE 'normal' END,
      '待复核 · ' || issue.title,
      document.document_code || ' · ' || revision.revision_code,
      issue.due_at,
      issue.updated_at,
      '/projects/' || issue.project_id::text || '/approvals/' || issue.approval_case_id::text,
      issue.id
    FROM platform.issues issue
    INNER JOIN platform.project_members membership
      ON membership.project_id=issue.project_id AND membership.user_id=$1 AND membership.status='active'
      AND membership.role IN ('manager','supervisor','process')
    INNER JOIN platform.approval_cases approval ON approval.id=issue.approval_case_id
    INNER JOIN platform.drawing_revisions revision ON revision.id=approval.revision_id
    INNER JOIN platform.documents document ON document.id=revision.document_id
    WHERE issue.status='review' AND issue.assignee_user_id<>$1
      AND ($2::uuid IS NULL OR issue.project_id=$2)

    UNION ALL

    SELECT
      'pdm-metadata:' || link.id::text,
      link.project_id,
      'pdm_metadata',
      'normal',
      '待补录 · ' || document.name,
      document.document_code || ' · ' || revision.revision_code,
      NULL::timestamptz,
      link.created_at,
      '/projects/' || link.project_id::text || '/pdm/parts/' || link.part_id::text,
      link.id
    FROM platform.part_revision_links link
    INNER JOIN platform.drawing_revisions revision ON revision.id=link.revision_id
    INNER JOIN platform.documents document ON document.id=revision.document_id
    INNER JOIN platform.project_members membership
      ON membership.project_id=link.project_id AND membership.user_id=$1 AND membership.status='active'
    WHERE link.release_status='pending_metadata'
      AND (membership.role='manager' OR (membership.role='designer' AND revision.created_by_user_id=$1))
      AND ($2::uuid IS NULL OR link.project_id=$2)
    ${includeAdministration ? administrationTaskSql() : ""}
  `;
}

function administrationTaskSql() {
  return `
    UNION ALL
    SELECT
      'render-failure:' || artifact.id::text,
      artifact.project_id,
      'render_failure',
      'blocking',
      'PDF 产物生成失败',
      document.document_code || ' · ' || artifact.kind,
      NULL::timestamptz,
      artifact.updated_at,
      '/administration/operations/render/' || artifact.id::text,
      artifact.id
    FROM platform.render_artifacts artifact
    INNER JOIN platform.approval_cases approval ON approval.id=artifact.approval_case_id
    INNER JOIN platform.drawing_revisions revision ON revision.id=approval.revision_id
    INNER JOIN platform.documents document ON document.id=revision.document_id
    WHERE artifact.status='failed' AND ($2::uuid IS NULL OR artifact.project_id=$2)

    UNION ALL
    SELECT
      'job-failure:' || job.id::text,
      NULL::uuid,
      'job_failure',
      'blocking',
      '后台任务进入死信',
      job.job_type || ' · 已尝试 ' || job.attempt_count::text || ' 次',
      NULL::timestamptz,
      job.updated_at,
      '/administration/operations/jobs/' || job.id::text,
      job.id
    FROM platform.jobs job
    WHERE job.status='dead' AND $2::uuid IS NULL

    UNION ALL
    SELECT
      'backup-warning:' || backup.id::text,
      NULL::uuid,
      'backup_warning',
      'blocking',
      '备份或恢复验证失败',
      backup.provider || ' · ' || backup.verification_status,
      NULL::timestamptz,
      backup.started_at,
      '/administration/backups/' || backup.id::text,
      backup.id
    FROM platform.backup_runs backup
    WHERE (backup.status='failed' OR backup.verification_status='failed') AND $2::uuid IS NULL
  `;
}

function mapTask(row: TaskRow): TaskResponse {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    priority: row.priority,
    title: row.title,
    summary: row.summary,
    dueAt: cloneDate(row.due_at)?.toISOString() ?? null,
    createdAt: cloneDate(row.created_at)!.toISOString(),
    target: { route: row.route, resourceId: row.resource_id }
  });
}

export function compareTasks(left: TaskResponse, right: TaskResponse) {
  const priority = { blocking: 0, high: 1, normal: 2, low: 3 } as const;
  const byPriority = priority[left.priority] - priority[right.priority];
  if (byPriority !== 0) return byPriority;
  const leftDue = left.dueAt ? Date.parse(left.dueAt) : Number.POSITIVE_INFINITY;
  const rightDue = right.dueAt ? Date.parse(right.dueAt) : Number.POSITIVE_INFINITY;
  if (leftDue !== rightDue) return leftDue - rightDue;
  const byCreated = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id, "en");
}

function ownId(value: unknown) {
  const parsed = uuidV7Schema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

function cloneDate(value: Date | null) {
  return value ? new Date(value) : null;
}

function invalid() { return new TaskServiceError("TASK_INPUT_INVALID"); }
function dependency(cause?: unknown) {
  return new TaskServiceError("TASK_DEPENDENCY_UNAVAILABLE", { cause });
}
