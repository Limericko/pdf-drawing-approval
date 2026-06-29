import fs from "node:fs/promises";
import path from "node:path";
import type { Approval } from "../domain/approvals.ts";
import { folders, targetPath } from "../files/fileLocations.ts";
import { sha256File } from "../files/fileHash.ts";
import { generateSignedPdf } from "../pdf/signPdf.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import type { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import type { SignaturePlacementRepository, SignaturePlacementRole } from "../repositories/signaturePlacements.ts";
import type { UserRepository } from "../repositories/users.ts";

export type SigningWorkflowDeps = {
  approvals: ApprovalRepository;
  operationLogs?: OperationLogRepository;
  settings: SettingsRepository;
  signatureAssets: SignatureAssetRepository;
  signaturePlacements: SignaturePlacementRepository;
  users: UserRepository;
  notifySignatureFailed?: (approvalId: number, error: string) => Promise<unknown>;
};

export async function tryGenerateSignedPdfForApproval(
  approvalId: number,
  deps: SigningWorkflowDeps
): Promise<Approval | null> {
  const approval = deps.approvals.getById(approvalId);
  if (!approval) return null;
  if (approval.status !== "approved_for_print") return approval;
  if (approval.signatureStatus === "not_required") return approval;

  try {
    const watchRoot = deps.settings.get("watch_root");
    if (!watchRoot) throw new Error("WATCH_ROOT_NOT_CONFIGURED");

    const placements = deps.signaturePlacements.listForApproval(approval.id);
    if (!deps.signaturePlacements.hasRequiredPlacements(approval.id)) {
      throw new Error("SIGNATURE_PLACEMENTS_REQUIRED");
    }

    const userIdsByRole = resolveSignatureUserIds(approval, deps);
    const imagePathsByRole = new Map<SignaturePlacementRole, string>();
    for (const role of ["designer", "supervisor", "process"] as SignaturePlacementRole[]) {
      const userId = userIdsByRole.get(role);
      if (!userId) throw new Error(`MISSING_${role.toUpperCase()}_USER`);
      const asset = deps.signatureAssets.getActiveForUser(userId);
      if (!asset) throw new Error(`MISSING_${role.toUpperCase()}_SIGNATURE`);
      imagePathsByRole.set(role, asset.filePath);
    }

    const outputPdfPath = await nextSignedPdfPath(watchRoot, approval);
    await generateSignedPdf({
      sourcePdfPath: approval.currentFilePath,
      outputPdfPath,
      stamps: placements.map((placement) => ({
        imagePath: imagePathsByRole.get(placement.role)!,
        pageNumber: placement.pageNumber,
        xRatio: placement.xRatio,
        yRatio: placement.yRatio,
        widthRatio: placement.widthRatio,
        heightRatio: placement.heightRatio
      }))
    });
    const signedHash = await sha256File(outputPdfPath);
    const signed = deps.approvals.setSignedFile(approval.id, outputPdfPath, signedHash);
    deps.operationLogs?.create({
      actorUsername: "system",
      action: "signature.generated",
      targetType: "approval",
      targetId: approval.id,
      message: "系统已生成签后 PDF",
      metadata: { signedFilePath: outputPdfPath, signedFileHash: signedHash }
    });
    return signed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "SIGNING_FAILED";
    const failed = deps.approvals.setSignatureStatus(approval.id, "failed", message);
    deps.operationLogs?.create({
      actorUsername: "system",
      action: "signature.failed",
      targetType: "approval",
      targetId: approval.id,
      message: "系统生成签后 PDF 失败",
      metadata: { error: message }
    });
    await deps.notifySignatureFailed?.(approval.id, message).catch(() => undefined);
    return failed;
  }
}

function resolveSignatureUserIds(approval: Approval, deps: SigningWorkflowDeps) {
  const userIds = new Map<SignaturePlacementRole, number | null>();
  userIds.set("designer", approval.submittedByUserId ?? deps.users.findByRole("designer")[0]?.id ?? null);
  userIds.set("supervisor", deps.users.findByRole("supervisor")[0]?.id ?? null);
  userIds.set("process", deps.users.findByRole("process")[0]?.id ?? null);
  return userIds;
}

async function nextSignedPdfPath(watchRoot: string, approval: Approval) {
  const baseName = path.basename(approval.currentFilePath, path.extname(approval.currentFilePath));
  const folder = targetPath(watchRoot, folders.approvedForPrint, approval.projectName, "");
  const first = path.join(folder, `${baseName}-签审.pdf`);
  if (!(await exists(first))) return first;

  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(folder, `${baseName}-签审-${index}.pdf`);
    if (!(await exists(candidate))) return candidate;
  }

  throw new Error("SIGNED_PDF_NAME_CONFLICT");
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
