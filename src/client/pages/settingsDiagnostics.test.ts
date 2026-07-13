import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  batchSubmissionStatusLabel,
  buildMaintenanceRunSummary,
  buildPdmBackfillSummary,
  normalizeBatchSubmissions,
  normalizeDiagnostics,
  normalizeSystemRisks,
  pdmBackfillReasonLabel,
  placementStateLabel,
  riskDashboardEmptyText,
  riskLevelLabel,
  settingsHashForTab,
  settingInputAutocomplete,
  settingsTabFromHash
} from "./SettingsPage.tsx";
import type { BatchSubmission, OperationLog, PdmBackfillResult, SystemDiagnostics, SystemRisk } from "../api.ts";

const source = fs.readFileSync(path.resolve("src/client/pages/SettingsPage.tsx"), "utf8");
const operationsTabSource = fs.readFileSync(path.resolve("src/client/pages/settings/OperationsTab.tsx"), "utf8");
const combinedSource = `${source}\n${operationsTabSource}`;

const baseDiagnostics: SystemDiagnostics = {
  overallStatus: "ok",
  database: { ok: true, error: null },
  watchRoot: { path: "G:\\Nutstore\\图纸审批", configured: true, exists: true },
  standardFolders: [],
  writePermissions: [],
  latestScan: null,
  latestBackup: null
};

