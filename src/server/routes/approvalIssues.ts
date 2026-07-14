import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import type { ApprovalAnnotationRepository } from "../repositories/approvalAnnotations.ts";
import type {
  ApprovalIssue,
  ApprovalIssueRepository,
  ApprovalIssueTransitionAction
} from "../repositories/approvalIssues.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type { UserRepository } from "../repositories/users.ts";
import type { ApprovalIssueEventHub } from "../services/approvalIssueEventHub.ts";

const issueCreateSchema = z.object({
  annotationId: z.number().int().positive().optional().nullable(),
  assigneeUserId: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4000),
  severity: z.enum(["low", "medium", "high", "critical"]),
  dueAt: z.string().datetime().optional().nullable(),
  clientRequestId: z.string().trim().min(1).max(100).optional().nullable()
});

const issueUpdateSchema = issueCreateSchema
  .omit({ annotationId: true, clientRequestId: true })
  .partial()
  .extend({ expectedVersion: z.number().int().positive() })
  .refine((input) => Object.keys(input).length > 0);

const transitionSchema = z.object({
  action: z.enum(["start", "submit_review", "return", "close", "force_close"]),
  note: z.string().trim().max(4000).optional().nullable(),
  expectedVersion: z.number().int().positive().optional()
});

export function approvalIssueRoutes(deps: {
  approvals: ApprovalRepository;
  approvalIssues: ApprovalIssueRepository;
  approvalAnnotations?: ApprovalAnnotationRepository;
  users: UserRepository;
  operationLogs?: OperationLogRepository;
  issueEventHub?: ApprovalIssueEventHub;
  jwtSecret: string;
}) {
  const router = Router();

  router.get("/:id/issues/stream", requireAuth(deps.jwtSecret), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();
    res.write(`event: ready\ndata: ${JSON.stringify({ approvalId: approval.id })}\n\n`);
    const unsubscribe = deps.issueEventHub?.subscribe(approval.id, (event) => {
      res.write(`event: issue.changed\ndata: ${JSON.stringify(event)}\n\n`);
    }) ?? (() => undefined);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.get("/:id/issues", requireAuth(deps.jwtSecret), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    const issues = deps.approvalIssues.listForApproval(approval.id).map((issue) => ({
      ...issue,
      eventCount: deps.approvalIssues.listEvents(issue.id).length
    }));
    res.json(issues);
  });

  router.get("/:id/issues/assignees", requireAuth(deps.jwtSecret), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    res.json(deps.users.list().filter((user) => user.active && user.role === "designer"));
  });

  router.get("/:id/issues/:issueId/events", requireAuth(deps.jwtSecret), (req, res) => {
    const issue = findIssue(deps, Number(req.params.id), Number(req.params.issueId));
    if (!issue) return res.status(404).json({ error: "ISSUE_NOT_FOUND" });
    res.json(deps.approvalIssues.listEvents(issue.id));
  });

  router.post("/:id/issues", requireAuth(deps.jwtSecret, ["supervisor", "process", "admin"]), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    if (isReadonlyApproval(approval.status)) return res.status(409).json({ error: "APPROVAL_READONLY" });
    const parsed = issueCreateSchema.safeParse(req.body);
    if (!parsed.success || !req.user) return res.status(400).json({ error: "INVALID_INPUT" });
    if (!isActiveAssignee(deps.users, parsed.data.assigneeUserId)) {
      return res.status(400).json({ error: "INVALID_ISSUE_ASSIGNEE" });
    }
    if (parsed.data.annotationId) {
      const annotation = deps.approvalAnnotations?.getById(parsed.data.annotationId);
      if (!annotation || annotation.approvalId !== approval.id) {
        return res.status(400).json({ error: "INVALID_ISSUE_ANNOTATION" });
      }
    }

    try {
      if (parsed.data.clientRequestId) {
        const existing = deps.approvalIssues.getByClientRequestId(parsed.data.clientRequestId);
        if (existing) {
          if (existing.approvalId !== approval.id) return res.status(409).json({ error: "ISSUE_REQUEST_ID_CONFLICT" });
          return res.json(existing);
        }
      }
      const issue = deps.approvalIssues.create({
        approvalId: approval.id,
        creatorUserId: req.user.id,
        ...parsed.data
      });
      logIssueAction(deps, req.user, approval.id, issue, "approval.issue_created", "创建了正式问题");
      deps.issueEventHub?.publish({ type: "issue.changed", approvalId: approval.id, issueId: issue.id, version: issue.version });
      res.status(201).json(issue);
    } catch (error) {
      const message = errorMessage(error);
      if (message.startsWith("INVALID_ISSUE_")) return res.status(400).json({ error: message });
      res.status(500).json({ error: "CREATE_ISSUE_FAILED" });
    }
  });

  router.patch("/:id/issues/:issueId", requireAuth(deps.jwtSecret), (req, res) => {
    const issue = findIssue(deps, Number(req.params.id), Number(req.params.issueId));
    if (!issue) return res.status(404).json({ error: "ISSUE_NOT_FOUND" });
    if (!canEditIssue(req.user, issue)) return res.status(403).json({ error: "FORBIDDEN" });
    const parsed = issueUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
    if (parsed.data.assigneeUserId !== undefined && !isActiveAssignee(deps.users, parsed.data.assigneeUserId)) {
      return res.status(400).json({ error: "INVALID_ISSUE_ASSIGNEE" });
    }

    try {
      const { expectedVersion, ...update } = parsed.data;
      const updated = deps.approvalIssues.update(issue.id, update, expectedVersion);
      logIssueAction(deps, req.user!, issue.approvalId, updated, "approval.issue_updated", "更新了正式问题");
      deps.issueEventHub?.publish({ type: "issue.changed", approvalId: issue.approvalId, issueId: updated.id, version: updated.version });
      res.json(updated);
    } catch (error) {
      const message = errorMessage(error);
      if (message === "ISSUE_ALREADY_CLOSED") return res.status(409).json({ error: message });
      if (message === "ISSUE_VERSION_CONFLICT") return res.status(409).json({ error: message });
      if (message.startsWith("INVALID_ISSUE_")) return res.status(400).json({ error: message });
      res.status(500).json({ error: "UPDATE_ISSUE_FAILED" });
    }
  });

  router.post("/:id/issues/:issueId/transitions", requireAuth(deps.jwtSecret), (req, res) => {
    const issue = findIssue(deps, Number(req.params.id), Number(req.params.issueId));
    if (!issue) return res.status(404).json({ error: "ISSUE_NOT_FOUND" });
    const parsed = transitionSchema.safeParse(req.body);
    if (!parsed.success || !req.user) return res.status(400).json({ error: "INVALID_INPUT" });
    if (!canTransitionIssue(req.user, issue, parsed.data.action)) {
      return res.status(403).json({ error: "FORBIDDEN" });
    }

    try {
      const updated = deps.approvalIssues.transition(issue.id, {
        action: parsed.data.action,
        actorUserId: req.user.id,
        note: parsed.data.note,
        expectedVersion: parsed.data.expectedVersion
      });
      logIssueAction(
        deps,
        req.user,
        issue.approvalId,
        updated,
        `approval.issue_${parsed.data.action}`,
        transitionMessage(parsed.data.action)
      );
      deps.issueEventHub?.publish({ type: "issue.changed", approvalId: issue.approvalId, issueId: updated.id, version: updated.version });
      res.json(updated);
    } catch (error) {
      const message = errorMessage(error);
      if (message === "ISSUE_TRANSITION_NOTE_REQUIRED") return res.status(400).json({ error: message });
      if (message === "INVALID_ISSUE_TRANSITION" || message === "ISSUE_VERSION_CONFLICT") {
        return res.status(409).json({ error: message });
      }
      res.status(500).json({ error: "ISSUE_TRANSITION_FAILED" });
    }
  });

  return router;
}

