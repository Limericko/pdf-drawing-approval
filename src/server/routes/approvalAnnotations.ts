import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import { hasPdfHeader } from "../files/pdfValidation.ts";
import { generateAnnotatedPdf } from "../pdf/annotatePdf.ts";
import type { ApprovalAnnotation, ApprovalAnnotationRepository } from "../repositories/approvalAnnotations.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";

export const approvalAnnotationSchema = z.object({
  kind: z.enum(["pin", "rect", "arrow", "circle", "text", "ink", "cloud"]),
  message: z.string().trim().min(1).max(1000),
  pageNumber: z.number().int().min(1),
  xRatio: z.number().min(0).max(1),
  yRatio: z.number().min(0).max(1),
  widthRatio: z.number().min(0).max(1).optional().nullable(),
  heightRatio: z.number().min(0).max(1).optional().nullable(),
  endXRatio: z.number().min(0).max(1).optional().nullable(),
  endYRatio: z.number().min(0).max(1).optional().nullable(),
  pointsJson: z.string().optional().nullable(),
  styleJson: z.string().optional().nullable(),
  color: z.enum(["red", "amber", "blue", "green", "custom"]).default("red")
});

export function approvalAnnotationRoutes(deps: {
  approvals: ApprovalRepository;
  approvalAnnotations: ApprovalAnnotationRepository;
  operationLogs?: OperationLogRepository;
  jwtSecret: string;
}) {
  const router = Router();

  router.get("/:id/annotated-file", requireAuth(deps.jwtSecret), async (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval || !fs.existsSync(approval.currentFilePath)) {
      return res.status(404).json({ error: "NOT_FOUND" });
    }

    if (!(await hasPdfHeader(approval.currentFilePath))) {
      return res.status(422).json({
        error: "INVALID_PDF_FILE",
        message: "文件扩展名是 PDF，但文件内容不是有效 PDF。请检查坚果云是否已完成同步，或重新导出 PDF。"
      });
    }

    const annotations = deps.approvalAnnotations.listForApproval(approval.id);

    try {
      const annotatedPdf = await generateAnnotatedPdf({
        sourcePdfPath: approval.currentFilePath,
        annotations
      });
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "approval.annotated_pdf_opened",
        targetType: "approval",
        targetId: approval.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "用户"}打开了带批注审查版 PDF`,
        metadata: { annotationCount: annotations.length }
      });
      res
        .type("application/pdf")
        .set({
          "Cache-Control": "no-store, no-cache, must-revalidate, private",
          Pragma: "no-cache",
          Expires: "0"
        })
        .send(Buffer.from(annotatedPdf));
    } catch (error) {
      const message = errorMessage(error);
      if (message === "SOURCE_PDF_NOT_FOUND") return res.status(404).json({ error: "NOT_FOUND" });
      if (message === "PDF_PAGE_OUT_OF_RANGE") return res.status(422).json({ error: "PDF_PAGE_OUT_OF_RANGE" });
      return res.status(422).json({ error: "INVALID_PDF_FILE" });
    }
  });

  router.get("/:id/annotations", requireAuth(deps.jwtSecret), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    res.json(deps.approvalAnnotations.listForApproval(approval.id));
  });

  router.post("/:id/annotations", requireAuth(deps.jwtSecret, ["supervisor", "process", "admin"]), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    if (isReadonlyApproval(approval.status)) return res.status(409).json({ error: "APPROVAL_READONLY" });

    const parsed = approvalAnnotationSchema.safeParse(req.body);
    if (!parsed.success || !req.user) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      const annotation = deps.approvalAnnotations.create({
        approvalId: approval.id,
        authorUserId: req.user.id,
        ...parsed.data
      });
      deps.operationLogs?.create({
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        action: "approval.annotation_created",
        targetType: "approval",
        targetId: approval.id,
        message: `${req.user.displayName}添加了图纸批注`,
        metadata: annotationMetadata(annotation)
      });
      res.status(201).json(annotation);
    } catch (error) {
      if (isAnnotationValidationError(error)) return res.status(400).json({ error: errorMessage(error) });
      res.status(500).json({ error: "CREATE_ANNOTATION_FAILED" });
    }
  });

  router.post("/:id/annotations/reset", requireAuth(deps.jwtSecret, ["supervisor", "process", "admin"]), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    if (isReadonlyApproval(approval.status)) return res.status(409).json({ error: "APPROVAL_READONLY" });

    const deletedCount = deps.approvalAnnotations.deleteForApproval(approval.id);
    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: "approval.annotations_reset",
      targetType: "approval",
      targetId: approval.id,
      message: `${req.user?.displayName ?? req.user?.username ?? "用户"}将图纸批注回退到初始版`,
      metadata: { deletedCount }
    });
    res.json({ reset: true, deletedCount });
  });

  router.put("/:id/annotations/:annotationId", requireAuth(deps.jwtSecret), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    if (isReadonlyApproval(approval.status)) return res.status(409).json({ error: "APPROVAL_READONLY" });

    const annotation = deps.approvalAnnotations.getById(Number(req.params.annotationId));
    if (!annotation || annotation.approvalId !== approval.id) return res.status(404).json({ error: "ANNOTATION_NOT_FOUND" });
    if (!canManageAnnotation(req.user, annotation)) return res.status(403).json({ error: "FORBIDDEN" });

    const parsed = approvalAnnotationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      const updated = deps.approvalAnnotations.update(approval.id, annotation.id, parsed.data);
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "approval.annotation_updated",
        targetType: "approval",
        targetId: approval.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "用户"}更新了图纸批注`,
        metadata: annotationMetadata(updated)
      });
      res.json(updated);
    } catch (error) {
      if (errorMessage(error) === "ANNOTATION_ALREADY_RESOLVED") return res.status(409).json({ error: "ANNOTATION_ALREADY_RESOLVED" });
      if (isAnnotationValidationError(error)) return res.status(400).json({ error: errorMessage(error) });
      res.status(500).json({ error: "UPDATE_ANNOTATION_FAILED" });
    }
  });

  router.post("/:id/annotations/:annotationId/resolve", requireAuth(deps.jwtSecret), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });

    const annotation = deps.approvalAnnotations.getById(Number(req.params.annotationId));
    if (!annotation || annotation.approvalId !== approval.id) return res.status(404).json({ error: "ANNOTATION_NOT_FOUND" });
    if (!canResolveAnnotation(req.user, annotation)) return res.status(403).json({ error: "FORBIDDEN" });

    try {
      const resolved = deps.approvalAnnotations.resolve(approval.id, annotation.id, req.user!.id);
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "approval.annotation_resolved",
        targetType: "approval",
        targetId: approval.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "用户"}标记图纸批注已处理`,
        metadata: annotationMetadata(resolved)
      });
      res.json(resolved);
    } catch (error) {
      if (errorMessage(error) === "ANNOTATION_NOT_FOUND") return res.status(404).json({ error: "ANNOTATION_NOT_FOUND" });
      res.status(500).json({ error: "RESOLVE_ANNOTATION_FAILED" });
    }
  });

  router.delete("/:id/annotations/:annotationId", requireAuth(deps.jwtSecret), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    if (isReadonlyApproval(approval.status)) return res.status(409).json({ error: "APPROVAL_READONLY" });

    const annotation = deps.approvalAnnotations.getById(Number(req.params.annotationId));
    if (!annotation || annotation.approvalId !== approval.id) return res.status(404).json({ error: "ANNOTATION_NOT_FOUND" });
    if (!canManageAnnotation(req.user, annotation)) return res.status(403).json({ error: "FORBIDDEN" });

    try {
      const deleted = deps.approvalAnnotations.delete(approval.id, annotation.id);
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "approval.annotation_deleted",
        targetType: "approval",
        targetId: approval.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "用户"}删除了图纸批注`,
        metadata: annotationMetadata(deleted)
      });
      res.json({ deleted: true, annotationId: deleted.id });
    } catch (error) {
      if (errorMessage(error) === "ANNOTATION_ALREADY_RESOLVED") return res.status(409).json({ error: "ANNOTATION_ALREADY_RESOLVED" });
      res.status(500).json({ error: "DELETE_ANNOTATION_FAILED" });
    }
  });

  return router;
}

function canManageAnnotation(user: Express.Request["user"], annotation: ApprovalAnnotation) {
  return user?.role === "admin" || annotation.authorUserId === user?.id;
}

function canResolveAnnotation(user: Express.Request["user"], annotation: ApprovalAnnotation) {
  return user?.role === "admin" || user?.role === "designer" || annotation.authorUserId === user?.id;
}

function isReadonlyApproval(status: string) {
  return status === "printed_archived" || status === "voided";
}

function annotationMetadata(annotation: ApprovalAnnotation) {
  return {
    annotationId: annotation.id,
    kind: annotation.kind,
    pageNumber: annotation.pageNumber,
    resolved: annotation.resolved
  };
}

function isAnnotationValidationError(error: unknown) {
  const message = errorMessage(error);
  return (
    message === "INVALID_ANNOTATION_MESSAGE" ||
    message === "INVALID_ANNOTATION_COLOR" ||
    message === "INVALID_ANNOTATION_GEOMETRY"
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "";
}
