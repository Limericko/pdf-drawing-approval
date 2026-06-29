import fs from "node:fs/promises";
import path from "node:path";
import express, { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { BatchSubmissionPlacementState, BatchSubmissionRepository } from "../repositories/batchSubmissions.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import type { SignaturePlacementRepository } from "../repositories/signaturePlacements.ts";
import { folders, targetPath } from "../files/fileLocations.ts";
import { sha256File } from "../files/fileHash.ts";
import { parseDrawingFileName } from "../files/parseDrawingFileName.ts";
import { deleteTempUpload, getTempUpload, saveTempUpload } from "../uploads/tempUploads.ts";

export function submissionRoutes(deps: {
  approvals: ApprovalRepository;
  batchSubmissions?: BatchSubmissionRepository;
  operationLogs?: OperationLogRepository;
  settings: SettingsRepository;
  signaturePlacements: SignaturePlacementRepository;
  notifyApprovalCreated?: (approvalId: number, actor: Express.Request["user"]) => Promise<unknown>;
  dataDir: string;
  jwtSecret: string;
}) {
  const router = Router();
  const placementSchema = z.object({
    role: z.enum(["designer", "supervisor", "process"]),
    pageNumber: z.number().int().min(1),
    xRatio: z.number(),
    yRatio: z.number(),
    widthRatio: z.number(),
    heightRatio: z.number()
  });

  const submissionSchema = z.object({
    uploadId: z.string().trim().min(1),
    projectName: z.string().trim().min(1),
    partName: z.string().trim().min(1),
    version: z.string().trim().min(1),
    placements: z.array(placementSchema).min(1)
  });

  router.post("/batch-upload", requireAuth(deps.jwtSecret, ["designer"]), async (req, res) => {
    const parsed = z
      .object({
        projectName: z.string().trim().optional(),
        files: z
          .array(
            z.object({
              fileName: z.string().trim().min(1),
              contentBase64: z.string().min(1)
            })
          )
          .min(1)
      })
      .safeParse(req.body);

    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    const items = [];
    for (const file of parsed.data.files) {
      if (!file.fileName.toLowerCase().endsWith(".pdf")) {
        items.push({ fileName: file.fileName, status: "failed", error: "PDF_FILENAME_REQUIRED" });
        continue;
      }

      const buffer = Buffer.from(file.contentBase64, "base64");
      if (buffer.length === 0) {
        items.push({ fileName: file.fileName, status: "failed", error: "EMPTY_UPLOAD" });
        continue;
      }
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        items.push({ fileName: file.fileName, status: "failed", error: "INVALID_PDF_FILE" });
        continue;
      }

      const upload = await saveTempUpload({
        rootDir: deps.dataDir,
        originalName: file.fileName,
        buffer
      });
      const parsedFileName = parseDrawingFileName(file.fileName);
      items.push({
        fileName: upload.originalName,
        uploadId: upload.uploadId,
        status: "uploaded",
        parsed: parsedFileName,
        existingVersions: existingVersionsForParsed(deps.approvals, parsed.data.projectName, parsedFileName)
      });
    }

    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: "submission.batch_uploaded",
      targetType: "submission",
      targetId: null,
      message: `${req.user?.displayName ?? req.user?.username ?? "设计师"}批量上传了 PDF`,
      metadata: { total: items.length, uploaded: items.filter((item) => item.status === "uploaded").length }
    });

    res.json({ items });
  });

  router.get("/existing-versions", requireAuth(deps.jwtSecret, ["designer"]), (req, res) => {
    const projectName = typeof req.query.projectName === "string" ? req.query.projectName.trim() : "";
    const partName = typeof req.query.partName === "string" ? req.query.partName.trim() : "";
    if (!projectName || !partName) return res.status(400).json({ error: "INVALID_INPUT" });

    res.json(deps.approvals.listVersions(projectName, partName));
  });

  router.post(
    "/upload",
    requireAuth(deps.jwtSecret, ["designer"]),
    express.raw({ type: "application/pdf", limit: "100mb" }),
    async (req, res) => {
      const fileName = typeof req.query.fileName === "string" ? req.query.fileName : "";
      if (!fileName.toLowerCase().endsWith(".pdf")) {
        return res.status(400).json({ error: "PDF_FILENAME_REQUIRED" });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "EMPTY_UPLOAD" });
      }
      if (!req.body.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        return res.status(422).json({ error: "INVALID_PDF_FILE" });
      }

      const upload = await saveTempUpload({
        rootDir: deps.dataDir,
        originalName: fileName,
        buffer: req.body
      });
      const parsed = parseDrawingFileName(fileName);
      const projectName = typeof req.query.projectName === "string" ? req.query.projectName.trim() : "";

      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "submission.uploaded",
        targetType: "submission",
        targetId: null,
        message: `${req.user?.displayName ?? req.user?.username ?? "设计师"}上传了待提交 PDF`,
        metadata: { uploadId: upload.uploadId, originalName: upload.originalName }
      });

      res.json({
        uploadId: upload.uploadId,
        originalName: upload.originalName,
        parsed,
        existingVersions: existingVersionsForParsed(deps.approvals, projectName, parsed)
      });
    }
  );

  router.post("/", requireAuth(deps.jwtSecret, ["designer"]), async (req, res) => {
    const parsed = submissionSchema.safeParse(req.body);

    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      const approval = await createApprovalFromUpload(deps, parsed.data, req.user);
      await deps.notifyApprovalCreated?.(approval.id, req.user).catch(() => undefined);
      res.json(deps.approvals.getById(approval.id));
    } catch (error) {
      const message = errorMessage(error);
      if (message === "UPLOAD_NOT_FOUND") return res.status(404).json({ error: message });
      if (message === "DUPLICATE_VERSION") return res.status(409).json({ error: message });
      if (
        message === "SIGNATURE_PLACEMENTS_REQUIRED" ||
        message === "INVALID_SIGNATURE_PLACEMENT" ||
        message === "INVALID_VERSION" ||
        message === "WATCH_ROOT_NOT_CONFIGURED"
      ) {
        return res.status(400).json({ error: message });
      }
      res.status(500).json({ error: "SUBMISSION_FAILED" });
    }
  });

  router.post("/batch", requireAuth(deps.jwtSecret, ["designer"]), async (req, res) => {
    if (!deps.batchSubmissions) return res.status(500).json({ error: "BATCH_SUBMISSIONS_UNAVAILABLE" });
    const parsed = z
      .object({
        projectName: z.string().trim().min(1),
        items: z
          .array(
            z.object({
              uploadId: z.string().trim().min(1).optional(),
              fileName: z.string().trim().min(1),
              partName: z.string().trim().min(1),
              version: z.string().trim().min(1),
              placements: z.array(placementSchema).optional().default([]),
              placementState: z.enum(["template", "manual", "missing"]).optional().default("manual")
            })
          )
          .min(1)
      })
      .safeParse(req.body);

    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    const batch = deps.batchSubmissions.start({
      projectName: parsed.data.projectName,
      totalCount: parsed.data.items.length,
      createdByUserId: req.user?.id ?? null
    });

    for (const item of parsed.data.items) {
      try {
        const approval = await createApprovalFromUpload(
          deps,
          {
            uploadId: item.uploadId ?? "",
            projectName: parsed.data.projectName,
            partName: item.partName,
            version: item.version,
            placements: item.placements
          },
          req.user
        );
        await deps.notifyApprovalCreated?.(approval.id, req.user).catch(() => undefined);
        deps.batchSubmissions.addItem({
          batchId: batch.id,
          fileName: item.fileName,
          approvalId: approval.id,
          status: "completed",
          placementState: item.placementState
        });
      } catch (error) {
        deps.batchSubmissions.addItem({
          batchId: batch.id,
          fileName: item.fileName,
          status: "failed",
          errorMessage: errorMessage(error),
          placementState: item.placementState as BatchSubmissionPlacementState
        });
      }
    }

    const completed = deps.batchSubmissions.complete(batch.id);
    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: "submission.batch_completed",
      targetType: "batch_submission",
      targetId: completed.id,
      message: `${req.user?.displayName ?? req.user?.username ?? "设计师"}完成了批量提交`,
      metadata: { status: completed.status, total: completed.totalCount, success: completed.successCount, failed: completed.failedCount }
    });
    res.json(completed);
  });

  router.get("/batches", requireAuth(deps.jwtSecret, ["designer", "admin"]), (_req, res) => {
    if (!deps.batchSubmissions) return res.status(500).json({ error: "BATCH_SUBMISSIONS_UNAVAILABLE" });
    res.json(deps.batchSubmissions.listRecent());
  });

  router.get("/batches/:id", requireAuth(deps.jwtSecret, ["designer", "admin"]), (req, res) => {
    if (!deps.batchSubmissions) return res.status(500).json({ error: "BATCH_SUBMISSIONS_UNAVAILABLE" });
    const batch = deps.batchSubmissions.getWithItems(Number(req.params.id));
    if (!batch) return res.status(404).json({ error: "BATCH_SUBMISSION_NOT_FOUND" });
    res.json(batch);
  });

  return router;
}