describe("settings diagnostics view model", () => {
  it("reads the requested settings tab from hash query parameters", () => {
    expect(settingsTabFromHash("#/settings?tab=logs")).toBe("logs");
    expect(settingsTabFromHash("#/settings?tab=operations")).toBe("operations");
    expect(settingsTabFromHash("#/settings?tab=unknown")).toBe("settings");
    expect(settingsHashForTab("settings")).toBe("#/settings");
    expect(settingsHashForTab("logs")).toBe("#/settings?tab=logs");
  });

  it("keeps the operations panel renderable when an older service omits v3 diagnostic fields", () => {
    const normalized = normalizeDiagnostics(baseDiagnostics);

    expect(normalized.logs).toEqual([]);
    expect(normalized.service.startedAt).toBe("未知");
    expect(normalized.service.uptimeSeconds).toBe(0);
  });

  it("normalizes operational risks and preserves action links", () => {
    const risks: SystemRisk[] = [
      {
        key: "file_missing",
        level: "error",
        title: "文件丢失待处理",
        message: "有审批记录的 PDF 文件已经不在原位置。",
        count: 2,
        href: "#/approvals?status=file_missing"
      }
    ];

    expect(normalizeSystemRisks(risks)).toEqual([
      {
        ...risks[0],
        countLabel: "2 项",
        levelLabel: "异常",
        actionLabel: "去处理"
      }
    ]);
  });

  it("handles empty risk lists", () => {
    expect(normalizeSystemRisks([])).toEqual([]);
    expect(riskDashboardEmptyText).toBe("暂无需要处理的风险");
  });

  it("labels warning and normal risk levels", () => {
    expect(riskLevelLabel("warning")).toBe("提醒");
    expect(riskLevelLabel("ok")).toBe("正常");
  });

  it("normalizes batch submission history for operations trace", () => {
    const batches: BatchSubmission[] = [
      {
        id: 7,
        createdByUserId: 1,
        projectName: "项目A",
        status: "partial",
        totalCount: 3,
        successCount: 2,
        failedCount: 1,
        errorMessage: null,
        createdAt: "2026-06-18T01:00:00.000Z",
        finishedAt: "2026-06-18T01:01:00.000Z",
        items: [
          {
            id: 1,
            batchId: 7,
            fileName: "板-a0A0.pdf",
            approvalId: 9,
            status: "completed",
            errorMessage: null,
            placementState: "template",
            createdAt: "2026-06-18T01:00:10.000Z"
          },
          {
            id: 2,
            batchId: 7,
            fileName: "轴-a0A0.pdf",
            approvalId: null,
            status: "failed",
            errorMessage: "DUPLICATE_VERSION",
            placementState: "missing",
            createdAt: "2026-06-18T01:00:12.000Z"
          }
        ]
      }
    ];

    expect(batchSubmissionStatusLabel("partial")).toBe("部分成功");
    expect(placementStateLabel("template")).toBe("模板");
    expect(normalizeBatchSubmissions(batches)[0]).toMatchObject({
      id: 7,
      statusLabel: "部分成功",
      resultText: "成功 2 / 失败 1 / 总计 3",
      itemSummary: ["板-a0A0.pdf · 已完成 · 模板", "轴-a0A0.pdf · 失败 · 缺失 · DUPLICATE_VERSION"]
    });
  });

  it("summarizes recent automatic maintenance results from operation logs", () => {
    const logs: OperationLog[] = [
      operationLog({
        id: 3,
        actorUsername: "system",
        action: "system.cleanup_executed",
        message: "系统自动执行了清理维护",
        createdAt: "2026-06-23T03:40:00.000Z"
      }),
      operationLog({
        id: 2,
        actorUsername: "admin",
        action: "system.backup_validated",
        message: "备份目录可读取。",
        createdAt: "2026-06-23T02:00:00.000Z"
      }),
      operationLog({
        id: 1,
        actorUsername: "system",
        action: "system.backup_completed",
        message: "系统自动创建了数据库备份",
        createdAt: "2026-06-23T01:20:00.000Z"
      })
    ];

    expect(buildMaintenanceRunSummary(logs)).toEqual([
      expect.objectContaining({ key: "autoBackup", label: "自动备份", tone: "ok", message: "系统自动创建了数据库备份" }),
      expect.objectContaining({ key: "autoCleanup", label: "自动清理", tone: "ok", message: "系统自动执行了清理维护" }),
      expect.objectContaining({ key: "backupValidation", label: "备份校验", tone: "ok", message: "备份目录可读取。" })
    ]);
  });

  it("summarizes PDM historical backfill results for the admin operations panel", () => {
    const result: PdmBackfillResult = {
      scanned: 3,
      published: 1,
      skipped: 1,
      failed: 1,
      items: [
        { approvalId: 10, status: "published", materialCode: "0102A00700883", version: "a0A0" },
        { approvalId: 11, status: "skipped", reason: "filename_not_standard_pdm" },
        { approvalId: 12, status: "failed", reason: "pdm_publish_failed", materialCode: "0102A00700884", version: "a1A0" }
      ]
    };

    expect(buildPdmBackfillSummary(result)).toEqual({
      headline: "扫描 3 / 发布 1 / 跳过 1 / 失败 1",
      rows: [
        "审批 #10 · 已发布 · 0102A00700883 · a0A0",
        "审批 #11 · 已跳过 · 文件名不是完整 PDM 格式",
        "审批 #12 · 失败 · PDM 发布失败 · 0102A00700884 · a1A0"
      ]
    });
    expect(pdmBackfillReasonLabel("duplicate_material_version")).toBe("物料版本已存在");
  });

  it("uses operations-focused admin copy", () => {
    expect(source).toContain("<OperationsTab");
    expect(source).toContain("系统运维控制台");
    expect(source).toContain("配置目录、用户、签名模板、日志和追溯报表。");
    expect(source).toContain("优先使用“浏览服务器目录”选择坚果云目录，确保服务端能监听到真实路径。");
    expect(combinedSource).toContain("清理维护");
    expect(combinedSource).toContain("预览清理项");
    expect(combinedSource).toContain("执行清理");
    expect(combinedSource).toContain("runSystemCleanup");
    expect(combinedSource).toContain("自动维护");
    expect(combinedSource).toContain("维护执行结果");
    expect(combinedSource).toContain("buildMaintenanceRunSummary");
    expect(combinedSource).toContain("校验备份目录");
    expect(combinedSource).toContain("saveMaintenanceSettings");
    expect(combinedSource).toContain("validateBackupDirectory");
    expect(combinedSource).toContain('ariaLabel="操作日志"');
    expect(combinedSource).toContain("DataTable");
    expect(combinedSource).toContain("最近 100 条");
    expect(combinedSource).toContain("版本更新");
    expect(combinedSource).toContain("服务端当前版本");
    expect(combinedSource).toContain("getSystemUpdateInfo");
    expect(combinedSource).toContain("服务端内置更新目录");
    expect(combinedSource).toContain("PDM 历史回填");
    expect(combinedSource).toContain("runPdmApprovedBackfill");
    expect(combinedSource).toContain("回填已通过图纸");
    expect(combinedSource).not.toContain("本机更新日志");
    expect(combinedSource).not.toContain("release-note-entry");
    expect(combinedSource).not.toContain("update_manifest_url");
  });

  it("loads admin tab data on demand instead of fetching every panel on first paint", () => {
    const initialEffectStart = source.indexOf("useEffect(() => {");
    const initialEffect = source.slice(initialEffectStart, source.indexOf("}, []);", initialEffectStart));

    expect(initialEffect).toContain("refreshSettings();");
    expect(initialEffect).not.toContain("refreshUsers();");
    expect(initialEffect).not.toContain("refreshLogs();");
    expect(initialEffect).not.toContain("refreshSignatureTemplates();");
    expect(source).toContain("async function refreshTab(nextTab: Tab)");
    expect(source).toContain("void refreshTab(tab);");
    expect(source).toContain("function switchTab(nextTab: Tab)");
    expect(source).toContain("location.hash = settingsHashForTab(nextTab)");
  });

  it("uses autocomplete hints for admin credential and contact fields", () => {
    expect(settingInputAutocomplete("smtp_user")).toBe("username");
    expect(settingInputAutocomplete("smtp_password")).toBe("current-password");
    expect(settingInputAutocomplete("smtp_from")).toBe("email");
    expect(settingInputAutocomplete("supervisor_email")).toBe("email");
    expect(settingInputAutocomplete("watch_root")).toBe("off");
    expect(source).toContain('autoComplete="new-password"');
    expect(source).toContain('autoComplete="email"');
  });
});

function operationLog(input: Partial<OperationLog>): OperationLog {
  return {
    id: input.id ?? 1,
    actorUserId: input.actorUserId ?? null,
    actorUsername: input.actorUsername ?? null,
    action: input.action ?? "system.backup_completed",
    targetType: input.targetType ?? "system",
    targetId: input.targetId ?? null,
    message: input.message ?? "ok",
    metadata: input.metadata ?? null,
    createdAt: input.createdAt ?? "2026-06-23T00:00:00.000Z"
  };
}
