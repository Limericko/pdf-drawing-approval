import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const approvalDetail = readFileSync(new URL("../../pages/ApprovalDetailPage.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../../pages/SettingsPage.tsx", import.meta.url), "utf8");

describe("overlay call-site migration", () => {
  it("uses shared dialogs for desktop update, signature setup and print settings", () => {
    expect(app).toContain('import { Dialog } from "./ui/overlays/index.tsx"');
    expect(app).not.toContain('className="desktop-update-overlay"');
    expect(app).not.toContain('className="signature-required-overlay"');
    expect(approvalDetail).toContain('import { Dialog } from "../ui/overlays/index.tsx"');
    expect(approvalDetail).not.toContain('className="print-settings-backdrop"');
  });

  it("uses shared dangerous confirmations for cleanup and PDM backfill", () => {
    expect(settings).toContain('import { ConfirmDialog } from "../ui/overlays/index.tsx"');
    expect(settings).toContain('dangerConfirmation === "cleanup"');
    expect(settings).toContain('dangerConfirmation === "pdm-backfill"');
    expect(settings).not.toContain('window.confirm("确认执行清理');
    expect(settings).not.toContain('window.confirm("确认执行 PDM 历史回填');
  });
});
