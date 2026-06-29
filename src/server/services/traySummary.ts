import type { AuthUser } from "../auth.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { BackupRunRepository } from "../repositories/backups.ts";
import type { ScanRunRepository } from "../repositories/scanRuns.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import type { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import type { UserRepository } from "../repositories/users.ts";
import { getSystemRisks } from "./systemRisks.ts";

export type TraySummary = {
  serverTime: string;
  user: AuthUser;
  tasks: {
    pendingCount: number;
    latestIds: number[];
    latest: Array<{
      id: number;
      projectName: string;
      partName: string;
      version: string;
      submittedAt: string;
      href: string;
    }>;
  };
  admin: {
    overallStatus: "ok" | "warning" | "error";
    riskCount: number;
  } | null;
};

type TraySummaryInput = {
  user: AuthUser;
  approvals: ApprovalRepository;
  backups: BackupRunRepository;
  settings: SettingsRepository;
  signatureAssets: SignatureAssetRepository;
  scanRuns?: ScanRunRepository;
  users?: UserRepository;
  jwtSecret?: string;
};

export async function getTraySummary(input: TraySummaryInput): Promise<TraySummary> {
  const reviewerRole = input.user.role === "supervisor" || input.user.role === "process" ? input.user.role : undefined;
  const pendingTasks = reviewerRole ? input.approvals.list({ reviewerRole }) : [];
  const latestTasks = pendingTasks.slice(0, 5);
  const risks =
    input.user.role === "admin"
      ? await getSystemRisks({
          approvals: input.approvals,
          backups: input.backups,
          settings: input.settings,
          signatureAssets: input.signatureAssets,
          scanRuns: input.scanRuns,
          users: input.users,
          jwtSecret: input.jwtSecret
        })
      : [];

  return {
    serverTime: new Date().toISOString(),
    user: input.user,
    tasks: {
      pendingCount: pendingTasks.length,
      latestIds: latestTasks.map((approval) => approval.id),
      latest: latestTasks.map((approval) => ({
        id: approval.id,
        projectName: approval.projectName,
        partName: approval.partName,
        version: approval.version,
        submittedAt: approval.submittedAt,
        href: `#/approvals/${approval.id}`
      }))
    },
    admin:
      input.user.role === "admin"
        ? {
            overallStatus: risks.some((risk) => risk.level === "error")
              ? "error"
              : risks.some((risk) => risk.level === "warning")
                ? "warning"
                : "ok",
            riskCount: risks.length
          }
        : null
  };
}