async function createApprovalFromUpload(
  deps: {
    approvals: ApprovalRepository;
    operationLogs?: OperationLogRepository;
    settings: SettingsRepository;
    signaturePlacements: SignaturePlacementRepository;
    dataDir: string;
  },
  input: {
    uploadId: string;
    projectName: string;
    partName: string;
    version: string;
    placements: Array<{
      role: "designer" | "supervisor" | "process";
      pageNumber: number;
      xRatio: number;
      yRatio: number;
      widthRatio: number;
      heightRatio: number;
    }>;
  },
  user: Express.Request["user"]
) {
  if (!input.uploadId.trim()) throw new Error("UPLOAD_NOT_FOUND");
  if (!hasRequiredSignaturePlacementRoles(input.placements)) {
    throw new Error("SIGNATURE_PLACEMENTS_REQUIRED");
  }
  if (hasInvalidSignaturePlacement(input.placements)) {
    throw new Error("INVALID_SIGNATURE_PLACEMENT");
  }

  const version = parseDrawingFileName(`${input.partName}-${input.version}.pdf`);
  if (!version) throw new Error("INVALID_VERSION");

  if (deps.approvals.findVersion(input.projectName, input.partName, input.version)) {
    throw new Error("DUPLICATE_VERSION");
  }

  const watchRoot = deps.settings.get("watch_root");
  if (!watchRoot) throw new Error("WATCH_ROOT_NOT_CONFIGURED");

  let upload;
  try {
    upload = await getTempUpload(deps.dataDir, input.uploadId);
  } catch {
    throw new Error("UPLOAD_NOT_FOUND");
  }

  const projectName = safePathSegment(input.projectName);
  const fileName = `${safeFileNamePart(input.partName)}-${input.version}.pdf`;
  const nextPath = targetPath(watchRoot, folders.reviewing, projectName, fileName);

  await fs.mkdir(path.dirname(nextPath), { recursive: true });
  await fs.copyFile(upload.filePath, nextPath);
  const originalFileHash = await sha256File(nextPath);
  await deleteTempUpload(deps.dataDir, upload.uploadId);

  const approval = deps.approvals.create({
    projectName: input.projectName,
    partName: input.partName,
    version: input.version,
    minorVersion: version.minorVersion,
    majorVersion: version.majorVersion,
    originalFilePath: nextPath,
    currentFilePath: nextPath,
    submittedBy: user?.username ?? null,
    submittedByUserId: user?.id ?? null,
    source: "web_upload",
    originalFileHash,
    signatureStatus: "pending"
  });
  deps.signaturePlacements.upsertMany(approval.id, input.placements);

  deps.operationLogs?.create({
    actorUserId: user?.id ?? null,
    actorUsername: user?.username ?? null,
    action: "approval.created",
    targetType: "approval",
    targetId: approval.id,
    message: `${user?.displayName ?? user?.username ?? "设计师"}从网页提交了图纸`,
    metadata: { currentFilePath: nextPath, source: "web_upload" }
  });
  deps.operationLogs?.create({
    actorUserId: user?.id ?? null,
    actorUsername: user?.username ?? null,
    action: "signature.placements_saved",
    targetType: "approval",
    targetId: approval.id,
    message: "设计师提交时保存了设计、主管、工艺签名框位置",
    metadata: { roles: input.placements.map((placement) => placement.role) }
  });

  return approval;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "UNKNOWN_ERROR";
}

