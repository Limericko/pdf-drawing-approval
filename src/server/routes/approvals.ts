import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import type { ApprovalAnnotationRepository } from "../repositories/approvalAnnotations.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import type { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import type { SignaturePlacementRepository } from "../repositories/signaturePlacements.ts";
import type { SignatureTemplateRepository } from "../repositories/signatureTemplates.ts";
import type { NotificationEventKey } from "../repositories/userPreferences.ts";
import type { UserRepository } from "../repositories/users.ts";
import { moveApprovalFile } from "../services/fileMoveService.ts";
import { tryGenerateSignedPdfForApproval } from "../services/signingWorkflow.ts";
import { hasPdfHeader } from "../files/pdfValidation.ts";
import { folders, targetPath } from "../files/fileLocations.ts";

const managedStatusFolders = new Set<string>(Object.values(folders));

export function approvalRoutes(deps: {
  approvals: ApprovalRepository;
  approvalAnnotations?: ApprovalAnnotationRepository;
  settings: SettingsRepository;
  operationLogs?: OperationLogRepository;
  signatureAssets?: SignatureAssetRepository;
  signaturePlacements?: SignaturePlacementRepository;
  signatureTemplates?: SignatureTemplateRepository;
  users?: UserRepository;
  notifyApprovalEvent?: (
    event: NotificationEventKey,
    approvalId: number,
    actor?: { actorUserId?: number | null; actorUsername?: string | null }
  ) => Promise<unknown>;
  jwtSecret: string;
}) {
  const router = Router();

  router.post("/batch/generate-signed-pdf", requireAuth(deps.jwtSecret, ["admin", "designer"]), async (req, res) => {
    if (!deps.signatureAssets || !deps.signaturePlacements || !deps.users) {
      return res.status(500).json({ error: "SIGNING_UNAVAILABLE" });
    }

    const parsed = approvalIdsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    const items = [];
    for (const approvalId of parsed.data.approvalIds) {
      const approval = deps.approvals.getById(approvalId);
      if (!approval) {
        items.push(batchFailedItem(approvalId, "APPROVAL_NOT_FOUND"));
        continue;
      }
      if (approval.status !== "approved_for_print") {
        items.push(batchFailedItem(approvalId, "APPROVAL_NOT_SIGNABLE"));
        continue;
      }
      if (approval.signatureStatus === "not_required") {
        items.push(batchFailedItem(approvalId, "SIGNATURE_NOT_REQUIRED"));
        continue;
      }

      const signed = await tryGenerateSignedPdfForApproval(approval.id, {
        approvals: deps.approvals,
        settings: deps.settings,
        operationLogs: deps.operationLogs,
        signatureAssets: deps.signatureAssets,
        signaturePlacements: deps.signaturePlacements,
        users: deps.users,
        notifySignatureFailed: (approvalId) =>
          deps.notifyApprovalEvent?.("signatureFailed", approvalId, { actorUserId: null, actorUsername: "system" }) ?? Promise.resolve()
      });
      if (signed?.signatureStatus === "generated") {
        items.push(batchCompletedItem(approvalId, signed));
      } else {
        items.push(batchFailedItem(approvalId, signed?.signatureError ?? "SIGNING_FAILED", signed ?? approval));
      }
    }

    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: "approval.batch_generate_signed_pdf",
      targetType: "approval_batch",
      targetId: null,
      message: `${req.user?.displayName ?? req.user?.username ?? "用户"}批量重新生成签后 PDF`,
      metadata: batchSummary(items)
    });
    res.json(batchSummaryResponse(items));
  });

  router.post("/batch/mark-printed", requireAuth(deps.jwtSecret, ["admin", "designer"]), async (req, res) => {
    const parsed = approvalIdsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    const watchRoot = deps.settings.get("watch_root");
    const items = [];
    for (const approvalId of parsed.data.approvalIds) {
      try {
        const approval = deps.approvals.markPrinted(approvalId);
        const moved = watchRoot ? await moveApprovalFile(approval, watchRoot, deps.approvals) : approval;
        deps.operationLogs?.create({
          actorUserId: req.user?.id ?? null,
          actorUsername: req.user?.username ?? null,
          action: "approval.printed",
          targetType: "approval",
          targetId: moved.id,
          message: `${req.user?.displayName ?? req.user?.username ?? "用户"}批量标记图纸已打印归档`,
          metadata: { currentFilePath: moved.currentFilePath, batch: true }
        });
        await deps.notifyApprovalEvent?.("approvalPrinted", moved.id, {
          actorUserId: req.user?.id ?? null,
          actorUsername: req.user?.username ?? null
        }).catch(() => undefined);
        items.push(batchCompletedItem(approvalId, moved));
      } catch (error) {
        const message = error instanceof Error ? error.message : "MARK_PRINTED_FAILED";
        items.push(batchFailedItem(approvalId, message));
      }
    }

    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: "approval.batch_mark_printed",
      targetType: "approval_batch",
      targetId: null,
      message: `${req.user?.displayName ?? req.user?.username ?? "用户"}批量标记打印归档`,
      metadata: batchSummary(items)
    });
    res.json(batchSummaryResponse(items));
  });

  router.get("/", requireAuth(deps.jwtSecret), (req, res) => {
    const status = typeof req.query.status === "string" ? (req.query.status as never) : undefined;
    const signatureStatus = typeof req.query.signatureStatus === "string" ? (req.query.signatureStatus as never) : undefined;
    const keyword = typeof req.query.keyword === "string" ? req.query.keyword : undefined;
    const page = typeof req.query.page === "string" ? Number(req.query.page) : undefined;
    const pageSize = typeof req.query.pageSize === "string" ? Number(req.query.pageSize) : undefined;
    const wantsPaged = page !== undefined || pageSize !== undefined || keyword !== undefined;
    const mine = req.query.mine === "1";
    if (mine && req.user?.role !== "supervisor" && req.user?.role !== "process") {
      return res.json(wantsPaged ? { items: [], total: 0, page: 1, pageSize: clampPageSize(pageSize) } : []);
    }
    const reviewerRole = mine ? (req.user?.role as "supervisor" | "process") : undefined;
    if (wantsPaged) {
      return res.json(
        deps.approvals.listPaged({
          status,
          signatureStatus,
          reviewerRole,
          keyword,
          page: Number.isFinite(page) ? Number(page) : 1,
          pageSize: clampPageSize(pageSize)
        })
      );
    }
    res.json(deps.approvals.list({ status, signatureStatus, reviewerRole }));
  });

  router.get("/:id", requireAuth(deps.jwtSecret), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "NOT_FOUND" });
    res.json({
      ...approval,
      history: deps.approvals.listHistory(approval.projectName, approval.partName),
      relatedVersions: deps.approvals.listVersions(approval.projectName, approval.partName, approval.id)
    });
  });

  router.get("/:id/file", requireAuth(deps.jwtSecret), async (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval || !fs.existsSync(approval.currentFilePath)) return res.status(404).json({ error: "NOT_FOUND" });
    if (!(await hasPdfHeader(approval.currentFilePath))) {
      return res.status(422).json({
        error: "INVALID_PDF_FILE",
        message: "文件扩展名是 PDF，但文件内容不是有效 PDF。请检查坚果云是否已完成同步，或重新导出 PDF。"
      });
    }
    res.type("application/pdf").sendFile(approval.currentFilePath);
  });

  router.get("/:id/signed-file", requireAuth(deps.jwtSecret), async (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval?.signedFilePath || !fs.existsSync(approval.signedFilePath)) {
      return res.status(404).json({ error: "SIGNED_FILE_NOT_FOUND" });
    }
    if (!(await hasPdfHeader(approval.signedFilePath))) {
      return res.status(422).json({ error: "INVALID_PDF_FILE" });
    }
    res.type("application/pdf").sendFile(approval.signedFilePath, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        Pragma: "no-cache",
        Expires: "0"
      }
    });
  });

  router.get("/:id/signature-placements", requireAuth(deps.jwtSecret), (req, res) => {
    if (!deps.signaturePlacements) return res.status(500).json({ error: "SIGNATURE_PLACEMENTS_UNAVAILABLE" });
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    res.json(deps.signaturePlacements.listForApproval(approval.id));
  });

  router.post("/:id/signature-templates", requireAuth(deps.jwtSecret, ["designer", "admin"]), (req, res) => {
    if (!deps.signaturePlacements || !deps.signatureTemplates) {
      return res.status(500).json({ error: "SIGNATURE_TEMPLATES_UNAVAILABLE" });
    }

    const schema = z.object({
      name: z.string().trim().min(1),
      projectName: z.string().trim().min(1).nullable().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });

    const placements = deps.signaturePlacements.listForApproval(approval.id);
    if (placements.length !== 3 || !hasRequiredSignaturePlacementRoles(placements)) {
      return res.status(400).json({ error: "SIGNATURE_PLACEMENTS_REQUIRED" });
    }

    try {
      const template = deps.signatureTemplates.create({
        name: parsed.data.name,
        projectName: parsed.data.projectName === undefined ? approval.projectName : parsed.data.projectName,
        placements,
        createdByUserId: req.user?.id ?? null
      });
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "signature.template_created_from_approval",
        targetType: "approval",
        targetId: approval.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "用户"}将当前签名框保存为模板`,
        metadata: { templateId: template.id, templateName: template.name, projectName: template.projectName }
      });
      res.status(201).json(template);
    } catch (error) {
      const message = error instanceof Error ? error.message : "SIGNATURE_TEMPLATE_CREATE_FAILED";
      if (
        message === "SIGNATURE_TEMPLATE_NAME_REQUIRED" ||
        message === "SIGNATURE_TEMPLATE_REQUIRES_ALL_ROLES" ||
        message === "INVALID_SIGNATURE_ROLE" ||
        message === "INVALID_SIGNATURE_PLACEMENT"
      ) {
        return res.status(400).json({ error: "INVALID_SIGNATURE_TEMPLATE" });
      }
      res.status(500).json({ error: "SIGNATURE_TEMPLATE_CREATE_FAILED" });
    }
  });

  router.put("/:id/signature-placements", requireAuth(deps.jwtSecret), async (req, res) => {
    if (!deps.signaturePlacements) return res.status(500).json({ error: "SIGNATURE_PLACEMENTS_UNAVAILABLE" });
    if (req.user?.role !== "admin" && req.user?.role !== "designer") return res.status(403).json({ error: "FORBIDDEN" });

    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    if (approval.status === "printed_archived" || approval.status === "voided") {
      return res.status(400).json({ error: "APPROVAL_NOT_EDITABLE" });
    }

    const schema = z.object({
      placements: z
        .array(
          z.object({
            role: z.enum(["designer", "supervisor", "process"]),
            pageNumber: z.number().int().min(1),
            xRatio: z.number().min(0).max(1),
            yRatio: z.number().min(0).max(1),
            widthRatio: z.number().min(0.001).max(1),
            heightRatio: z.number().min(0.001).max(1)
          })
        )
        .length(3)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
    if (!hasRequiredSignaturePlacementRoles(parsed.data.placements)) {
      return res.status(400).json({ error: "SIGNATURE_PLACEMENTS_REQUIRED" });
    }

    try {
      const placements = deps.signaturePlacements.upsertMany(approval.id, parsed.data.placements);
      if (!deps.signaturePlacements.hasRequiredPlacements(approval.id)) {
        return res.status(400).json({ error: "REQUIRED_SIGNATURE_PLACEMENTS_MISSING" });
      }
      const next = approval.signatureStatus === "generated" ? approval : deps.approvals.setSignatureStatus(approval.id, "pending");
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "signature.placements_saved",
        targetType: "approval",
        targetId: approval.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "用户"}保存了签名框位置`,
        metadata: { roles: placements.map((placement) => placement.role) }
      });

      if (next.status === "approved_for_print" && deps.signatureAssets && deps.signaturePlacements && deps.users) {
        const signed = await tryGenerateSignedPdfForApproval(next.id, {
          approvals: deps.approvals,
          settings: deps.settings,
          operationLogs: deps.operationLogs,
          signatureAssets: deps.signatureAssets,
          signaturePlacements: deps.signaturePlacements,
          users: deps.users,
          notifySignatureFailed: (approvalId) =>
            deps.notifyApprovalEvent?.("signatureFailed", approvalId, { actorUserId: null, actorUsername: "system" }) ?? Promise.resolve()
        });
        return res.json({ approval: signed ?? next, placements });
      }

      res.json({ approval: next, placements });
    } catch (error) {
      const message = error instanceof Error ? error.message : "SIGNATURE_PLACEMENTS_SAVE_FAILED";
      if (message === "INVALID_SIGNATURE_ROLE" || message === "INVALID_SIGNATURE_PLACEMENT") {
        return res.status(400).json({ error: message });
      }
      res.status(500).json({ error: "SIGNATURE_PLACEMENTS_SAVE_FAILED" });
    }
  });

  router.post("/:id/review", requireAuth(deps.jwtSecret, ["supervisor", "process", "admin"]), async (req, res) => {
    const schema = z.object({
      role: z.enum(["supervisor", "process"]),
      decision: z.enum(["approved", "rejected"]),
      comment: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
    if (req.user?.role !== "admin" && req.user?.role !== parsed.data.role) return res.status(403).json({ error: "FORBIDDEN" });

    try {
      const approvalId = Number(req.params.id);
      const allowEmptyRejectComment =
        parsed.data.decision === "rejected" &&
        !parsed.data.comment?.trim() &&
        Boolean(deps.approvalAnnotations && deps.approvalAnnotations.countOpenForApproval(approvalId) > 0);
      const reviewed = deps.approvals.review(approvalId, { ...parsed.data, allowEmptyRejectComment });
      const watchRoot = deps.settings.get("watch_root");
      const moved = watchRoot ? await moveApprovalFile(reviewed, watchRoot, deps.approvals) : reviewed;
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "approval.reviewed",
        targetType: "approval",
        targetId: moved.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "用户"}${parsed.data.decision === "approved" ? "通过" : "驳回"}了图纸`,
        metadata: { role: parsed.data.role, decision: parsed.data.decision, status: moved.status }
      });
      const actor = { actorUserId: req.user?.id ?? null, actorUsername: req.user?.username ?? null };
      if (moved.status === "pending") {
        await deps.notifyApprovalEvent?.("peerReviewCompleted", moved.id, actor).catch(() => undefined);
      }
      if (moved.status === "rejected") {
        await deps.notifyApprovalEvent?.("approvalRejected", moved.id, actor).catch(() => undefined);
      }
      if (moved.status === "approved_for_print") {
        deps.operationLogs?.create({
          actorUserId: req.user?.id ?? null,
          actorUsername: req.user?.username ?? null,
          action: "approval.approved_for_print",
          targetType: "approval",
          targetId: moved.id,
          message: "图纸已通过主管和工艺审核，进入待打印",
          metadata: { currentFilePath: moved.currentFilePath }
        });
        await deps.notifyApprovalEvent?.("approvalApprovedForPrint", moved.id, actor).catch(() => undefined);
        if (deps.signatureAssets && deps.signaturePlacements && deps.users) {
          const signed = await tryGenerateSignedPdfForApproval(moved.id, {
            approvals: deps.approvals,
            settings: deps.settings,
            operationLogs: deps.operationLogs,
            signatureAssets: deps.signatureAssets,
            signaturePlacements: deps.signaturePlacements,
            users: deps.users,
            notifySignatureFailed: (approvalId) =>
              deps.notifyApprovalEvent?.("signatureFailed", approvalId, { actorUserId: null, actorUsername: "system" }) ?? Promise.resolve()
          });
          return res.json(signed ?? moved);
        }
      }
      res.json(moved);
    } catch (error) {
      const message = error instanceof Error ? error.message : "REVIEW_FAILED";
      if (message === "APPROVAL_NOT_FOUND") return res.status(404).json({ error: message });
      if (message === "REJECT_COMMENT_REQUIRED" || message === "APPROVAL_NOT_REVIEWABLE") {
        return res.status(400).json({ error: message });
      }
      res.status(500).json({ error: "REVIEW_FAILED" });
    }
  });

  router.post("/:id/mark-printed", requireAuth(deps.jwtSecret, ["designer", "admin"]), async (req, res) => {
    try {
      const approval = deps.approvals.markPrinted(Number(req.params.id));
      const watchRoot = deps.settings.get("watch_root");
      const moved = watchRoot ? await moveApprovalFile(approval, watchRoot, deps.approvals) : approval;
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "approval.printed",
        targetType: "approval",
        targetId: moved.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "用户"}标记图纸已打印归档`,
        metadata: { currentFilePath: moved.currentFilePath }
      });
      await deps.notifyApprovalEvent?.("approvalPrinted", moved.id, {
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null
      }).catch(() => undefined);
      res.json(moved);
    } catch (error) {
      const message = error instanceof Error ? error.message : "MARK_PRINTED_FAILED";
      if (message === "APPROVAL_NOT_FOUND") return res.status(404).json({ error: message });
      if (message === "APPROVAL_NOT_PRINTABLE" || message === "SIGNED_PDF_REQUIRED") {
        return res.status(400).json({ error: message });
      }
      res.status(500).json({ error: "MARK_PRINTED_FAILED" });
    }
  });

  router.post("/:id/void", requireAuth(deps.jwtSecret, ["admin"]), (req, res) => {
    const parsed = z.object({ reason: z.string().trim().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      const approval = deps.approvals.voidApproval(Number(req.params.id));
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "approval.voided",
        targetType: "approval",
        targetId: approval.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "管理员"}作废了图纸`,
        metadata: { reason: parsed.data.reason }
      });
      res.json(approval);
    } catch (error) {
      const message = error instanceof Error ? error.message : "VOID_APPROVAL_FAILED";
      if (message === "APPROVAL_NOT_FOUND") return res.status(404).json({ error: message });
      res.status(500).json({ error: "VOID_APPROVAL_FAILED" });
    }
  });

  router.delete("/:id", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    try {
      const approval = deps.approvals.getById(Number(req.params.id));
      if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });

      const watchRoot = deps.settings.get("watch_root");
      const deletedFiles = await deleteManagedApprovalFiles(approval, watchRoot);
      deps.approvals.delete(approval.id);
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "approval.deleted",
        targetType: "approval",
        targetId: approval.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "管理员"}删除了图纸`,
        metadata: {
          projectName: approval.projectName,
          partName: approval.partName,
          version: approval.version,
          deletedFiles
        }
      });
      res.json({ deleted: true, approvalId: approval.id, deletedFiles });
    } catch (error) {
      const message = error instanceof Error ? error.message : "DELETE_APPROVAL_FAILED";
      if (message === "APPROVAL_NOT_FOUND") return res.status(404).json({ error: message });
      res.status(500).json({ error: "DELETE_APPROVAL_FAILED" });
    }
  });

  router.post("/:id/rebind-file", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    const parsed = z.object({ filePath: z.string().trim().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    if (!isRebindRepairable(approval.status)) {
      return res.status(400).json({ error: "APPROVAL_NOT_REPAIRABLE" });
    }

    const filePath = path.resolve(parsed.data.filePath);
    const watchRoot = deps.settings.get("watch_root");
    if (watchRoot && !isPathInsideRoot(watchRoot, filePath)) {
      return res.status(400).json({ error: "FILE_OUTSIDE_WATCH_ROOT" });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(400).json({ error: "FILE_NOT_FOUND" });
    }

    if (!(await hasPdfHeader(filePath))) {
      const invalid = deps.approvals.markInvalidPdf(approval.id);
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "approval.validation_failed",
        targetType: "approval",
        targetId: invalid.id,
        message: "重新绑定文件失败：PDF 内容无效",
        metadata: { filePath }
      });
      return res.status(422).json({ error: "INVALID_PDF_FILE" });
    }

    const rebound = deps.approvals.rebindFile(approval.id, filePath);
    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: "approval.file_rebound",
      targetType: "approval",
      targetId: rebound.id,
      message: `${req.user?.displayName ?? req.user?.username ?? "管理员"}重新绑定了图纸文件`,
      metadata: { filePath }
    });
    res.json(rebound);
  });

  router.post("/:id/retry-validation", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    if (approval.status !== "invalid_pdf") {
      return res.status(400).json({ error: "APPROVAL_NOT_VALIDATION_RETRYABLE" });
    }
    if (!fs.existsSync(approval.currentFilePath)) return res.status(400).json({ error: "FILE_NOT_FOUND" });

    if (!(await hasPdfHeader(approval.currentFilePath))) {
      const invalid = deps.approvals.markInvalidPdf(approval.id);
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "approval.validation_failed",
        targetType: "approval",
        targetId: invalid.id,
        message: "重新校验失败：PDF 内容无效",
        metadata: { filePath: approval.currentFilePath }
      });
      return res.status(422).json({ error: "INVALID_PDF_FILE" });
    }

    const validated = deps.approvals.rebindFile(approval.id, approval.currentFilePath);
    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: "approval.validation_retried",
      targetType: "approval",
      targetId: validated.id,
      message: `${req.user?.displayName ?? req.user?.username ?? "管理员"}重新校验了 PDF 文件`,
      metadata: { filePath: validated.currentFilePath, status: validated.status }
    });
    res.json(validated);
  });

  router.post("/:id/generate-signed-pdf", requireAuth(deps.jwtSecret, ["admin", "designer"]), async (req, res) => {
    if (!deps.signatureAssets || !deps.signaturePlacements || !deps.users) {
      return res.status(500).json({ error: "SIGNING_UNAVAILABLE" });
    }

    const approval = deps.approvals.getById(Number(req.params.id));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    if (approval.status !== "approved_for_print") return res.status(400).json({ error: "APPROVAL_NOT_SIGNABLE" });
    if (approval.signatureStatus === "not_required") return res.status(400).json({ error: "SIGNATURE_NOT_REQUIRED" });

    const signed = await tryGenerateSignedPdfForApproval(approval.id, {
      approvals: deps.approvals,
      settings: deps.settings,
      operationLogs: deps.operationLogs,
      signatureAssets: deps.signatureAssets,
      signaturePlacements: deps.signaturePlacements,
      users: deps.users,
      notifySignatureFailed: (approvalId) =>
        deps.notifyApprovalEvent?.("signatureFailed", approvalId, { actorUserId: null, actorUsername: "system" }) ?? Promise.resolve()
    });

    res.json(signed);
  });

  return router;
}

