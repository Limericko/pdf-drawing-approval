import type { DatabaseConnection } from "../db.ts";

export type ApprovalIssueSeverity = "low" | "medium" | "high" | "critical";
export type ApprovalIssueStatus = "open" | "in_progress" | "review" | "closed";
export type ApprovalIssueTransitionAction = "start" | "submit_review" | "return" | "close" | "force_close";
export type ApprovalIssueEventAction = "created" | "started" | "submitted_review" | "returned" | "closed" | "force_closed";

export type ApprovalIssue = {
  id: number;
  approvalId: number;
  annotationId: number | null;
  creatorUserId: number;
  creatorDisplayName: string | null;
  assigneeUserId: number;
  assigneeDisplayName: string | null;
  title: string;
  description: string;
  severity: ApprovalIssueSeverity;
  status: ApprovalIssueStatus;
  dueAt: string | null;
  version: number;
  resolutionSummary: string | null;
  reviewNote: string | null;
  forcedCloseReason: string | null;
  submittedForReviewAt: string | null;
  closedByUserId: number | null;
  closedByDisplayName: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApprovalIssueEvent = {
  id: number;
  issueId: number;
  actorUserId: number;
  actorDisplayName: string | null;
  action: ApprovalIssueEventAction;
  fromStatus: ApprovalIssueStatus | null;
  toStatus: ApprovalIssueStatus;
  note: string | null;
  createdAt: string;
};

export type CreateApprovalIssueInput = {
  approvalId: number;
  annotationId?: number | null;
  creatorUserId: number;
  assigneeUserId: number;
  title: string;
  description: string;
  severity: ApprovalIssueSeverity;
  dueAt?: string | null;
  clientRequestId?: string | null;
};

export type UpdateApprovalIssueInput = Partial<Pick<
  CreateApprovalIssueInput,
  "assigneeUserId" | "title" | "description" | "severity" | "dueAt"
>>;

type ApprovalIssueRow = {
  id: number;
  approval_id: number;
  annotation_id: number | null;
  creator_user_id: number;
  creator_display_name: string | null;
  assignee_user_id: number;
  assignee_display_name: string | null;
  title: string;
  description: string;
  severity: ApprovalIssueSeverity;
  status: ApprovalIssueStatus;
  due_at: string | null;
  version: number;
  resolution_summary: string | null;
  review_note: string | null;
  forced_close_reason: string | null;
  submitted_for_review_at: string | null;
  closed_by_user_id: number | null;
  closed_by_display_name: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

type ApprovalIssueEventRow = {
  id: number;
  issue_id: number;
  actor_user_id: number;
  actor_display_name: string | null;
  action: ApprovalIssueEventAction;
  from_status: ApprovalIssueStatus | null;
  to_status: ApprovalIssueStatus;
  note: string | null;
  created_at: string;
};

const severities = new Set<ApprovalIssueSeverity>(["low", "medium", "high", "critical"]);
const issueSelect = `SELECT
  approval_issues.*,
  creator.display_name AS creator_display_name,
  assignee.display_name AS assignee_display_name,
  closed_by.display_name AS closed_by_display_name
FROM approval_issues
JOIN users AS creator ON creator.id = approval_issues.creator_user_id
JOIN users AS assignee ON assignee.id = approval_issues.assignee_user_id
LEFT JOIN users AS closed_by ON closed_by.id = approval_issues.closed_by_user_id`;

export class ApprovalIssueRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(input: CreateApprovalIssueInput): ApprovalIssue {
    return this.createValidated(input, true);
  }

  createInCurrentTransaction(input: CreateApprovalIssueInput): ApprovalIssue {
    return this.createValidated(input, false);
  }

  private createValidated(input: CreateApprovalIssueInput, manageTransaction: boolean): ApprovalIssue {
    const title = input.title.trim();
    const description = input.description.trim();
    const dueAt = normalizeOptionalText(input.dueAt ?? null);
    if (!title || title.length > 200) throw new Error("INVALID_ISSUE_TITLE");
    if (!description || description.length > 4000) throw new Error("INVALID_ISSUE_DESCRIPTION");
    if (!severities.has(input.severity)) throw new Error("INVALID_ISSUE_SEVERITY");
    if (dueAt && Number.isNaN(Date.parse(dueAt))) throw new Error("INVALID_ISSUE_DUE_AT");
    const clientRequestId = normalizeOptionalText(input.clientRequestId ?? null);
    if (clientRequestId && clientRequestId.length > 100) throw new Error("INVALID_ISSUE_REQUEST_ID");
    if (clientRequestId) {
      const existing = this.getByClientRequestId(clientRequestId);
      if (existing) return existing;
    }

    const insert = () => {
      const result = this.db.prepare(
        `INSERT INTO approval_issues (
          approval_id, annotation_id, creator_user_id, assignee_user_id,
          title, description, severity, due_at, client_request_id
        ) VALUES (
          @approvalId, @annotationId, @creatorUserId, @assigneeUserId,
          @title, @description, @severity, @dueAt, @clientRequestId
        )`
      ).run({
        approvalId: input.approvalId,
        annotationId: input.annotationId ?? null,
        creatorUserId: input.creatorUserId,
        assigneeUserId: input.assigneeUserId,
        title,
        description,
        severity: input.severity,
        dueAt,
        clientRequestId
      });
      const issueId = Number(result.lastInsertRowid);
      this.insertEvent({
        issueId,
        actorUserId: input.creatorUserId,
        action: "created",
        fromStatus: null,
        toStatus: "open",
        note: null
      });
      return this.getById(issueId)!;
    };
    return manageTransaction ? this.withTransaction(insert) : insert();
  }

  getById(id: number): ApprovalIssue | null {
    const row = this.db.prepare(`${issueSelect} WHERE approval_issues.id = ?`).get(id) as ApprovalIssueRow | undefined;
    return row ? mapIssue(row) : null;
  }

  getByClientRequestId(clientRequestId: string): ApprovalIssue | null {
    const row = this.db.prepare(`${issueSelect} WHERE approval_issues.client_request_id = ?`).get(clientRequestId) as ApprovalIssueRow | undefined;
    return row ? mapIssue(row) : null;
  }

  listForApproval(approvalId: number): ApprovalIssue[] {
    const rows = this.db.prepare(
      `${issueSelect}
       WHERE approval_issues.approval_id = ?
       ORDER BY
         CASE approval_issues.status WHEN 'closed' THEN 1 ELSE 0 END,
         CASE approval_issues.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         approval_issues.created_at ASC,
         approval_issues.id ASC`
    ).all(approvalId) as ApprovalIssueRow[];
    return rows.map(mapIssue);
  }

  listEvents(issueId: number): ApprovalIssueEvent[] {
    const rows = this.db.prepare(
      `SELECT approval_issue_events.*, users.display_name AS actor_display_name
       FROM approval_issue_events
       JOIN users ON users.id = approval_issue_events.actor_user_id
       WHERE approval_issue_events.issue_id = ?
       ORDER BY approval_issue_events.created_at ASC, approval_issue_events.id ASC`
    ).all(issueId) as ApprovalIssueEventRow[];
    return rows.map(mapEvent);
  }

  countBlockingForApproval(approvalId: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM approval_issues
       WHERE approval_id = ? AND status != 'closed' AND severity IN ('high', 'critical')`
    ).get(approvalId) as { count: number };
    return row.count;
  }

  update(issueId: number, input: UpdateApprovalIssueInput, expectedVersion?: number): ApprovalIssue {
    const issue = this.getById(issueId);
    if (!issue) throw new Error("ISSUE_NOT_FOUND");
    if (issue.status === "closed") throw new Error("ISSUE_ALREADY_CLOSED");

    const title = input.title === undefined ? issue.title : input.title.trim();
    const description = input.description === undefined ? issue.description : input.description.trim();
    const severity = input.severity ?? issue.severity;
    const dueAt = input.dueAt === undefined ? issue.dueAt : normalizeOptionalText(input.dueAt ?? null);
    if (!title || title.length > 200) throw new Error("INVALID_ISSUE_TITLE");
    if (!description || description.length > 4000) throw new Error("INVALID_ISSUE_DESCRIPTION");
    if (!severities.has(severity)) throw new Error("INVALID_ISSUE_SEVERITY");
    if (dueAt && Number.isNaN(Date.parse(dueAt))) throw new Error("INVALID_ISSUE_DUE_AT");

    const result = this.db.prepare(
      `UPDATE approval_issues SET
        assignee_user_id = @assigneeUserId,
        title = @title,
        description = @description,
        severity = @severity,
        due_at = @dueAt,
        updated_at = @updatedAt,
        version = version + 1
       WHERE id = @issueId AND version = @expectedVersion`
    ).run({
      issueId,
      assigneeUserId: input.assigneeUserId ?? issue.assigneeUserId,
      title,
      description,
      severity,
      dueAt,
      updatedAt: new Date().toISOString(),
      expectedVersion: expectedVersion ?? issue.version
    });
    if (Number(result.changes) !== 1) throw new Error("ISSUE_VERSION_CONFLICT");
    return this.getById(issueId)!;
  }

  transition(
    issueId: number,
    input: { action: ApprovalIssueTransitionAction; actorUserId: number; note?: string | null; expectedVersion?: number }
  ): ApprovalIssue {
    const issue = this.getById(issueId);
    if (!issue) throw new Error("ISSUE_NOT_FOUND");

    const transition = getTransition(issue.status, input.action);
    const note = normalizeOptionalText(input.note ?? null);
    if (transition.noteRequired && !note) throw new Error("ISSUE_TRANSITION_NOTE_REQUIRED");
    const now = new Date().toISOString();

    return this.withTransaction(() => {
      const changes: Record<string, string | number | null> = {
        id: issueId,
        expectedStatus: issue.status,
        expectedVersion: input.expectedVersion ?? issue.version,
        status: transition.toStatus,
        updatedAt: now,
        resolutionSummary: issue.resolutionSummary,
        reviewNote: issue.reviewNote,
        forcedCloseReason: issue.forcedCloseReason,
        submittedForReviewAt: issue.submittedForReviewAt,
        closedByUserId: issue.closedByUserId,
        closedAt: issue.closedAt
      };

      if (input.action === "submit_review") {
        changes.resolutionSummary = note;
        changes.submittedForReviewAt = now;
      } else if (input.action === "return") {
        changes.reviewNote = note;
      } else if (input.action === "close") {
        changes.reviewNote = note;
        changes.closedByUserId = input.actorUserId;
        changes.closedAt = now;
      } else if (input.action === "force_close") {
        changes.forcedCloseReason = note;
        changes.closedByUserId = input.actorUserId;
        changes.closedAt = now;
      }

      const result = this.db.prepare(
        `UPDATE approval_issues SET
          status = @status,
          resolution_summary = @resolutionSummary,
          review_note = @reviewNote,
          forced_close_reason = @forcedCloseReason,
          submitted_for_review_at = @submittedForReviewAt,
          closed_by_user_id = @closedByUserId,
          closed_at = @closedAt,
          updated_at = @updatedAt,
          version = version + 1
         WHERE id = @id AND status = @expectedStatus AND version = @expectedVersion`
      ).run(changes);
      if (Number(result.changes) !== 1) throw new Error("ISSUE_VERSION_CONFLICT");

      this.insertEvent({
        issueId,
        actorUserId: input.actorUserId,
        action: transition.eventAction,
        fromStatus: issue.status,
        toStatus: transition.toStatus,
        note
      });
      return this.getById(issueId)!;
    });
  }

  private insertEvent(input: {
    issueId: number;
    actorUserId: number;
    action: ApprovalIssueEventAction;
    fromStatus: ApprovalIssueStatus | null;
    toStatus: ApprovalIssueStatus;
    note: string | null;
  }) {
    this.db.prepare(
      `INSERT INTO approval_issue_events (
        issue_id, actor_user_id, action, from_status, to_status, note
      ) VALUES (
        @issueId, @actorUserId, @action, @fromStatus, @toStatus, @note
      )`
    ).run(input);
  }

  private withTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function getTransition(status: ApprovalIssueStatus, action: ApprovalIssueTransitionAction): {
  toStatus: ApprovalIssueStatus;
  eventAction: ApprovalIssueEventAction;
  noteRequired: boolean;
} {
  if (status === "open" && action === "start") {
    return { toStatus: "in_progress", eventAction: "started", noteRequired: false };
  }
  if (status === "in_progress" && action === "submit_review") {
    return { toStatus: "review", eventAction: "submitted_review", noteRequired: true };
  }
  if (status === "review" && action === "return") {
    return { toStatus: "in_progress", eventAction: "returned", noteRequired: true };
  }
  if (status === "review" && action === "close") {
    return { toStatus: "closed", eventAction: "closed", noteRequired: true };
  }
  if (status !== "closed" && action === "force_close") {
    return { toStatus: "closed", eventAction: "force_closed", noteRequired: true };
  }
  throw new Error("INVALID_ISSUE_TRANSITION");
}

function normalizeOptionalText(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function mapIssue(row: ApprovalIssueRow): ApprovalIssue {
  return {
    id: row.id,
    approvalId: row.approval_id,
    annotationId: row.annotation_id,
    creatorUserId: row.creator_user_id,
    creatorDisplayName: row.creator_display_name,
    assigneeUserId: row.assignee_user_id,
    assigneeDisplayName: row.assignee_display_name,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    dueAt: row.due_at,
    version: row.version,
    resolutionSummary: row.resolution_summary,
    reviewNote: row.review_note,
    forcedCloseReason: row.forced_close_reason,
    submittedForReviewAt: row.submitted_for_review_at,
    closedByUserId: row.closed_by_user_id,
    closedByDisplayName: row.closed_by_display_name,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapEvent(row: ApprovalIssueEventRow): ApprovalIssueEvent {
  return {
    id: row.id,
    issueId: row.issue_id,
    actorUserId: row.actor_user_id,
    actorDisplayName: row.actor_display_name,
    action: row.action,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    createdAt: row.created_at
  };
}
