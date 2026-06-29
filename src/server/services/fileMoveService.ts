import fs from "node:fs/promises";
import path from "node:path";
import type { Approval } from "../domain/approvals.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import { folders, targetPath } from "../files/fileLocations.ts";

export async function moveApprovalFile(
  approval: Approval,
  watchRoot: string,
  approvals: ApprovalRepository
): Promise<Approval> {
  const folder =
    approval.status === "approved_for_print"
      ? folders.approvedForPrint
      : approval.status === "rejected"
        ? folders.rejected
        : approval.status === "printed_archived"
          ? folders.printedArchive
          : null;

  if (!folder) return approval;

  let next = approval;
  const desiredPath = targetPath(watchRoot, folder, approval.projectName, path.basename(approval.currentFilePath));
  if (desiredPath !== approval.currentFilePath) {
    const nextPath = await nextAvailablePath(desiredPath);
    await fs.mkdir(path.dirname(nextPath), { recursive: true });
    await fs.rename(approval.currentFilePath, nextPath);
    next = approvals.updateFilePath(approval.id, nextPath);
  }

  if (next.status === "printed_archived" && next.signedFilePath) {
    const signedDesiredPath = targetPath(watchRoot, folders.printedArchive, next.projectName, path.basename(next.signedFilePath));
    if (signedDesiredPath !== next.signedFilePath) {
      const signedNextPath = await nextAvailablePath(signedDesiredPath);
      await fs.mkdir(path.dirname(signedNextPath), { recursive: true });
      await fs.rename(next.signedFilePath, signedNextPath);
      next = approvals.updateSignedFilePath(next.id, signedNextPath);
    }
  }

  return next;
}

async function nextAvailablePath(filePath: string) {
  if (!(await exists(filePath))) return filePath;

  const parsed = path.parse(filePath);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!(await exists(candidate))) return candidate;
  }

  throw new Error("TARGET_FILE_NAME_CONFLICT");
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
