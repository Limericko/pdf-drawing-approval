import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve("src/client/pages/ApprovalDetailPage.tsx"), "utf8");
const annotationSidePanelSource = fs.readFileSync(path.resolve("src/client/pages/approvalDetail/AnnotationSidePanel.tsx"), "utf8");
const activityInspectorSource = fs.readFileSync(path.resolve("src/client/features/pdf-studio/ActivityInspector.tsx"), "utf8");
const pdmMetadataPanelSource = fs.readFileSync(path.resolve("src/client/pages/approvalDetail/PdmMetadataPanel.tsx"), "utf8");
const signaturePanelSource = fs.readFileSync(path.resolve("src/client/pages/approvalDetail/SignaturePanel.tsx"), "utf8");
const combinedSource = [source, annotationSidePanelSource, activityInspectorSource, pdmMetadataPanelSource, signaturePanelSource].join("\n");
const workspaceSource = fs.readFileSync(path.resolve("src/client/widgets/PdfAnnotationWorkspace.tsx"), "utf8");
const layerSource = fs.readFileSync(path.resolve("src/client/widgets/PdfAnnotationLayer.tsx"), "utf8");

function sidePanelSource() {
  const start = source.indexOf('<aside className={studioStyles.inspector}');
  const end = source.indexOf("</aside>", start);
  return start === -1 || end === -1 ? "" : source.slice(start, end);
}

