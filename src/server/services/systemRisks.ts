import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { defaultJwtSecret } from "../config.ts";
import { folders } from "../files/fileLocations.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { BackupRunRepository } from "../repositories/backups.ts";
import type { ScanRunRepository } from "../repositories/scanRuns.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import type { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import type { UserRepository } from "../repositories/users.ts";

export type SystemRisk = {
  key: string;
  level: "ok" | "warning" | "error";
  title: string;
  message: string;
  count?: number;
  href?: string;
};

export async function getSystemRisks(input: {
  approvals: ApprovalRepository;
  backups: BackupRunRepository;
  settings: SettingsRepository;
  signatureAssets?: SignatureAssetRepository;
  scanRuns?: ScanRunRepository;
  users?: UserRepository;
  jwtSecret?: string;
  now?: Date;
  backupMaxAgeDays?: number;
}): Promise<SystemRisk[]> {
  const risks: SystemRisk[] = [];
  const watchRoot = input.settings.get("watch_root");

  if (!watchRoot || !(await directoryExists(watchRoot))) {
    risks.push({
      key: "watch_root_missing",
      level: "error",
      title: "审批根目录未配置",
      message: "审批根目录未配置或服务器无法访问，监听、上传和归档都会受影响。",
      href: "#/settings"
    });
  } else {
    const missingFolders = await missingStandardFolders(watchRoot);
    if (missingFolders.length > 0) {
      risks.push({
        key: "standard_folders_missing",
        level: "error",
        title: "标准目录缺失",
        message: `缺少 ${missingFolders.join("、")}，请在目录与通知中重新创建标准目录。`,
        count: missingFolders.length,
        href: "#/settings"
      });
    }

    const unwritableFolders = await unwritableStandardFolders(watchRoot);
    if (unwritableFolders.length > 0) {
      risks.push({
        key: "standard_folders_unwritable",
        level: "error",
        title: "标准目录不可写",
        message: `${unwritableFolders.length} 个标准目录写入失败，请检查 Windows 权限或坚果云同步状态。`,
        count: unwritableFolders.length,
        href: "#/settings"
      });
    }
  }

  const latestScan = input.scanRuns?.listRecent(1)[0] ?? null;
  if (latestScan?.status === "failed") {
    risks.push({
      key: "latest_scan_failed",
      level: "error",
      title: "最近扫描失败",
      message: latestScan.errorMessage ?? "最近一次审批目录扫描失败，请查看服务日志后重新扫描。",
      href: "#/settings"
    });
  }

  const latestCompletedBackup = input.backups.listRecent().find((backup) => backup.status === "completed");
  const backupMaxAgeMs = (input.backupMaxAgeDays ?? 7) * 24 * 60 * 60 * 1000;
  const now = input.now ?? new Date();
  if (!latestCompletedBackup) {
    risks.push({
      key: "backup_missing",
      level: "warning",
      title: "暂无数据库备份",
      message: "尚未发现成功的数据库备份，建议上线前先创建一次备份。",
      href: "#/settings"
    });
  } else if (now.getTime() - Date.parse(latestCompletedBackup.startedAt) > backupMaxAgeMs) {
    risks.push({
      key: "backup_overdue",
      level: "warning",
      title: "数据库备份过期",
      message: `最近成功备份时间为 ${latestCompletedBackup.startedAt}，建议重新备份。`,
      href: "#/settings"
    });
  }

  addApprovalCountRisk(risks, {
    key: "file_missing",
    title: "文件丢失待处理",
    message: "有审批记录的 PDF 文件已经不在原位置，需要重新绑定或作废。",
    count: input.approvals.list({ status: "file_missing" }).length,
    href: "#/approvals?status=file_missing"
  });
  addApprovalCountRisk(risks, {
    key: "invalid_pdf",
    title: "PDF 无效待处理",
    message: "有文件扩展名为 PDF，但内容不是有效 PDF，需要重新导出或重新绑定。",
    count: input.approvals.list({ status: "invalid_pdf" }).length,
    href: "#/approvals?status=invalid_pdf"
  });

  const signatureFailedCount = input.approvals.list().filter((approval) => approval.signatureStatus === "failed").length;
  addApprovalCountRisk(risks, {
    key: "signature_failed",
    title: "签名失败待处理",
    message: "有已通过图纸生成签后 PDF 失败，请检查签名图片和签名框位置。",
    count: signatureFailedCount,
    href: "#/approvals?signatureStatus=failed"
  });

  const missingKeySignatures =
    input.signatureAssets
      ?.listUserSignatureStatus()
      .filter((user) => ["designer", "supervisor", "process"].includes(user.role) && !user.hasSignature).length ?? 0;
  if (missingKeySignatures > 0) {
    risks.push({
      key: "key_signatures_missing",
      level: "warning",
      title: "关键角色未配置签名",
      message: "设计师、主管或工艺存在未配置手写签名的账号，自动签后 PDF 可能失败。",
      count: missingKeySignatures,
      href: "#/settings"
    });
  }

  if (input.jwtSecret === defaultJwtSecret) {
    risks.push({
      key: "default_jwt_secret",
      level: "warning",
      title: "登录密钥仍是默认值",
      message: "当前仍在使用安装包默认登录密钥，重启服务前建议设置 PDF_APPROVAL_JWT_SECRET。",
      href: "#/settings"
    });
  }

  const defaultCredentialCount = countActiveDefaultCredentials(input.users);
  if (defaultCredentialCount > 0) {
    risks.push({
      key: "default_credentials_active",
      level: "warning",
      title: "默认账号密码仍可登录",
      message: "仍有初始账号使用出厂密码，建议在正式使用前修改管理员、主管和工艺账号密码。",
      count: defaultCredentialCount,
      href: "#/settings"
    });
  }

  return risks;
}

function addApprovalCountRisk(
  risks: SystemRisk[],
  input: { key: string; title: string; message: string; count: number; href: string }
) {
  if (input.count === 0) return;
  risks.push({
    key: input.key,
    level: "error",
    title: input.title,
    message: input.message,
    count: input.count,
    href: input.href
  });
}

async function missingStandardFolders(watchRoot: string) {
  const missing: string[] = [];
  for (const folder of Object.values(folders)) {
    if (!(await directoryExists(path.join(watchRoot, folder)))) {
      missing.push(folder);
    }
  }
  return missing;
}

async function unwritableStandardFolders(watchRoot: string) {
  const unwritable: string[] = [];
  for (const folder of Object.values(folders)) {
    const folderPath = path.join(watchRoot, folder);
    if (!(await directoryExists(folderPath))) continue;
    if (!(await canWrite(folderPath))) unwritable.push(folder);
  }
  return unwritable;
}

async function directoryExists(directoryPath: string) {
  try {
    const stat = await fs.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function canWrite(directoryPath: string) {
  const probePath = path.join(directoryPath, `.pdf-approval-risk-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(probePath, "ok");
    await fs.unlink(probePath);
    return true;
  } catch {
    await fs.unlink(probePath).catch(() => undefined);
    return false;
  }
}

function countActiveDefaultCredentials(users?: UserRepository) {
  if (!users) return 0;
  return [
    { username: "admin", password: "admin123" },
    { username: "supervisor", password: "123456" },
    { username: "process", password: "123456" }
  ].filter((credential) => {
    const user = users.findByUsername(credential.username);
    return user ? bcrypt.compareSync(credential.password, user.passwordHash) : false;
  }).length;
}
