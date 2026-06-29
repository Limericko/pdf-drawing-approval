import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import type { ApprovalCommentRepository } from "../repositories/approvalComments.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";

export function approvalCommentRoutes(deps: {
  approvals: ApprovalRepository;
  approvalComments: ApprovalCommentRepository;
  operationLogs?: OperationLogRepository;
  jwtSecret: string;
}) {
  const router = Router();

  router.get("/:id/comments", requireAuth(deps.jwtSecret), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    res.json(deps.approvalComments.listForApproval(approval.id));
  });

  router.post("/:id/comments", requireAuth(deps.jwtSecret), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });

    const parsed = z
      .object({
        kind: z.enum(["comment", "issue"]),
        message: z.string().trim().min(1).max(2000)
      })
      .safeParse(req.body);
    if (!parsed.success || !req.user) return res.status(400).json({ error: "INVALID_INPUT" });

    const comment = deps.approvalComments.create({
      approvalId: approval.id,
      authorUserId: req.user.id,
      kind: parsed.data.kind,
      message: parsed.data.message
    });
    deps.operationLogs?.create({
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      action: parsed.data.kind === "issue" ? "approval.issue_created" : "approval.comment_created",
      targetType: "approval",
      targetId: approval.id,
      message: `${req.user.displayName}添加了${parsed.data.kind === "issue" ? "问题" : "评论"}`,
      metadata: { commentId: comment.id, kind: comment.kind }
    });
    res.status(201).json(comment);
  });

  router.post("/:id/comments/:commentId/resolve", requireAuth(deps.jwtSecret), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });

    try {
      const comment = deps.approvalComments.resolveIssue(approval.id, Number(req.params.commentId));
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "approval.issue_resolved",
        targetType: "approval",
        targetId: approval.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "用户"}解决了问题`,
        metadata: { commentId: comment.id }
      });
      res.json(comment);
    } catch (error) {
      const message = error instanceof Error ? error.message : "RESOLVE_COMMENT_FAILED";
      if (message === "COMMENT_NOT_FOUND") return res.status(404).json({ error: message });
      if (message === "COMMENT_NOT_ISSUE") return res.status(400).json({ error: message });
      res.status(500).json({ error: "RESOLVE_COMMENT_FAILED" });
    }
  });

  return router;
}