function existingVersionsForParsed(
  approvals: ApprovalRepository,
  projectName: string | undefined,
  parsed: ReturnType<typeof parseDrawingFileName>
) {
  if (!projectName?.trim() || !parsed) return [];
  return approvals.listVersions(projectName.trim(), parsed.partName);
}

function safePathSegment(value: string) {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function safeFileNamePart(value: string) {
  return safePathSegment(value).replace(/\.+$/g, "");
}

function hasRequiredSignaturePlacementRoles(placements: Array<{ role: string }>) {
  const roles = new Set(placements.map((placement) => placement.role));
  return placements.length === 3 && roles.size === 3 && roles.has("designer") && roles.has("supervisor") && roles.has("process");
}

function hasInvalidSignaturePlacement(
  placements: Array<{
    pageNumber: number;
    xRatio: number;
    yRatio: number;
    widthRatio: number;
    heightRatio: number;
  }>
) {
  return placements.some(
    (placement) =>
      !Number.isInteger(placement.pageNumber) ||
      placement.pageNumber < 1 ||
      placement.xRatio < 0 ||
      placement.xRatio > 1 ||
      placement.yRatio < 0 ||
      placement.yRatio > 1 ||
      placement.widthRatio <= 0 ||
      placement.widthRatio > 1 ||
      placement.heightRatio <= 0 ||
      placement.heightRatio > 1 ||
      placement.xRatio + placement.widthRatio > 1 ||
      placement.yRatio + placement.heightRatio > 1
  );
}