function findIssue(
  deps: Pick<Parameters<typeof approvalIssueRoutes>[0], "approvals" | "approvalIssues">,
  approvalId: number,
  issueId: number
) {
  const approval = deps.approvals.getById(approvalId);
  if (!approval) return null;
  const issue = deps.approvalIssues.getById(issueId);
  return issue?.approvalId === approval.id ? issue : null;
}

function canEditIssue(user: Express.Request["user"], issue: ApprovalIssue) {
  return Boolean(
    user && (user.role === "admin" || user.role === "supervisor" || user.role === "process" || user.id === issue.creatorUserId)
  );
}

function canTransitionIssue(
  user: Express.Request["user"],
  issue: ApprovalIssue,
  action: ApprovalIssueTransitionAction
) {
  if (!user) return false;
  if (action === "force_close") return user.role === "admin";
  if (action === "start" || action === "submit_review") {
    return user.role === "admin" || user.id === issue.assigneeUserId;
  }
  if (action === "return") {
    return user.role === "admin" || user.role === "supervisor" || user.role === "process" || user.id === issue.creatorUserId;
  }
  if (action === "close") {
    if (user.id === issue.assigneeUserId) return false;
    return user.role === "admin" || user.role === "supervisor" || user.role === "process" || user.id === issue.creatorUserId;
  }
  return false;
}

function isActiveAssignee(users: UserRepository, userId: number) {
  const user = users.getById(userId);
  return Boolean(user?.active && user.role === "designer");
}

function isReadonlyApproval(status: string) {
  return status === "printed_archived" || status === "voided";
}

function logIssueAction(
  deps: Pick<Parameters<typeof approvalIssueRoutes>[0], "operationLogs">,
  user: NonNullable<Express.Request["user"]>,
  approvalId: number,
  issue: ApprovalIssue,
  action: string,
  verb: string
) {
  deps.operationLogs?.create({
    actorUserId: user.id,
    actorUsername: user.username,
    action,
    targetType: "approval",
    targetId: approvalId,
    message: `${user.displayName}${verb}“${issue.title}”`,
    metadata: { issueId: issue.id, severity: issue.severity, status: issue.status, assigneeUserId: issue.assigneeUserId }
  });
}

function transitionMessage(action: ApprovalIssueTransitionAction) {
  return ({
    start: "开始处理",
    submit_review: "提交复核",
    return: "退回了",
    close: "复核关闭了",
    force_close: "强制关闭了"
  } as const)[action];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "";
}