function isPathInsideRoot(root: string, filePath: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function deleteManagedApprovalFiles(approval: {
  projectName: string;
  partName: string;
  version: string;
  originalFilePath: string;
  currentFilePath: string;
  signedFilePath: string | null;
}, watchRoot: string | null) {
  const candidates = [approval.originalFilePath, approval.currentFilePath, approval.signedFilePath].filter(Boolean) as string[];
  if (watchRoot) {
    candidates.push(...(await findSignedDerivativeFiles(approval, watchRoot)));
  }
  const uniquePaths = [...new Set(candidates.map((filePath) => path.resolve(filePath)))];
  const deletedFiles: string[] = [];

  for (const filePath of uniquePaths) {
    if (watchRoot && !isPathInsideRoot(watchRoot, filePath)) continue;
    if (!fs.existsSync(filePath)) continue;
    await fs.promises.rm(filePath, { force: true });
    deletedFiles.push(filePath);
  }

  if (watchRoot) {
    await removeEmptyManagedProjectFolders(uniquePaths, watchRoot);
  }

  return deletedFiles;
}

async function removeEmptyManagedProjectFolders(filePaths: string[], watchRoot: string) {
  const candidateDirs = [...new Set(filePaths.map((filePath) => path.dirname(filePath)))].sort((a, b) => b.length - a.length);

  for (const dir of candidateDirs) {
    if (!isManagedProjectDirectory(watchRoot, dir)) continue;

    try {
      const entries = await fs.promises.readdir(dir);
      if (entries.length > 0) continue;
      await fs.promises.rmdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") continue;
      throw error;
    }
  }
}

function isManagedProjectDirectory(watchRoot: string, dir: string) {
  const relative = path.relative(path.resolve(watchRoot), path.resolve(dir));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep).filter(Boolean);
  return segments.length === 2 && managedStatusFolders.has(segments[0]);
}

