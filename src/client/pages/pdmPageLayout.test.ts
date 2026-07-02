import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PdmPartDetail, PdmPartListItem, PdmPendingMetadataApproval } from "../api.ts";
import {
  buildPdmLibraryStats,
  pdmLibraryDescription,
  pdmLibraryEmptyText,
  pdmMetadataStatusLabel,
  pdmPartStatusLabel,
  pdmUsageProjectsText
} from "./PdmPartsPage.tsx";
import {
  pdmDetailOverviewFacts,
  pdmRevisionStatusLabel,
  pdmRevisionSummary,
  pdmTraceabilityLabel
} from "./PdmPartDetailPage.tsx";

const listSource = fs.readFileSync(path.resolve("src/client/pages/PdmPartsPage.tsx"), "utf8");
const detailSource = fs.readFileSync(path.resolve("src/client/pages/PdmPartDetailPage.tsx"), "utf8");
const pendingSource = fs.existsSync(path.resolve("src/client/pages/PdmPendingMetadataPage.tsx"))
  ? fs.readFileSync(path.resolve("src/client/pages/PdmPendingMetadataPage.tsx"), "utf8")
  : "";

describe("PDM part library page layout", () => {
  it("uses part-library copy and keeps PDM visible to all workflow roles", () => {
    expect(pdmLibraryDescription("designer")).toBe("查询受控图纸版本，补齐自己提交图纸的 PDM 信息。");
    expect(pdmLibraryDescription("supervisor")).toBe("查询当前有效版本、历史版本和共用项目，辅助审核判断。");
    expect(pdmLibraryDescription("process")).toBe("查询当前有效版本、历史版本和共用项目，辅助工艺审查。");
    expect(pdmLibraryDescription("admin")).toBe("维护 PDM 待补录和发布异常，追溯零件图纸版本。");
  });

  it("renders the required list fields for controlled part lookup", () => {
    expect(listSource).toContain("管家婆物料号");
    expect(listSource).toContain("图纸名称");
    expect(listSource).toContain("当前有效版本");
    expect(listSource).toContain("体系文件号");
    expect(listSource).toContain("使用项目");
    expect(listSource).toContain("状态");
    expect(listSource).toContain("listPdmParts");
    expect(listSource).toContain("listPendingPdmMetadata");
  });

  it("formats usage projects and status badges for scan-friendly rows", () => {
    const item = partItem({ usageProjectCount: 3, usageProjects: ["项目A", "项目B", "项目C"], isCommon: true });

    expect(pdmUsageProjectsText(item)).toBe("项目A、项目B、项目C");
    expect(pdmPartStatusLabel(item)).toBe("共用件");
    expect(pdmPartStatusLabel(partItem({ currentVersion: null, currentRevisionId: null }))).toBe("待发布");
    expect(pdmMetadataStatusLabel("missing_material_code")).toBe("待补物料号");
    expect(pdmMetadataStatusLabel("missing_document_code")).toBe("体系文件号待补");
  });

  it("uses clear empty-state and pending metadata copy", () => {
    expect(pdmLibraryEmptyText(false)).toBe("暂无 PDM 零件档案。审批通过并发布后会自动进入这里。");
    expect(pdmLibraryEmptyText(true)).toBe("没有匹配的零件档案，请调整关键词或筛选条件。");

    const pending: PdmPendingMetadataApproval = {
      approvalId: 9,
      projectName: "项目A",
      partName: "旧格式零件",
      version: "a0A0",
      documentCode: null,
      materialCode: null,
      drawingName: "旧格式零件",
      metadataStatus: "missing_material_code",
      publishStatus: "metadata_pending",
      publishError: null,
      submittedByUserId: 1,
      submittedAt: "2026-06-29T01:00:00.000Z"
    };

    expect(listSource).toContain("PDM 待补录");
    expect(listSource).toContain("补录后才能进入正式零件库");
    expect(pdmMetadataStatusLabel(pending.metadataStatus)).toBe("待补物料号");
  });

  it("uses a PDM workbench shell with scan-friendly summary and issue queue", () => {
    expect(listSource).toContain("PDM 工作台");
    expect(listSource).toContain("pdm-ledger-shell");
    expect(listSource).toContain("pdm-overview-grid");
    expect(listSource).toContain("pdm-filter-section");
    expect(listSource).toContain("pdm-ledger-section");
    expect(listSource).toContain("pdm-risk-queue");
    expect(listSource).toContain("进入待补录");
    expect(listSource).toContain("#/pdm/pending-metadata");

    expect(buildPdmLibraryStats({ totalParts: 42, currentRevisionCount: 31, commonPartCount: 8 }, 3)).toEqual([
      { label: "零件总数", value: "42", note: "按当前筛选统计" },
      { label: "当前有效版本", value: "31", note: "已发布当前版本" },
      { label: "待补录", value: "3", note: "需补齐物料号或发布异常" },
      { label: "共用件数", value: "8", note: "跨项目复用" }
    ]);
  });
});

