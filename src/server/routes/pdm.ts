import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { OperationLog, OperationLogRepository } from "../repositories/operationLogs.ts";
import type { PdmDrawingRevision, PdmPartRepository } from "../repositories/pdmParts.ts";
import type { PdmBackfillService } from "../services/pdmBackfillService.ts";
import type { PdmReleaseService } from "../services/pdmReleaseService.ts";

export function pdmRoutes(deps: {
  approvals: ApprovalRepository;
  operationLogs?: OperationLogRepository;
  pdmParts: PdmPartRepository;
  pdmBackfillService: PdmBackfillService;
  pdmReleaseService: PdmReleaseService;
  jwtSecret: string;
}) {
  const router = Router();

  router.get("/parts", requireAuth(deps.jwtSecret), (req, res) => {
    const result = deps.pdmParts.listParts({
      keyword: stringQuery(req.query.keyword),
      projectName: stringQuery(req.query.projectName),
      isCommon: booleanQuery(req.query.isCommon),
      hasCurrentRevision: booleanQuery(req.query.hasCurrentRevision),
      page: numberQuery(req.query.page),
      pageSize: numberQuery(req.query.pageSize)
    });
    res.json(result);
  });

  router.get("/parts/:id", requireAuth(deps.jwtSecret), (req, res) => {
    const partId = Number(req.params.id);
    const part = deps.pdmParts.getPartById(partId);
    if (!part) return res.status(404).json({ error: "PDM_PART_NOT_FOUND" });

    const revisions = deps.pdmParts.listRevisions(part.id);
    const currentRevision = part.currentRevisionId ? deps.pdmParts.getRevisionById(part.currentRevisionId) : null;
    const usages = deps.pdmParts.listUsages(part.id);
    const traceLogs = deps.operationLogs ? listPdmPartTraceLogs(revisions, deps.operationLogs) : [];
    res.json({ part, currentRevision, revisions, usages, traceLogs });
  });

  router.post("/revisions/:id/void", requireAuth(deps.jwtSecret, ["admin"]), (req, res) => {
    const revisionId = Number(req.params.id);
    const parsed = revisionVoidSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      const result = deps.pdmParts.voidRevision(revisionId);
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "pdm.revision_voided",
        targetType: "pdm_revision",
        targetId: revisionId,
        message: "管理员作废了 PDM 图纸版本",
        metadata: {
          reason: parsed.data.reason,
          materialCode: result.voided.materialCode,
          version: result.voided.version,
          currentRevisionId: result.currentRevision?.id ?? null
        }
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "PDM_REVISION_VOID_FAILED";
      if (message === "PDM_REVISION_NOT_FOUND") return res.status(404).json({ error: message });
      res.status(500).json({ error: "PDM_REVISION_VOID_FAILED" });
    }
  });

  router.get("/pending-metadata", requireAuth(deps.jwtSecret, ["admin", "designer"]), (req, res) => {
    const submittedByUserId = req.user?.role === "designer" ? req.user.id : undefined;
    res.json({ items: deps.pdmParts.listPendingMetadata({ submittedByUserId }) });
  });

  router.post("/approvals/:approvalId/repair-metadata", requireAuth(deps.jwtSecret, ["admin", "designer"]), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.approvalId));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    if (!canMaintainApproval(req.user, approval)) return res.status(403).json({ error: "FORBIDDEN" });

    const parsed = metadataRepairSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      const result = deps.pdmReleaseService.repairApprovalMetadata(
        approval.id,
        {
          documentCode: parsed.data.documentCode ?? null,
          materialCode: parsed.data.materialCode ?? null,
          drawingName: parsed.data.drawingName
        },
        {
          actorUserId: req.user?.id ?? null,
          actorUsername: req.user?.username ?? null
        }
      );
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "PDM_METADATA_REPAIR_FAILED";
      if (message === "APPROVAL_NOT_FOUND") return res.status(404).json({ error: message });
      res.status(500).json({ error: "PDM_METADATA_REPAIR_FAILED" });
    }
  });

  router.post("/approvals/:approvalId/publish", requireAuth(deps.jwtSecret, ["admin", "designer"]), (req, res) => {
    const approval = deps.approvals.getById(Number(req.params.approvalId));
    if (!approval) return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    if (!canMaintainApproval(req.user, approval)) return res.status(403).json({ error: "FORBIDDEN" });

    const result = deps.pdmReleaseService.publishApproval(approval.id);
    if (result.status === "not_found") return res.status(404).json({ error: "APPROVAL_NOT_FOUND" });
    if (result.status === "skipped") return res.status(400).json(result);
    res.json(result);
  });

  router.post("/backfill-approved", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    const result = await deps.pdmBackfillService.backfillApprovedDrawings();
    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: "pdm.backfill_requested",
      targetType: "pdm",
      targetId: null,
      message: "管理员触发了 PDM 历史审批回填",
      metadata: {
        scanned: result.scanned,
        published: result.published,
        skipped: result.skipped,
        failed: result.failed
      }
    });
    res.json(result);
  });

  return router;
}

const metadataRepairSchema = z.object({
  documentCode: z.string().trim().nullable().optional(),
  materialCode: z.string().trim().nullable().optional(),
  drawingName: z.string().trim().min(1)
});

const revisionVoidSchema = z.object({
  reason: z.string().trim().min(1)
});

function canMaintainApproval(
  user: Express.Request["user"],
  approval: {
    submittedByUserId: number | null;
  }
) {
  if (user?.role === "admin") return true;
  return user?.role === "designer" && approval.submittedByUserId !== null && approval.submittedByUserId === user.id;
}

function stringQuery(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberQuery(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanQuery(value: unknown) {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function listPdmPartTraceLogs(revisions: PdmDrawingRevision[], operationLogs: OperationLogRepository): OperationLog[] {
  const seen = new Set<number>();
  const logs: OperationLog[] = [];
  for (const revision of revisions) {
    for (const log of operationLogs.listForTarget("approval", revision.approvalId)) {
      if (!seen.has(log.id)) {
        seen.add(log.id);
        logs.push(log);
      }
    }
    for (const log of operationLogs.listForTarget("pdm_revision", revision.id)) {
      if (!seen.has(log.id)) {
        seen.add(log.id);
        logs.push(log);
      }
    }
  }
  return logs.sort((left, right) => right.id - left.id);
}