async function findSignedDerivativeFiles(
  approval: {
    projectName: string;
    partName: string;
    version: string;
    currentFilePath: string;
    signedFilePath: string | null;
  },
  watchRoot: string
) {
  const baseNames = new Set<string>([`${approval.partName}-${approval.version}`, signedSourceBaseName(approval.currentFilePath)]);
  if (approval.signedFilePath) {
    baseNames.add(signedSourceBaseName(approval.signedFilePath));
  }

  const candidateDirs = new Set<string>([
    targetPath(watchRoot, folders.approvedForPrint, approval.projectName, ""),
    targetPath(watchRoot, folders.printedArchive, approval.projectName, "")
  ]);
  if (approval.signedFilePath) candidateDirs.add(path.dirname(approval.signedFilePath));

  const result: string[] = [];
  for (const dir of candidateDirs) {
    if (!isPathInsideRoot(watchRoot, dir) || !fs.existsSync(dir)) continue;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".pdf") continue;
      if (matchesSignedDerivative(entry.name, baseNames)) {
        result.push(path.join(dir, entry.name));
      }
    }
  }
  return result;
}

function signedSourceBaseName(filePath: string) {
  const name = path.basename(filePath, path.extname(filePath));
  return name.replace(/-签审(?:-\d+)?$/u, "");
}

