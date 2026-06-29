import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { PdmPartRepository } from "../repositories/pdmParts.ts";
import type { PdmReleaseService } from "../services/pdmReleaseService.ts";

export function pdmRoutes(deps: {
  approvals: ApprovalRepository;
  pdmParts: PdmPartRepository;
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
    res.json({ part, currentRevision, revisions, usages });
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

  return router;
}

const metadataRepairSchema = z.object({
  documentCode: z.string().trim().nullable().optional(),
  materialCode: z.string().trim().nullable().optional(),
  drawingName: z.string().trim().min(1)
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