describe("PDM pending metadata page layout", () => {
  it("renders a dedicated repair queue instead of sending users to the full approval ledger", () => {
    expect(pendingSource).toContain("PDM 待补录清单");
    expect(pendingSource).toContain("pdm-pending-page");
    expect(pendingSource).toContain("pdm-pending-summary");
    expect(pendingSource).toContain("listPendingPdmMetadata");
    expect(pendingSource).toContain("返回零件库");
    expect(pendingSource).toContain("打开审批详情");
    expect(pendingSource).toContain("体系文件号");
    expect(pendingSource).toContain("管家婆物料号");
  });
});

describe("PDM part detail page layout", () => {
  it("shows current revision, revision history, usage projects, and trace links", () => {
    expect(detailSource).toContain("pdm-detail-shell");
    expect(detailSource).toContain("pdm-master-card");
    expect(detailSource).toContain("pdm-current-version-pin");
    expect(detailSource).toContain("pdm-relation-tabs");
    expect(detailSource).toContain("pdm-hash-grid");
    expect(detailSource).toContain("零件主档案");
    expect(detailSource).toContain("当前有效版本");
    expect(detailSource).toContain("历史版本");
    expect(detailSource).toContain("使用项目");
    expect(detailSource).toContain("审批记录");
    expect(detailSource).toContain("getPdmPart");
  });

  it("summarizes revision state without hiding superseded versions", () => {
    const detail: PdmPartDetail = {
      part: partItem({ id: 3, currentRevisionId: 12 }),
      currentRevision: {
        id: 12,
        partId: 3,
        materialCode: "0102A00700883",
        documentCode: "MP300A000072",
        drawingName: "400A按键",
        version: "a1A0",
        minorVersion: "a1",
        majorVersion: "A0",
        approvalId: 22,
        releaseStatus: "released",
        originalFilePath: "original.pdf",
        originalFileHash: "hash-1",
        signedFilePath: "signed.pdf",
        signedFileHash: "hash-2",
        annotatedFilePath: null,
        releasedAt: "2026-06-29T01:00:00.000Z",
        createdAt: "2026-06-29T01:00:00.000Z",
        updatedAt: "2026-06-29T01:00:00.000Z"
      },
      revisions: [],
      usages: []
    };

    expect(pdmRevisionSummary(detail)).toBe("当前 a1A0 / 体系文件号 MP300A000072");
    expect(pdmRevisionStatusLabel("released")).toBe("当前有效");
    expect(pdmRevisionStatusLabel("superseded")).toBe("历史版本");
    expect(pdmTraceabilityLabel(22)).toBe("查看审批 #22");
    expect(pdmDetailOverviewFacts(detail)).toEqual([
      { label: "管家婆物料号", value: "0102A00700883" },
      { label: "当前有效版本", value: "a1A0" },
      { label: "体系文件号", value: "MP300A000072" },
      { label: "共用状态", value: "普通零件" },
      { label: "使用项目", value: "未记录" }
    ]);
  });
});

function partItem(overrides: Partial<PdmPartListItem> = {}): PdmPartListItem {
  return {
    id: 1,
    materialCode: "0102A00700883",
    name: "400A按键",
    isCommon: false,
    currentRevisionId: 10,
    createdFromApprovalId: 7,
    createdAt: "2026-06-29T01:00:00.000Z",
    updatedAt: "2026-06-29T01:00:00.000Z",
    currentVersion: "a0A0",
    currentDocumentCode: "MP300A000072",
    currentApprovalId: 7,
    currentReleasedAt: "2026-06-29T01:00:00.000Z",
    usageProjectCount: 1,
    usageProjects: ["项目A"],
    ...overrides
  };
}
