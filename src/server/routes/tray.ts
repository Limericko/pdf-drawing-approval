import { Router } from "express";
import { requireAuth } from "../auth.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { BackupRunRepository } from "../repositories/backups.ts";
import type { ScanRunRepository } from "../repositories/scanRuns.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import type { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import type { UserRepository } from "../repositories/users.ts";
import { getTraySummary } from "../services/traySummary.ts";

export function trayRoutes(deps: {
  approvals: ApprovalRepository;
  backups: BackupRunRepository;
  settings: SettingsRepository;
  signatureAssets: SignatureAssetRepository;
  scanRuns?: ScanRunRepository;
  users?: UserRepository;
  jwtSecret: string;
}) {
  const router = Router();

  router.get("/summary", requireAuth(deps.jwtSecret), async (req, res) => {
    res.json(
      await getTraySummary({
        approvals: deps.approvals,
        backups: deps.backups,
        settings: deps.settings,
        signatureAssets: deps.signatureAssets,
        scanRuns: deps.scanRuns,
        users: deps.users,
        jwtSecret: deps.jwtSecret,
        user: req.user!
      })
    );
  });

  return router;
}