function matchesSignedDerivative(fileName: string, baseNames: Set<string>) {
  const name = path.basename(fileName, path.extname(fileName));
  for (const baseName of baseNames) {
    if (name === `${baseName}-签审`) return true;
    if (name.startsWith(`${baseName}-签审-`) && /^\d+$/.test(name.slice(`${baseName}-签审-`.length))) return true;
  }
  return false;
}

function isRebindRepairable(status: string) {
  return status === "file_missing" || status === "invalid_pdf";
}

function hasRequiredSignaturePlacementRoles(placements: Array<{ role: string }>) {
  const roles = new Set(placements.map((placement) => placement.role));
  return roles.size === 3 && roles.has("designer") && roles.has("supervisor") && roles.has("process");
}

const approvalIdsSchema = z.object({
  approvalIds: z.array(z.number().int().positive()).min(1)
});

type BatchApprovalActionItem = {
  approvalId: number;
  status: "completed" | "failed";
  error?: string;
  approval?: unknown;
};

function batchCompletedItem(approvalId: number, approval: unknown): BatchApprovalActionItem {
  return { approvalId, status: "completed", approval };
}

function batchFailedItem(approvalId: number, error: string, approval?: unknown): BatchApprovalActionItem {
  return { approvalId, status: "failed", error, ...(approval ? { approval } : {}) };
}

function clampPageSize(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

function batchSummary(items: BatchApprovalActionItem[]) {
  const success = items.filter((item) => item.status === "completed").length;
  return {
    total: items.length,
    success,
    failed: items.length - success
  };
}

function batchSummaryResponse(items: BatchApprovalActionItem[]) {
  return {
    ...batchSummary(items),
    items
  };
}
