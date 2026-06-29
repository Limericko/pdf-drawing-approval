import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as submitPage from "./SubmitDrawingPage.tsx";
import type { Approval, SignaturePlacement } from "../api.ts";

const source = fs.readFileSync(path.resolve("src/client/pages/SubmitDrawingPage.tsx"), "utf8");

describe("submit drawing page layout structure", () => {
  it("uses the shared in-page PDF placement workspace for signature positioning", () => {
    expect(source).toContain("PdfSignaturePlacementWorkspace");
    expect(source).toContain("lazy(");
    expect(source).toContain("Suspense");
    expect(source).toContain("import(\"../widgets/PdfSignaturePlacementWorkspace.tsx\")");
    expect(source).toContain("pdfUrl={previewUrl}");
    expect(source).not.toContain("<iframe src={previewUrl}");
  });

  it("shows a signature template selector on the submit page", () => {
    expect(source).toContain("listSignatureTemplates");
    expect(source).toContain("签名模板");
    expect(source).toContain("套用模板");
  });

  it("shows common project shortcuts from the user's profile", () => {
    const applyCommonProject = (
      submitPage as unknown as {
        applyCommonProject?: (projectName: string, project: string) => string;
      }
    ).applyCommonProject;

    expect(source).toContain("getProfile");
    expect(source).toContain("common-projects");
    expect(source).toContain("常用项目");
    expect(applyCommonProject).toBeTypeOf("function");
    expect(applyCommonProject!("旧项目", "项目A")).toBe("项目A");
  });

  it("uses action-oriented copy for designer submission", () => {
    expect(source).toContain("上传并提交图纸");
    expect(source).toContain("逐张确认零件、版本和三处签名框后提交审批。");
  });

  it("applies a template by replacing all three current placements", () => {
    const applyTemplate = (
      submitPage as unknown as {
    applySignatureTemplatePlacements?: (current: SignaturePlacement[], template: { placements: SignaturePlacement[] }) => SignaturePlacement[];
    applyTemplateToBatchItems?: (
      items: Array<{ clientId: string; placements: SignaturePlacement[]; placementState: string }>,
      template: { placements: SignaturePlacement[] },
      templateId?: number
    ) => Array<{ clientId: string; placements: SignaturePlacement[]; placementState: string; templateId?: number }>;
    applyTemplateToSelectedBatchItem?: (
      items: Array<{ clientId: string; placements: SignaturePlacement[]; placementState: string }>,
      selectedClientId: string,
      template: { placements: SignaturePlacement[] },
      templateId?: number
    ) => Array<{ clientId: string; placements: SignaturePlacement[]; placementState: string; templateId?: number }>;
    updateBatchItemPlacements?: (
      items: Array<{ clientId: string; placements: SignaturePlacement[]; placementState: string }>,
      selectedClientId: string,
      placements: SignaturePlacement[]
    ) => Array<{ clientId: string; placements: SignaturePlacement[]; placementState: string }>;
  }
).applySignatureTemplatePlacements;
    const current: SignaturePlacement[] = [
      { role: "designer", pageNumber: 1, xRatio: 0.1, yRatio: 0.1, widthRatio: 0.1, heightRatio: 0.05 },
      { role: "supervisor", pageNumber: 1, xRatio: 0.2, yRatio: 0.1, widthRatio: 0.1, heightRatio: 0.05 },
      { role: "process", pageNumber: 1, xRatio: 0.3, yRatio: 0.1, widthRatio: 0.1, heightRatio: 0.05 }
    ];
    const templatePlacements: SignaturePlacement[] = [
      { role: "designer", pageNumber: 2, xRatio: 0.58, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "supervisor", pageNumber: 2, xRatio: 0.72, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "process", pageNumber: 2, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 }
    ];

    expect(applyTemplate).toBeTypeOf("function");
    expect(applyTemplate!(current, { placements: templatePlacements })).toEqual(templatePlacements);
    expect(applyTemplate!(current, { placements: templatePlacements })).not.toBe(templatePlacements);
  });

  it("supports multi-file batch controls on the submit page", () => {
    expect(source).toContain("multiple");
    expect(source).toContain("批量套用模板");
    expect(source).toContain("batch-item-list");
    expect(source).toContain("placementState");
  });

  it("shows existing version hints after upload parsing", () => {
    const versionTraceWarning = (
      submitPage as unknown as { versionTraceWarning?: (versions?: Approval[]) => string }
    ).versionTraceWarning;

    expect(source).toContain("existingVersions");
    expect(source).toContain("同零件已有");
    expect(versionTraceWarning).toBeTypeOf("function");
    expect(versionTraceWarning!([{ id: 1, version: "a0A0" }] as Approval[])).toBe("同零件已有 1 个版本：a0A0");
  });

  it("merges refreshed existing version hints by batch item", () => {
    const mergeExistingVersionHints = (
      submitPage as unknown as {
        mergeExistingVersionHints?: <T extends { clientId: string; existingVersions?: Approval[] }>(
          items: T[],
          hints: Array<{ clientId: string; existingVersions: Approval[] }>
        ) => T[];
      }
    ).mergeExistingVersionHints;
    const version = { id: 2, version: "a1A0" } as Approval;

    expect(source).toContain("listSubmissionExistingVersions");
    expect(mergeExistingVersionHints).toBeTypeOf("function");
    const result = mergeExistingVersionHints!(
      [
        { clientId: "a", existingVersions: [] },
        { clientId: "b", existingVersions: [] }
      ],
      [{ clientId: "b", existingVersions: [version] }]
    );

    expect(result[0].existingVersions).toEqual([]);
    expect(result[1].existingVersions).toEqual([version]);
  });

  it("plans existing version lookups once per filled part name", () => {
    const buildExistingVersionLookupPlan = (
      submitPage as unknown as {
        buildExistingVersionLookupPlan?: (
          projectName: string,
          items: Array<{ clientId: string; partName: string }>
        ) => Array<{ partName: string; clientIds: string[] }>;
      }
    ).buildExistingVersionLookupPlan;

    expect(buildExistingVersionLookupPlan).toBeTypeOf("function");
    expect(buildExistingVersionLookupPlan!("", [{ clientId: "a", partName: "支架" }])).toEqual([]);
    expect(buildExistingVersionLookupPlan!("项目A", [{ clientId: "a", partName: " " }])).toEqual([]);
    expect(
      buildExistingVersionLookupPlan!("项目A", [
        { clientId: "a", partName: "支架" },
        { clientId: "b", partName: "支架 " },
        { clientId: "c", partName: "底板" }
      ])
    ).toEqual([
      { partName: "支架", clientIds: ["a", "b"] },
      { partName: "底板", clientIds: ["c"] }
    ]);
  });

  it("copies a template into each batch item independently", () => {
    const applyToBatch = (
      submitPage as unknown as {
        applyTemplateToBatchItems?: (
          items: Array<{ clientId: string; placements: SignaturePlacement[]; placementState: string }>,
          template: { placements: SignaturePlacement[] },
          templateId?: number
        ) => Array<{ clientId: string; placements: SignaturePlacement[]; placementState: string; templateId?: number }>;
      }
    ).applyTemplateToBatchItems;
    const templatePlacements: SignaturePlacement[] = [
      { role: "designer", pageNumber: 1, xRatio: 0.58, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "supervisor", pageNumber: 1, xRatio: 0.72, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 }
    ];

    expect(applyToBatch).toBeTypeOf("function");
    const result = applyToBatch!(
      [
        { clientId: "a", placements: [], placementState: "missing" },
        { clientId: "b", placements: [], placementState: "missing" }
      ],
      { placements: templatePlacements },
      5
    );

    expect(result.map((item) => item.placementState)).toEqual(["template", "template"]);
    expect(result.map((item) => item.templateId)).toEqual([5, 5]);
    expect(result[0].placements).toEqual(templatePlacements);
    expect(result[0].placements).not.toBe(result[1].placements);
  });

  it("updates only the selected batch item when editing signature boxes", () => {
    const updatePlacements = (
      submitPage as unknown as {
        updateBatchItemPlacements?: (
          items: Array<{ clientId: string; placements: SignaturePlacement[]; placementState: string }>,
          selectedClientId: string,
          placements: SignaturePlacement[]
        ) => Array<{ clientId: string; placements: SignaturePlacement[]; placementState: string }>;
      }
    ).updateBatchItemPlacements;
    const original: SignaturePlacement[] = [
      { role: "designer", pageNumber: 1, xRatio: 0.1, yRatio: 0.1, widthRatio: 0.1, heightRatio: 0.05 }
    ] as SignaturePlacement[];
    const next: SignaturePlacement[] = [
      { role: "designer", pageNumber: 1, xRatio: 0.6, yRatio: 0.1, widthRatio: 0.1, heightRatio: 0.05 }
    ] as SignaturePlacement[];

    expect(updatePlacements).toBeTypeOf("function");
    const result = updatePlacements!(
      [
        { clientId: "a", placements: original, placementState: "template" },
        { clientId: "b", placements: original, placementState: "template" }
      ],
      "b",
      next
    );

    expect(result[0].placements).toEqual(original);
    expect(result[0].placementState).toBe("template");
    expect(result[1].placements).toEqual(next);
    expect(result[1].placementState).toBe("manual");
  });

  it("explains why submission is disabled before the designer submits", () => {
    const submitDisabledReason = (
      submitPage as unknown as {
        submitDisabledReason?: (
          projectName: string,
          items: Array<{ status: string; partName: string; version: string; placements: SignaturePlacement[] }>
        ) => string;
      }
    ).submitDisabledReason;
    const placements: SignaturePlacement[] = [
      { role: "designer", pageNumber: 1, xRatio: 0.1, yRatio: 0.1, widthRatio: 0.1, heightRatio: 0.05 },
      { role: "supervisor", pageNumber: 1, xRatio: 0.2, yRatio: 0.1, widthRatio: 0.1, heightRatio: 0.05 },
      { role: "process", pageNumber: 1, xRatio: 0.3, yRatio: 0.1, widthRatio: 0.1, heightRatio: 0.05 }
    ];

    expect(source).toContain("submit-checklist");
    expect(source).toContain("submit-disabled-reason");
    expect(submitDisabledReason).toBeTypeOf("function");
    expect(submitDisabledReason!("", [])).toBe("请选择 PDF 文件");
    expect(submitDisabledReason!("", [{ status: "uploaded", partName: "支架", version: "a0A0", placements }])).toBe("请填写项目名称");
    expect(submitDisabledReason!("300A", [{ status: "uploaded", partName: "", version: "a0A0", placements }])).toBe("请补全零件名称和版本");
    expect(
      submitDisabledReason!("300A", [
        { status: "uploaded", partName: "支架", version: "a0A0", placements: placements.slice(0, 2) }
      ])
    ).toBe("请放置设计、主管、工艺三个签名框");
    expect(submitDisabledReason!("300A", [{ status: "uploaded", partName: "支架", version: "a0A0", placements }])).toBe("");
  });

  it("provides detail links for completed batch submission items", () => {
    const batchItemApprovalHref = (
      submitPage as unknown as { batchItemApprovalHref?: (item: { status: string; approvalId?: number | null }) => string }
    ).batchItemApprovalHref;

    expect(source).toContain("查看图纸");
    expect(batchItemApprovalHref).toBeTypeOf("function");
    expect(batchItemApprovalHref!({ status: "completed", approvalId: 12 })).toBe("#/approvals/12");
    expect(batchItemApprovalHref!({ status: "failed", approvalId: 12 })).toBe("");
    expect(batchItemApprovalHref!({ status: "completed", approvalId: null })).toBe("");
  });
});