describe("approval detail page layout structure", () => {
  it("uses the Phase 3 document-first studio shell and responsive inspector", () => {
    expect(source).toContain("PdfStudioLayout.module.css");
    expect(source).toContain("studioStyles.contextStrip");
    expect(source).toContain("studioStyles.canvas");
    expect(source).toContain("studioStyles.inspector");
    expect(source).toContain("打开审阅检查器");
    expect(source).toContain("IssueInspector");
  });
  it("extracts large side, activity, and signature panels into dedicated components", () => {
    expect(source).toContain("AnnotationSidePanel");
    expect(source).toContain("ActivityInspector");
    expect(source).toContain("SignaturePanel");
  });

  it("clears stale detail errors before reloading another approval", () => {
    const reloadStart = source.indexOf("async function reload(");
    const reloadBody = source.slice(reloadStart, source.indexOf("useEffect", reloadStart));
    const effectBody = source.slice(source.indexOf("useEffect"), source.indexOf("async function review"));

    expect(reloadBody).toContain('setError("");');
    expect(reloadBody.indexOf('setError("");')).toBeLessThan(reloadBody.indexOf("getApproval(id)"));
    expect(reloadBody).toContain("if (!isCurrent()) return;");
    expect(effectBody).toContain("let active = true;");
    expect(effectBody).toContain("reload(() => active)");
    expect(effectBody).toContain("active = false;");
  });

  it("keeps traceability and collaboration inside the inspector activity tab", () => {
    const sidePanel = sidePanelSource();

    expect(sidePanel).toContain("ActivityInspector");
    expect(sidePanel).toContain('inspectorTab === "activity"');
    expect(activityInspectorSource).toContain("协同与追溯");
    expect(source).toContain("const signedPdfCacheKey");
    expect(combinedSource).toContain("getSignedFileUrl(approval.id, signedPdfCacheKey)");
    expect(source).not.toContain('className="detail-support-section"');
    expect(source).not.toContain("FloatingSupportPanel");
    expect(source).not.toContain("floatingPanelPosition");
  });

  it("uses an in-page PDF placement workspace while editing signature positions", () => {
    expect(source).toContain("PdfSignaturePlacementWorkspace");
    expect(source).toContain("lazy(");
    expect(source).toContain("Suspense");
    expect(source).toContain("placementEditing ? (");
    expect(source).toContain("getApprovalFileUrl");
    expect(source).toContain("pdfUrl={getApprovalFileUrl(approval.id)}");
  });

  it("uses task-focused copy for review and signed PDF output", () => {
    expect(source).toContain("审阅检查器");
    expect(source).toContain("ReviewActionBar");
    expect(source).toContain("onApproveAndNext");
    expect(combinedSource).toContain("左侧保留原始 PDF，签后 PDF 用于正式打印。");
  });

  it("shows compact PDM metadata, repair controls, and publish retry in the side panel", () => {
    const sidePanel = sidePanelSource();

    expect(source).toContain("PdmMetadataPanel");
    expect(sidePanel).toContain("<PdmMetadataPanel");
    expect(source).toContain("repairApprovalPdmMetadata");
    expect(source).toContain("publishApprovalToPdm");
    expect(combinedSource).toContain("PDM 信息");
    expect(combinedSource).toContain("体系文件号");
    expect(combinedSource).toContain("管家婆物料号");
    expect(combinedSource).toContain("图纸名称");
    expect(combinedSource).toContain("PDM 发布状态");
    expect(combinedSource).toContain("关联零件档案");
    expect(combinedSource).toContain("补录 PDM 信息");
    expect(combinedSource).toContain("发布到 PDM");
  });

  it("loads and displays drawing annotations in the approval detail workspace", () => {
    const reloadStart = source.indexOf("async function reload(");
    const reloadBody = source.slice(reloadStart, source.indexOf("useEffect", reloadStart));
    const sidePanel = sidePanelSource();

    expect(source).toContain("PdfAnnotationWorkspace");
    expect(source).toContain("import(\"../widgets/PdfAnnotationWorkspace.tsx\")");
    expect(source).toContain("listApprovalAnnotations(id)");
    expect(reloadBody).toContain("setAnnotations(annotations)");
    expect(source).toContain("annotations={annotations}");
    expect(source).toContain("onDraftAnnotation={startAnnotationDraft}");
    expect(annotationSidePanelSource).toContain("图纸批注");
    expect(sidePanel).not.toContain("annotation-tool-row");
    expect(source).toContain("getAnnotatedFileUrl(approval.id");
  });

  it("filters annotations and supports continuous marking", () => {
    expect(source).toContain("annotationFilters");
    expect(source).toContain("filterAnnotations(annotations");
    expect(source).toContain("continuousAnnotationMode");
    expect(combinedSource).toContain("连续标注");
    expect(source).toContain("setAnnotationTool(\"select\")");
    expect(source).toContain("!continuousAnnotationMode");
  });

  it("creates drawing annotations with a draw-then-comment popover flow", () => {
    expect(source).toContain("AnnotationDraftPopover");
    expect(source).toContain("pendingAnnotationDraft");
    expect(source).toContain("onConfirmDraftAnnotation");
    expect(source).toContain("draftStyles.popover");
    expect(source).toContain("普通说明");
    expect(source).toContain("正式问题");
    expect(source).not.toContain("先写说明，再在左侧图纸上放置批注");
  });

  it("keeps annotation drawing tools next to the PDF canvas", () => {
    const toolbarStart = source.indexOf("annotationToolbarItems");
    const toolbarEnd = source.indexOf("const annotationColors", toolbarStart);
    const toolbarSource = toolbarStart === -1 || toolbarEnd === -1 ? "" : source.slice(toolbarStart, toolbarEnd);

    expect(source).toContain("className={toolbarStyles.bar}");
    expect(source).toContain('aria-label="PDF 批注工具"');
    for (const label of ["选择", "定位", "箭头", "矩形", "圆形", "文字", "画笔", "云线", "删除"]) {
      expect(toolbarSource).toContain(label);
    }
  });

  it("uses icons and custom colors in the PDF annotation toolbar", () => {
    expect(source).toContain("lucide-react");
    expect(source).toContain("Check");
    expect(source).toContain("Palette");
    expect(source).toContain("annotationCustomColor");
    expect(source).toContain('type="color"');
    expect(source).toContain("className={toolbarStyles.colors}");
    expect(source).toContain("className={toolbarStyles.swatch}");
    expect(source).toContain('aria-pressed={color === item.color}');
    expect(source).toContain("className={toolbarStyles.customWell}");
    expect(source).toContain("annotationColorTone(customColor)");
    expect(source).toContain("annotationStyleJsonForColor(annotationColor, annotationCustomColor)");
    expect(source).toContain("Icon: MousePointer2");
    expect(source).toContain("className={toolbarStyles.label}");
  });

  it("shows the selected annotation message on the drawing", () => {
    expect(layerSource).toContain("styles.callout");
    expect(layerSource).toContain("selected &&");
    expect(layerSource).toContain("{annotation.message}");
    expect(layerSource).toContain("annotationToneStyle(annotation)");
  });

  it("selects an annotation from the list and scrolls it into view on the PDF", () => {
    expect(workspaceSource).toContain("scrollAnnotationIntoView");
    expect(layerSource).toContain("data-annotation-id");
    expect(source).toContain("selectedAnnotationId={selectedAnnotationId}");
    expect(source).toContain("selectAnnotation(annotation, { scrollIntoView: true })");
  });

  it("offers a guarded reset action for annotated review PDFs", () => {
    const annotationPanelStart = annotationSidePanelSource.indexOf("className={styles.root}");
    const annotationListStart = annotationSidePanelSource.indexOf("<ul className={styles.list}", annotationPanelStart);
    const annotationPanelHeader =
      annotationPanelStart === -1 || annotationListStart === -1 ? "" : annotationSidePanelSource.slice(annotationPanelStart, annotationListStart);

    expect(source).toContain("resetApprovalAnnotations");
    expect(source).toContain("async function resetAnnotations()");
    expect(source).toContain("window.confirm");
    expect(source).toContain("确定回退到初始版吗");
    expect(source).toContain("已回退到初始版，批注已清空。");
    expect(combinedSource).toContain('busyAction === "annotations-reset"');
    expect(source).toContain("setSelectedAnnotationId(null)");
    expect(source).toContain("refreshAnnotationTrace(approval.id)");
    expect(source).toContain("getAnnotatedFileUrl(approval.id");
    expect(annotationPanelHeader).toContain("annotatedFileUrl");
    expect(annotationPanelHeader).toContain("onResetAnnotations");
    expect(annotationPanelHeader).toContain("回退到初始版");
  });

  it("shows clear annotation empty, readonly, designer, and failure copy", () => {
    expect(combinedSource).toContain("暂无图纸批注，审核人可在左侧 PDF 上直接标记问题。");
    expect(source).toContain("当前图纸已归档或作废，批注仅可查看。");
    expect(source).toContain("设计师可查看并处理批注，不能新增审核批注。");
    expect(source).toContain("批注保存失败，请检查网络后重试。");
  });
});
