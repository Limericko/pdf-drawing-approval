import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowUpRight,
  Check,
  Circle,
  Cloud,
  MapPin,
  MousePointer2,
  Palette,
  Pencil,
  Printer,
  Square,
  Trash2,
  Type,
  type LucideIcon
} from "lucide-react";
import {
  createApprovalComment,
  createApprovalAnnotation,
  deleteApprovalAnnotation,
  getApproval,
  getAnnotatedFileUrl,
  getApprovalFileUrl,
  getSignedFileUrl,
  listApprovalAnnotations,
  listApprovalComments,
  listApprovalOperationLogs,
  listSignaturePlacements,
  markPrinted,
  rebindApprovalFile,
  resetApprovalAnnotations,
  resolveApprovalAnnotation,
  resolveApprovalComment,
  retryGenerateSignedPdf,
  retryApprovalValidation,
  saveApprovalPlacementsAsTemplate,
  saveSignaturePlacements,
  submitReview,
  updateApprovalAnnotation,
  voidApproval,
  type Approval,
  type ApprovalAnnotation,
  type ApprovalAnnotationColor,
  type ApprovalAnnotationInput,
  type ApprovalComment,
  type SignaturePlacement,
  type OperationLog,
  type User
} from "../api.ts";
import {
  getDesktopPrintSettings,
  isDesktopClient,
  listDesktopPrinters,
  persistDesktopPrintSettings,
  printSignedPdfWithDesktop
} from "../clientConfig.ts";
import {
  defaultPrintSettings,
  parsePageRanges,
  sanitizePrintSettings,
  toDesktopPrintOptions,
  type DesktopPrinter,
  type PrintSettings
} from "../printSettings.ts";
import { defaultSignaturePlacements } from "../widgets/SignaturePlacementEditor.tsx";
import type { AnnotationDraftAnchor } from "../widgets/PdfAnnotationLayer.tsx";
import type { AnnotationTool } from "../widgets/PdfAnnotationWorkspace.tsx";
import { statusLabel } from "../widgets/status.ts";
import { StatusChip } from "../widgets/StatusChip.tsx";
import { AnnotationSidePanel } from "./approvalDetail/AnnotationSidePanel.tsx";
import { FloatingSupportPanel, type SupportTab } from "./approvalDetail/FloatingSupportPanel.tsx";
import { SignaturePanel } from "./approvalDetail/SignaturePanel.tsx";
import {
  canRegenerateSignedPdf,
  canCreateAnnotation,
  canEditAnnotation,
  canEditSignaturePlacements,
  canSaveSignatureTemplate,
  canShowAnnotations,
  canShowSignaturePlacementPanel,
  detailReloadErrorMessage,
  filterAnnotations,
  relatedVersionsForPanel,
  shouldRefreshPdfState,
  signaturePlacementSaveMessage,
  timelinePreviewLimit,
  visibleOperationLogs,
  type AnnotationFilterState
} from "./approvalDetailLogic.ts";
import {
  canUseNativePrintForApproval,
  printFailureMessage,
  shouldArchiveAfterDesktopPrint
} from "./approvalDetailPrint.ts";

type AnnotationFilters = Omit<AnnotationFilterState, "currentUserId">;
type PendingAnnotationDraft = {
  input: ApprovalAnnotationInput;
  left: number;
  top: number;
};

const PdfAnnotationWorkspace = lazy(() =>
  import("../widgets/PdfAnnotationWorkspace.tsx").then((module) => ({ default: module.PdfAnnotationWorkspace }))
);
const PdfSignaturePlacementWorkspace = lazy(() =>
  import("../widgets/PdfSignaturePlacementWorkspace.tsx").then((module) => ({ default: module.PdfSignaturePlacementWorkspace }))
);

export function ApprovalDetailPage({ id, user }: { id: number; user: User }) {
  const detailPdfStageRef = useRef<HTMLDivElement | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [operationLogs, setOperationLogs] = useState<OperationLog[]>([]);
  const [approvalComments, setApprovalComments] = useState<ApprovalComment[]>([]);
  const [annotations, setAnnotations] = useState<ApprovalAnnotation[]>([]);
  const [reviewComment, setReviewComment] = useState("");
  const [annotationMessage, setAnnotationMessage] = useState("");
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>("select");
  const [annotationColor, setAnnotationColor] = useState<ApprovalAnnotationColor>("red");
  const [annotationCustomColor, setAnnotationCustomColor] = useState("#7c3aed");
  const [annotationFilters, setAnnotationFilters] = useState<AnnotationFilters>({
    status: "all",
    author: "all",
    kind: "all"
  });
  const [continuousAnnotationMode, setContinuousAnnotationMode] = useState(false);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<number | null>(null);
  const [annotationScrollRequest, setAnnotationScrollRequest] = useState(0);
  const [pendingAnnotationDraft, setPendingAnnotationDraft] = useState<PendingAnnotationDraft | null>(null);
  const [draftAnnotationMessage, setDraftAnnotationMessage] = useState("");
  const [collaborationMessage, setCollaborationMessage] = useState("");
  const [collaborationKind, setCollaborationKind] = useState<"comment" | "issue">("comment");
  const [repairPath, setRepairPath] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const [signaturePlacements, setSignaturePlacements] = useState<SignaturePlacement[]>(() => defaultSignaturePlacements());
  const [placementEditing, setPlacementEditing] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [supportTab, setSupportTab] = useState<SupportTab>("comments");
  const [activeSupportPanel, setActiveSupportPanel] = useState<SupportTab | null>(null);
  const [floatingPanelPosition, setFloatingPanelPosition] = useState({ x: 320, y: 120 });
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [printSettings, setPrintSettings] = useState<PrintSettings>(() => defaultPrintSettings());
  const [printers, setPrinters] = useState<DesktopPrinter[]>([]);
  const [printError, setPrintError] = useState("");
  const [savingPlacements, setSavingPlacements] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [pdfState, setPdfState] = useState<"checking" | "ready" | "invalid" | "missing">("checking");
  const desktopClient = isDesktopClient();

  async function reload(isCurrent = () => true) {
    setError("");
    const [next, logs, comments, placements, annotations] = await Promise.all([
      getApproval(id),
      listApprovalOperationLogs(id),
      listApprovalComments(id),
      listSignaturePlacements(id),
      listApprovalAnnotations(id)
    ]);
    if (!isCurrent()) return;
    setApproval(next);
    setTemplateName((current) => current || `${next.projectName}-${next.partName}`);
    setOperationLogs(logs);
    setApprovalComments(comments);
    setAnnotations(annotations);
    setSignaturePlacements(placements.length > 0 ? placements : defaultSignaturePlacements());
    setRepairPath((current) => current || next.currentFilePath);
    await checkPdf(next.id, isCurrent);
  }

  useEffect(() => {
    let active = true;
    reload(() => active).catch((err) => {
      if (active) setError(detailReloadErrorMessage(err));
    });
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    if (!desktopClient) return;
    let active = true;
    Promise.all([listDesktopPrinters(), getDesktopPrintSettings()])
      .then(([nextPrinters, nextSettings]) => {
        if (!active) return;
        const defaultPrinter = nextPrinters.find((printer) => printer.isDefault);
        setPrinters(nextPrinters);
        setPrintSettings(
          sanitizePrintSettings({
            ...nextSettings,
            printerName: nextSettings.printerName || defaultPrinter?.name || ""
          })
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [desktopClient]);

  async function review(decision: "approved" | "rejected") {
    if (user.role !== "supervisor" && user.role !== "process") return;
    setError("");
    if (decision === "rejected" && !reviewComment.trim() && !annotations.some((annotation) => !annotation.resolved)) {
      setError("驳回时请填写意见，或先在图纸上添加批注。");
      return;
    }
    try {
      const next = await submitReview(id, user.role, decision, reviewComment);
      await afterApprovalChanged(next, decision === "approved" ? "审核已通过。" : "审核已驳回。");
      setReviewComment("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    }
  }

  async function afterApprovalChanged(next: Approval, nextMessage: string) {
    const previous = approval;
    setApproval(next);
    setMessage(nextMessage);
    const [logs, comments, annotations] = await Promise.all([
      listApprovalOperationLogs(next.id),
      listApprovalComments(next.id),
      listApprovalAnnotations(next.id)
    ]);
    setOperationLogs(logs);
    setApprovalComments(comments);
    setAnnotations(annotations);
    if (shouldRefreshPdfState(previous, next)) {
      await checkPdf(next.id);
    }
  }

  async function submitCollaboration() {
    if (!approval || !collaborationMessage.trim()) return;
    setBusyAction("comment");
    setError("");
    setMessage("");
    try {
      await createApprovalComment(approval.id, { kind: collaborationKind, message: collaborationMessage });
      setCollaborationMessage("");
      setCollaborationKind("comment");
      setMessage(collaborationKind === "issue" ? "问题已记录。" : "评论已记录。");
      const [logs, comments] = await Promise.all([listApprovalOperationLogs(approval.id), listApprovalComments(approval.id)]);
      setOperationLogs(logs);
      setApprovalComments(comments);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交评论失败");
    } finally {
      setBusyAction("");
    }
  }

  async function resolveIssue(commentId: number) {
    if (!approval) return;
    setBusyAction(`resolve-${commentId}`);
    setError("");
    setMessage("");
    try {
      await resolveApprovalComment(approval.id, commentId);
      setMessage("问题已标记解决。");
      const [logs, comments] = await Promise.all([listApprovalOperationLogs(approval.id), listApprovalComments(approval.id)]);
      setOperationLogs(logs);
      setApprovalComments(comments);
    } catch (err) {
      setError(err instanceof Error ? err.message : "解决问题失败");
    } finally {
      setBusyAction("");
    }
  }

  function updatePrintSettings(patch: Partial<PrintSettings>) {
    setPrintSettings((current) => sanitizePrintSettings({ ...current, ...patch }));
  }

  async function printAndArchive() {
    if (!approval) return;
    setBusyAction("print");
    setError("");
    setMessage("");
    setPrintError("");
    try {
      parsePageRanges(printSettings.pageRange);
      const savedSettings = await persistDesktopPrintSettings(printSettings);
      const result = await printSignedPdfWithDesktop(
        getSignedFileUrl(approval.id, signedPdfCacheKey),
        toDesktopPrintOptions(savedSettings)
      );
      if (!shouldArchiveAfterDesktopPrint(result)) {
        setPrintError(printFailureMessage(result.failureReason));
        return;
      }
      const next = await markPrinted(id);
      setPrintDialogOpen(false);
      await afterApprovalChanged(next, "打印任务已提交，图纸已自动归档。");
    } catch (err) {
      setPrintError(printFailureMessage(err instanceof Error ? err.message : undefined));
    } finally {
      setBusyAction((current) => (current === "print" ? "" : current));
    }
  }

  async function refreshAnnotationTrace(approvalId: number) {
    const [logs, nextAnnotations] = await Promise.all([
      listApprovalOperationLogs(approvalId),
      listApprovalAnnotations(approvalId)
    ]);
    setOperationLogs(logs);
    setAnnotations(nextAnnotations);
    return nextAnnotations;
  }

  function startAnnotationDraft(input: ApprovalAnnotationInput, anchor: AnnotationDraftAnchor) {
    const stageRect = detailPdfStageRef.current?.getBoundingClientRect();
    const left = stageRect ? clamp(anchor.clientX - stageRect.left + 10, 12, Math.max(12, stageRect.width - 340)) : 18;
    const top = stageRect ? clamp(anchor.clientY - stageRect.top + 10, 56, Math.max(56, stageRect.height - 250)) : 72;

    setPendingAnnotationDraft({ input, left, top });
    setDraftAnnotationMessage("");
    setError("");
    setMessage("");
  }

  async function onConfirmDraftAnnotation() {
    if (!pendingAnnotationDraft) return;
    if (!approval) return;
    const message = draftAnnotationMessage.trim();
    if (!message) {
      setError("请先填写批注内容。");
      return;
    }
    setBusyAction("annotation");
    setError("");
    setMessage("");
    try {
      const created = await createApprovalAnnotation(approval.id, { ...pendingAnnotationDraft.input, message });
      setMessage("图纸批注已添加。");
      setSelectedAnnotationId(created.id);
      setAnnotationScrollRequest((current) => current + 1);
      if (!continuousAnnotationMode) setAnnotationTool("select");
      setPendingAnnotationDraft(null);
      setDraftAnnotationMessage("");
      await refreshAnnotationTrace(approval.id);
    } catch (err) {
      setError(err instanceof Error && err.message ? `批注保存失败，请检查网络后重试。${err.message}` : "批注保存失败，请检查网络后重试。");
    } finally {
      setBusyAction("");
    }
  }

  function cancelDraftAnnotation() {
    setPendingAnnotationDraft(null);
    setDraftAnnotationMessage("");
  }

  function selectAnnotation(annotation: ApprovalAnnotation, options: { scrollIntoView?: boolean } = {}) {
    setSelectedAnnotationId(annotation.id);
    setAnnotationTool(annotation.kind);
    setAnnotationColor(annotation.color);
    if (annotation.color === "custom") {
      setAnnotationCustomColor(readAnnotationStrokeColor(annotation.styleJson) ?? annotationCustomColor);
    }
    setAnnotationMessage(annotation.message);
    if (options.scrollIntoView) {
      setAnnotationScrollRequest((current) => current + 1);
    }
  }

  async function updateSelectedAnnotation() {
    if (!approval || !selectedAnnotation) return;
    const message = annotationMessage.trim();
    if (!message) {
      setError("批注内容不能为空。");
      return;
    }
    setBusyAction(`annotation-update-${selectedAnnotation.id}`);
    setError("");
    setMessage("");
    try {
      const updated = await updateApprovalAnnotation(approval.id, selectedAnnotation.id, {
        kind: selectedAnnotation.kind,
        message,
        pageNumber: selectedAnnotation.pageNumber,
        xRatio: selectedAnnotation.xRatio,
        yRatio: selectedAnnotation.yRatio,
        widthRatio: selectedAnnotation.widthRatio,
        heightRatio: selectedAnnotation.heightRatio,
        endXRatio: selectedAnnotation.endXRatio,
        endYRatio: selectedAnnotation.endYRatio,
        pointsJson: selectedAnnotation.pointsJson,
        styleJson: annotationStyleJsonForColor(annotationColor, annotationCustomColor, selectedAnnotation.styleJson),
        color: annotationColor
      });
      setMessage("图纸批注已更新。");
      setSelectedAnnotationId(updated.id);
      setAnnotationColor(updated.color);
      if (updated.color === "custom") {
        setAnnotationCustomColor(readAnnotationStrokeColor(updated.styleJson) ?? annotationCustomColor);
      }
      await refreshAnnotationTrace(approval.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "批注更新失败");
    } finally {
      setBusyAction("");
    }
  }

  async function updateAnnotationGeometry(annotation: ApprovalAnnotation, input: ApprovalAnnotationInput) {
    if (!approval || !canEditAnnotation(user, approval, annotation)) return;
    setBusyAction(`annotation-update-${annotation.id}`);
    setError("");
    setMessage("");
    try {
      const updated = await updateApprovalAnnotation(approval.id, annotation.id, {
        ...input,
        message: annotation.message,
        color: input.color ?? annotation.color,
        styleJson: input.styleJson ?? annotation.styleJson
      });
      setMessage("图纸批注位置已更新。");
      setSelectedAnnotationId(updated.id);
      setAnnotationTool("select");
      setAnnotationColor(updated.color);
      if (updated.color === "custom") {
        setAnnotationCustomColor(readAnnotationStrokeColor(updated.styleJson) ?? annotationCustomColor);
      }
      setAnnotationMessage(updated.message);
      await refreshAnnotationTrace(approval.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "批注位置更新失败");
    } finally {
      setBusyAction("");
    }
  }

  async function resolveAnnotation(annotationId: number) {
    if (!approval) return;
    setBusyAction(`annotation-resolve-${annotationId}`);
    setError("");
    setMessage("");
    try {
      await resolveApprovalAnnotation(approval.id, annotationId);
      setMessage("图纸批注已标记处理。");
      await refreshAnnotationTrace(approval.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "批注处理失败");
    } finally {
      setBusyAction("");
    }
  }

  async function removeAnnotation(annotationId: number) {
    if (!approval) return;
    setBusyAction(`annotation-delete-${annotationId}`);
    setError("");
    setMessage("");
    try {
      await deleteApprovalAnnotation(approval.id, annotationId);
      setMessage("图纸批注已删除。");
      setSelectedAnnotationId((current) => (current === annotationId ? null : current));
      await refreshAnnotationTrace(approval.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "批注删除失败");
    } finally {
      setBusyAction("");
    }
  }

  async function resetAnnotations() {
    if (!approval) return;
    if (!window.confirm("确定回退到初始版吗？这会清空当前图纸的所有批注，原始 PDF 和签后 PDF 不受影响。")) return;
    setBusyAction("annotations-reset");
    setError("");
    setMessage("");
    try {
      const result = await resetApprovalAnnotations(approval.id);
      setSelectedAnnotationId(null);
      setAnnotationMessage("");
      setAnnotationTool("select");
      setPendingAnnotationDraft(null);
      setDraftAnnotationMessage("");
      setMessage(result.deletedCount > 0 ? "已回退到初始版，批注已清空。" : "当前没有需要回退的批注。");
      await refreshAnnotationTrace(approval.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "回退初始版失败");
    } finally {
      setBusyAction("");
    }
  }

  async function runRepair(action: "rebind" | "retry" | "void") {
    if (!approval) return;
    setError("");
    setMessage("");
    setBusyAction(action);
    try {
      const next =
        action === "rebind"
          ? await rebindApprovalFile(approval.id, repairPath)
          : action === "retry"
            ? await retryApprovalValidation(approval.id)
            : await voidApproval(approval.id, voidReason);
      await afterApprovalChanged(next, action === "void" ? "图纸已作废。" : "图纸记录已修复，已回到待审核。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyAction("");
    }
  }

  async function retrySigning() {
    if (!approval) return;
    setError("");
    setMessage("");
    setBusyAction("sign");
    try {
      const next = await retryGenerateSignedPdf(approval.id);
      await afterApprovalChanged(
        next,
        next.signatureStatus === "generated" ? "签后 PDF 已重新生成。" : "已重新尝试生成签后 PDF，请查看签名状态。"
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "签名生成失败");
    } finally {
      setBusyAction("");
    }
  }

  async function savePlacements() {
    if (!approval) return;
    setError("");
    setMessage("");
    setSavingPlacements(true);
    try {
      const previous = approval;
      const result = await saveSignaturePlacements(approval.id, signaturePlacements);
      setApproval(result.approval);
      setSignaturePlacements(result.placements.length > 0 ? result.placements : defaultSignaturePlacements());
      setMessage(signaturePlacementSaveMessage(result.approval));
      setPlacementEditing(false);
      const [logs, comments, annotations] = await Promise.all([
        listApprovalOperationLogs(result.approval.id),
        listApprovalComments(result.approval.id),
        listApprovalAnnotations(result.approval.id)
      ]);
      setOperationLogs(logs);
      setApprovalComments(comments);
      setAnnotations(annotations);
      if (shouldRefreshPdfState(previous, result.approval)) {
        await checkPdf(result.approval.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "签名位置保存失败");
    } finally {
      setSavingPlacements(false);
    }
  }

  async function savePlacementsAsTemplate() {
    if (!approval) return;
    const name = templateName.trim();
    if (!name) {
      setError("请输入模板名称");
      return;
    }
    setError("");
    setMessage("");
    setSavingTemplate(true);
    try {
      const template = await saveApprovalPlacementsAsTemplate(approval.id, {
        name,
        projectName: approval.projectName
      });
      setMessage(`签名模板“${template.name}”已保存。`);
      setTemplateName(template.name);
      setOperationLogs(await listApprovalOperationLogs(approval.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存签名模板失败");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function checkPdf(approvalId: number, isCurrent = () => true) {
    setPdfState("checking");
    try {
      const response = await fetch(getApprovalFileUrl(approvalId), { method: "HEAD", cache: "no-store" });
      if (!isCurrent()) return;
      if (response.status === 422) {
        setPdfState("invalid");
        return;
      }
      if (response.status === 404) {
        setPdfState("missing");
        return;
      }
      setPdfState(response.ok ? "ready" : "invalid");
    } catch (err) {
      if (!isCurrent()) return;
      setPdfState("invalid");
      setError(err instanceof Error ? `PDF 状态检查失败：${err.message}` : "PDF 状态检查失败，请稍后重试。");
    }
  }

  function openSupportPanel(nextPanel: SupportTab) {
    setSupportTab(nextPanel);
    setActiveSupportPanel(nextPanel);
    setFloatingPanelPosition((current) => {
      const preferred = window.innerWidth <= 680 ? { x: 12, y: 72 } : current;
      return {
        x: Math.min(Math.max(12, preferred.x), Math.max(12, window.innerWidth - 360)),
        y: Math.min(Math.max(12, preferred.y), Math.max(12, window.innerHeight - 120))
      };
    });
  }

  function startFloatingPanelDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const origin = floatingPanelPosition;

    function onPointerMove(moveEvent: PointerEvent) {
      const maxX = Math.max(12, window.innerWidth - 360);
      const maxY = Math.max(12, window.innerHeight - 120);
      setFloatingPanelPosition({
        x: Math.min(Math.max(12, origin.x + moveEvent.clientX - startX), maxX),
        y: Math.min(Math.max(12, origin.y + moveEvent.clientY - startY), maxY)
      });
    }

    function onPointerUp() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  if (!approval) {
    return <div className="empty">{error || "加载中"}</div>;
  }

  const signatureRequired = approval.signatureStatus !== "not_required";
  const signedPdfReady = approval.signatureStatus === "generated" && Boolean(approval.signedFilePath);
  const signedPdfCacheKey = approval.signedFileHash ?? approval.signedAt ?? "";
  const canMarkPrinted = !signatureRequired || signedPdfReady;
  const canNativePrint = canUseNativePrintForApproval(user, approval, signedPdfReady, desktopClient);
  const canEditPlacements = canEditSignaturePlacements(user, approval);
  const canSaveTemplate = canSaveSignatureTemplate(user);
  const canRegenerateSigned = canRegenerateSignedPdf(user, approval);
  const showPlacementPanel = canShowSignaturePlacementPanel(user, approval);
  const showAnnotations = canShowAnnotations(approval);
  const canCreateAnnotations = canCreateAnnotation(user, approval);
  const annotationReadonlyMessage = annotationReadonlyCopy(user, approval);
  const annotationStyleJson = annotationStyleJsonForColor(annotationColor, annotationCustomColor);
  const openAnnotationCount = annotations.filter((annotation) => !annotation.resolved).length;
  const filteredAnnotations = filterAnnotations(annotations, {
    ...annotationFilters,
    currentUserId: user.id
  });
  const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null;
  const annotationCacheKey = annotations
    .map((annotation) => `${annotation.id}:${annotation.updatedAt}:${annotation.resolved ? 1 : 0}`)
    .join("|");
  const historyItems = relatedVersionsForPanel(approval);
  const visibleLogs = visibleOperationLogs(operationLogs, timelineExpanded);
  const hiddenLogCount = Math.max(0, operationLogs.length - timelinePreviewLimit);
  const supportPanelTitles: Record<SupportTab, string> = {
    comments: "协同记录",
    timeline: "操作时间线",
    history: "同零件其它版本"
  };

  return (
    <section>
      <div className="page-heading row">
        <div>
          <span className="eyebrow">DRAWING REVIEW</span>
          <h1>{approval.projectName} / {approval.partName}</h1>
          <p>{approval.version} · {statusLabel(approval.status)}</p>
        </div>
        <div className="heading-actions">
          <StatusChip status={approval.status} />
          <StatusChip status={approval.signatureStatus} context="signature" />
          <a className="button-link secondary-link" href="#/approvals">返回列表</a>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}
      <div className="drawing-meta-strip">
        <div>
          <span>项目</span>
          <strong>{approval.projectName}</strong>
        </div>
        <div>
          <span>零件</span>
          <strong>{approval.partName}</strong>
        </div>
        <div>
          <span>版本</span>
          <strong>{approval.version}</strong>
        </div>
        <div>
          <span>提交时间</span>
          <strong>{new Date(approval.submittedAt).toLocaleString()}</strong>
        </div>
        <div>
          <span>来源</span>
          <strong>{approval.source === "web_upload" ? "网页提交" : "目录监听"}</strong>
        </div>
      </div>
      <div className="detail-layout">
        <div className="detail-pdf-stage" ref={detailPdfStageRef}>
          {pdfState === "ready" ? (
            <Suspense fallback={<div className="pdf-frame pdf-frame--message">正在加载 PDF 工具...</div>}>
              {placementEditing ? (
                <PdfSignaturePlacementWorkspace
                  pdfUrl={getApprovalFileUrl(approval.id)}
                  placements={signaturePlacements}
                  onChange={setSignaturePlacements}
                />
              ) : (
                <>
                  {canCreateAnnotations && (
                    <AnnotationToolbar
                      tool={annotationTool}
                      color={annotationColor}
                      customColor={annotationCustomColor}
                      canDeleteSelected={Boolean(selectedAnnotation && canEditAnnotation(user, approval, selectedAnnotation))}
                      deleteBusy={selectedAnnotation ? busyAction === `annotation-delete-${selectedAnnotation.id}` : false}
                      onToolChange={(nextTool) => {
                        setAnnotationTool(nextTool);
                        if (nextTool !== "select") setPendingAnnotationDraft(null);
                      }}
                      onColorChange={setAnnotationColor}
                      onCustomColorChange={(nextColor) => {
                        setAnnotationCustomColor(nextColor);
                        setAnnotationColor("custom");
                      }}
                      onDeleteSelected={() => {
                        if (selectedAnnotation) void removeAnnotation(selectedAnnotation.id);
                      }}
                    />
                  )}
                  <PdfAnnotationWorkspace
                    pdfUrl={getApprovalFileUrl(approval.id)}
                    annotations={annotations}
                    tool={canCreateAnnotations ? annotationTool : "select"}
                    color={annotationColor}
                    styleJson={annotationStyleJson}
                    draftMessage="待填写批注内容"
                    readOnly={!canCreateAnnotations}
                    onDraftAnnotation={startAnnotationDraft}
                    onSelectAnnotation={selectAnnotation}
                    selectedAnnotationId={selectedAnnotationId}
                    annotationScrollRequest={annotationScrollRequest}
                    onUpdateAnnotationGeometry={canCreateAnnotations ? updateAnnotationGeometry : undefined}
                  />
                  {pendingAnnotationDraft && (
                    <AnnotationDraftPopover
                      left={pendingAnnotationDraft.left}
                      top={pendingAnnotationDraft.top}
                      message={draftAnnotationMessage}
                      busy={busyAction === "annotation"}
                      onMessageChange={setDraftAnnotationMessage}
                      onConfirmDraftAnnotation={onConfirmDraftAnnotation}
                      onCancel={cancelDraftAnnotation}
                    />
                  )}
                </>
              )}
            </Suspense>
          ) : (
            <div className="pdf-frame pdf-frame--message">
              {pdfState === "checking" && <strong>正在检查 PDF 文件...</strong>}
              {pdfState === "invalid" && (
                <>
                  <strong>文件不是有效 PDF，无法预览</strong>
                  <p>文件扩展名是 .pdf，但内容没有标准 PDF 文件头。请检查坚果云是否已完成同步，或从 CAD 软件重新导出 PDF 后再提交。</p>
                  <code>{approval.currentFilePath}</code>
                  <button type="button" className="secondary-button" onClick={() => checkPdf(approval.id)}>
                    重新检查 PDF
                  </button>
                </>
              )}
              {pdfState === "missing" && (
                <>
                  <strong>文件不存在，无法预览</strong>
                  <p>数据库记录中的文件路径在服务器电脑上不存在，请检查文件是否被移动、删除或坚果云尚未同步。</p>
                  <code>{approval.currentFilePath}</code>
                  <button type="button" className="secondary-button" onClick={() => checkPdf(approval.id)}>
                    重新检查 PDF
                  </button>
                </>
              )}
            </div>
          )}
          </div>
        <aside className="side-panel">
          <h2>审核与签审</h2>
          <div className="status-summary">
            <div>
              <span>主管</span>
              <StatusChip status={approval.supervisorStatus} />
            </div>
            <div>
              <span>工艺</span>
              <StatusChip status={approval.processStatus} />
            </div>
          </div>
          <div className="support-launcher" aria-label="协同与追溯">
            <button type="button" className="secondary-button" onClick={() => openSupportPanel("comments")}>
              协同记录 <span>{approvalComments.length}</span>
            </button>
            <button type="button" className="secondary-button" onClick={() => openSupportPanel("timeline")}>
              操作时间线 <span>{operationLogs.length}</span>
            </button>
            <button type="button" className="secondary-button" onClick={() => openSupportPanel("history")}>
              其它版本 <span>{historyItems.length}</span>
            </button>
          </div>
          {showAnnotations && (
            <AnnotationSidePanel
              approval={approval}
              user={user}
              annotations={annotations}
              filteredAnnotations={filteredAnnotations}
              selectedAnnotation={selectedAnnotation}
              annotationMessage={annotationMessage}
              annotationFilters={annotationFilters}
              annotationReadonlyMessage={annotationReadonlyMessage}
              annotationCacheKey={annotationCacheKey}
              annotatedFileUrl={getAnnotatedFileUrl(approval.id, annotationCacheKey)}
              openAnnotationCount={openAnnotationCount}
              canCreateAnnotations={canCreateAnnotations}
              continuousAnnotationMode={continuousAnnotationMode}
              busyAction={busyAction}
              onContinuousAnnotationModeChange={setContinuousAnnotationMode}
              onAnnotationMessageChange={setAnnotationMessage}
              onUpdateSelectedAnnotation={updateSelectedAnnotation}
              onCancelSelectedAnnotation={() => {
                setSelectedAnnotationId(null);
                setAnnotationMessage("");
                setAnnotationTool("select");
              }}
              onFilterChange={setAnnotationFilters}
              onSelectAnnotation={(annotation) => selectAnnotation(annotation, { scrollIntoView: true })}
              onResolveAnnotation={resolveAnnotation}
              onRemoveAnnotation={removeAnnotation}
              onResetAnnotations={resetAnnotations}
            />
          )}
          <SignaturePanel
            approval={approval}
            signedPdfReady={signedPdfReady}
            signedPdfCacheKey={signedPdfCacheKey}
            signatureRequired={signatureRequired}
            canRegenerateSigned={canRegenerateSigned}
            busyAction={busyAction}
            showPlacementPanel={showPlacementPanel}
            placementEditing={placementEditing}
            signaturePlacements={signaturePlacements}
            canEditPlacements={canEditPlacements}
            canSaveTemplate={canSaveTemplate}
            pdfReady={pdfState === "ready"}
            savingPlacements={savingPlacements}
            savingTemplate={savingTemplate}
            templateName={templateName}
            onRetrySigning={retrySigning}
            onTogglePlacementEditing={() => setPlacementEditing((current) => !current)}
            onResetPlacements={() => {
              setSignaturePlacements(defaultSignaturePlacements());
              setPlacementEditing(true);
            }}
            onSavePlacements={savePlacements}
            onTemplateNameChange={setTemplateName}
            onSaveTemplate={savePlacementsAsTemplate}
          />
          <dl>
            <dt>主管</dt>
            <dd>{statusLabel(approval.supervisorStatus)} {approval.supervisorComment && `- ${approval.supervisorComment}`}</dd>
            <dt>工艺</dt>
            <dd>{statusLabel(approval.processStatus)} {approval.processComment && `- ${approval.processComment}`}</dd>
          </dl>
          {(user.role === "supervisor" || user.role === "process") && approval.status === "pending" && (
            <div className="review-box">
              <h2>我的审核</h2>
              <textarea value={reviewComment} onChange={(event) => setReviewComment(event.target.value)} placeholder="审核意见，驳回时必填" />
              <div className="actions">
                <button type="button" onClick={() => review("approved")}>通过</button>
                <button type="button" className="danger" onClick={() => review("rejected")}>驳回</button>
              </div>
            </div>
          )}
          {(user.role === "designer" || user.role === "admin") && approval.status === "approved_for_print" && (
            <div className="print-action-box">
              {canNativePrint && (
                <button type="button" onClick={() => setPrintDialogOpen(true)} disabled={!canMarkPrinted}>
                  <Printer size={16} strokeWidth={2.2} aria-hidden="true" />
                  打印并归档
                </button>
              )}
              <button
                type="button"
                className={canNativePrint ? "secondary-button" : undefined}
                disabled={!canMarkPrinted}
                onClick={() => markPrinted(id).then((next) => afterApprovalChanged(next, "图纸已标记为打印归档。")).catch((err) => setError(err.message))}
              >
                {canNativePrint ? "仅标记已打印归档" : "标记已打印归档"}
              </button>
              {!canMarkPrinted && <span>签后 PDF 未生成，归档操作已暂时禁用。</span>}
              {!desktopClient && canMarkPrinted && <span>浏览器模式不能直接调用系统打印，请先打开签后 PDF 打印后再手动归档。</span>}
            </div>
          )}
          {user.role === "admin" && isRepairable(approval.status) && (
            <div className="review-box repair-box">
              <h2>异常处理</h2>
              {(approval.status === "file_missing" || approval.status === "invalid_pdf") && (
                <label>
                  服务器 PDF 路径
                  <input value={repairPath} onChange={(event) => setRepairPath(event.target.value)} />
                </label>
              )}
              {approval.status === "file_missing" && (
                <button type="button" onClick={() => runRepair("rebind")} disabled={busyAction === "rebind"}>
                  {busyAction === "rebind" ? "处理中" : "重新绑定文件"}
                </button>
              )}
              {approval.status === "invalid_pdf" && (
                <div className="actions">
                  <button type="button" onClick={() => runRepair("rebind")} disabled={busyAction === "rebind"}>
                    {busyAction === "rebind" ? "处理中" : "替换 PDF"}
                  </button>
                  <button type="button" className="secondary-button" onClick={() => runRepair("retry")} disabled={busyAction === "retry"}>
                    {busyAction === "retry" ? "校验中" : "重新校验"}
                  </button>
                </div>
              )}
              <label>
                作废原因
                <input value={voidReason} onChange={(event) => setVoidReason(event.target.value)} placeholder="例如提交错版本" />
              </label>
              <button type="button" className="danger" onClick={() => runRepair("void")} disabled={!voidReason.trim() || busyAction === "void"}>
                {busyAction === "void" ? "作废中" : "作废"}
              </button>
            </div>
          )}
        </aside>
      </div>
      {activeSupportPanel && (
        <FloatingSupportPanel
          activeTab={activeSupportPanel}
          title={supportPanelTitles[activeSupportPanel]}
          position={floatingPanelPosition}
          supportTab={supportTab}
          collaborationKind={collaborationKind}
          collaborationMessage={collaborationMessage}
          busyAction={busyAction}
          approvalComments={approvalComments}
          operationLogs={operationLogs}
          visibleLogs={visibleLogs}
          hiddenLogCount={hiddenLogCount}
          timelineExpanded={timelineExpanded}
          historyItems={historyItems}
          onStartDrag={startFloatingPanelDrag}
          onClose={() => setActiveSupportPanel(null)}
          onCollaborationKindChange={setCollaborationKind}
          onCollaborationMessageChange={setCollaborationMessage}
          onSubmitCollaboration={submitCollaboration}
          onResolveIssue={resolveIssue}
          onToggleTimelineExpanded={() => setTimelineExpanded((current) => !current)}
          onExpandTimeline={() => setTimelineExpanded(true)}
        />
      )}
      {printDialogOpen && approval && (
        <PrintSettingsDialog
          printers={printers}
          settings={printSettings}
          busy={busyAction === "print"}
          error={printError}
          signedPdfUrl={getSignedFileUrl(approval.id, signedPdfCacheKey)}
          onSettingsChange={updatePrintSettings}
          onCancel={() => {
            if (busyAction !== "print") {
              setPrintDialogOpen(false);
              setPrintError("");
            }
          }}
          onPrintAndArchive={printAndArchive}
        />
      )}
    </section>
  );
}

function AnnotationToolbar({
  tool,
  color,
  customColor,
  canDeleteSelected,
  deleteBusy,
  onToolChange,
  onColorChange,
  onCustomColorChange,
  onDeleteSelected
}: {
  tool: AnnotationTool;
  color: ApprovalAnnotationColor;
  customColor: string;
  canDeleteSelected: boolean;
  deleteBusy: boolean;
  onToolChange: (tool: AnnotationTool) => void;
  onColorChange: (color: ApprovalAnnotationColor) => void;
  onCustomColorChange: (color: string) => void;
  onDeleteSelected: () => void;
}) {
  return (
    <div className="pdf-annotation-toolbar">
      <div className="annotation-toolbar" aria-label="PDF 批注工具">
        <div className="annotation-toolbar__tools">
          {annotationToolbarItems.map((item) =>
            item.type === "delete" ? (
              <button
                 key={item.label}
                 type="button"
                 className="secondary-button danger-lite"
                 title={item.label}
                 onClick={onDeleteSelected}
                 disabled={!canDeleteSelected || deleteBusy}
               >
                 <item.Icon size={15} strokeWidth={2.2} aria-hidden="true" />
                 <span className="annotation-toolbar__label">{deleteBusy ? "删除中" : item.label}</span>
               </button>
             ) : (
               <button
                 key={item.tool}
                 type="button"
                 className={tool === item.tool ? "active" : ""}
                 title={item.label}
                 onClick={() => onToolChange(item.tool)}
               >
                 <item.Icon size={15} strokeWidth={2.2} aria-hidden="true" />
                 <span className="annotation-toolbar__label">{item.label}</span>
               </button>
             )
           )}
         </div>
         <div className="annotation-color-palette" aria-label="批注颜色">
          <span className="annotation-color-palette__label">
            <Palette size={14} strokeWidth={2.2} aria-hidden="true" />
            颜色
          </span>
          <div className="annotation-color-palette__swatches">
            {annotationColors.map((item) => (
              <button
                key={item.color}
                type="button"
                className={`annotation-color-swatch annotation-color-swatch--${item.color} ${color === item.color ? "active" : ""}`}
                style={{ "--annotation-choice": item.tone } as CSSProperties}
                title={item.label}
                aria-label={item.label}
                aria-pressed={color === item.color}
                onClick={() => onColorChange(item.color)}
              >
                <Check size={14} strokeWidth={2.6} aria-hidden="true" />
              </button>
            ))}
            <label
              className={`annotation-custom-color ${color === "custom" ? "active" : ""}`}
              style={{ "--annotation-choice": annotationColorTone(customColor) } as CSSProperties}
              title="自定义颜色"
              onClick={() => onColorChange("custom")}
            >
              <input
                type="color"
                className="annotation-custom-color-input"
                value={customColor}
                aria-label="自定义批注颜色"
                onChange={(event) => onCustomColorChange(event.target.value)}
              />
              <span className="annotation-custom-color__well">
                {color === "custom" && <Check size={13} strokeWidth={2.6} aria-hidden="true" />}
              </span>
              <span className="annotation-custom-color__text">自定义</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

function AnnotationDraftPopover({
  left,
  top,
  message,
  busy,
  onMessageChange,
  onConfirmDraftAnnotation,
  onCancel
}: {
  left: number;
  top: number;
  message: string;
  busy: boolean;
  onMessageChange: (message: string) => void;
  onConfirmDraftAnnotation: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="annotation-popover"
      style={{ left, top }}
      onSubmit={(event) => {
        event.preventDefault();
        void onConfirmDraftAnnotation();
      }}
    >
      <label>
        填写批注内容
        <textarea
          autoFocus
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          placeholder="说明这个位置需要修改或确认的内容"
        />
      </label>
      <div className="annotation-popover__actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="submit" disabled={!message.trim() || busy}>
          {busy ? "保存中" : "保存批注"}
        </button>
      </div>
    </form>
  );
}

function PrintSettingsDialog({
  printers,
  settings,
  busy,
  error,
  signedPdfUrl,
  onSettingsChange,
  onCancel,
  onPrintAndArchive
}: {
  printers: DesktopPrinter[];
  settings: PrintSettings;
  busy: boolean;
  error: string;
  signedPdfUrl: string;
  onSettingsChange: (patch: Partial<PrintSettings>) => void;
  onCancel: () => void;
  onPrintAndArchive: () => void;
}) {
  return (
    <div className="print-settings-backdrop" role="presentation">
      <form
        className="print-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="print-settings-title"
        onSubmit={(event) => {
          event.preventDefault();
          void onPrintAndArchive();
        }}
      >
        <div className="print-settings-header">
          <div>
            <span className="eyebrow">PRINT</span>
            <h2 id="print-settings-title">打印签后 PDF</h2>
            <p>系统打印回调成功后，将自动标记打印归档。</p>
          </div>
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            关闭
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="print-settings-grid">
          <label>
            系统打印机
            <select value={settings.printerName} onChange={(event) => onSettingsChange({ printerName: event.target.value })}>
              <option value="">使用系统默认打印机</option>
              {printers.map((printer) => (
                <option key={printer.name} value={printer.name}>
                  {printer.displayName || printer.name}{printer.isDefault ? "（默认）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            份数
            <input
              type="number"
              min={1}
              max={99}
              value={settings.copies}
              onChange={(event) => onSettingsChange({ copies: Number(event.target.value) })}
            />
          </label>
          <label>
            打印范围
            <input
              value={settings.pageRange}
              onChange={(event) => onSettingsChange({ pageRange: event.target.value })}
              placeholder="留空为全部，例如 1,3,5-8"
            />
          </label>
          <label>
            纸张
            <select value={settings.paperSize} onChange={(event) => onSettingsChange({ paperSize: event.target.value as PrintSettings["paperSize"] })}>
              {paperSizeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            方向
            <select value={settings.orientation} onChange={(event) => onSettingsChange({ orientation: event.target.value as PrintSettings["orientation"] })}>
              <option value="portrait">纵向</option>
              <option value="landscape">横向</option>
            </select>
          </label>
          <label>
            颜色
            <select value={settings.colorMode} onChange={(event) => onSettingsChange({ colorMode: event.target.value as PrintSettings["colorMode"] })}>
              <option value="color">彩色</option>
              <option value="grayscale">黑白</option>
            </select>
          </label>
          <label>
            双面
            <select value={settings.duplexMode} onChange={(event) => onSettingsChange({ duplexMode: event.target.value as PrintSettings["duplexMode"] })}>
              <option value="simplex">单面</option>
              <option value="longEdge">长边双面</option>
              <option value="shortEdge">短边双面</option>
            </select>
          </label>
          <label>
            边距
            <select value={settings.marginMode} onChange={(event) => onSettingsChange({ marginMode: event.target.value as PrintSettings["marginMode"] })}>
              <option value="default">默认</option>
              <option value="none">无边距</option>
              <option value="printableArea">可打印区域</option>
            </select>
          </label>
          <label>
            缩放比例
            <input
              type="number"
              min={25}
              max={200}
              value={settings.scaleFactor}
              onChange={(event) => onSettingsChange({ scaleFactor: Number(event.target.value) })}
            />
          </label>
          <label className="print-settings-check">
            <input
              type="checkbox"
              checked={settings.printBackground}
              onChange={(event) => onSettingsChange({ printBackground: event.target.checked })}
            />
            打印背景
          </label>
        </div>
        <p className="print-settings-note">
          应用能确认打印任务已提交给 Windows，无法判断打印机后续缺纸、卡纸或实际出纸状态。
        </p>
        <div className="print-settings-actions">
          <a className="button-link secondary-link" href={signedPdfUrl} target="_blank" rel="noreferrer">
            预览签后 PDF
          </a>
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "打印中" : "打印并归档"}
          </button>
        </div>
      </form>
    </div>
  );
}

const paperSizeOptions: Array<{ value: PrintSettings["paperSize"]; label: string }> = [
  { value: "printer-default", label: "使用打印机默认" },
  { value: "A4", label: "A4" },
  { value: "A3", label: "A3" },
  { value: "A2", label: "A2" },
  { value: "A1", label: "A1" },
  { value: "A0", label: "A0" },
  { value: "A5", label: "A5" },
  { value: "A6", label: "A6" },
  { value: "Legal", label: "Legal" },
  { value: "Letter", label: "Letter" },
  { value: "Tabloid", label: "Tabloid" }
];

function isRepairable(status: Approval["status"]) {
  return status === "file_missing" || status === "invalid_pdf" || status === "filename_invalid";
}

function annotationReadonlyCopy(user: Pick<User, "role">, approval: Pick<Approval, "status">) {
  if (approval.status === "printed_archived" || approval.status === "voided") {
    return "当前图纸已归档或作废，批注仅可查看。";
  }
  if (user.role === "designer") {
    return "设计师可查看并处理批注，不能新增审核批注。";
  }
  return "当前账号可查看批注，不能新增审核批注。";
}

function annotationStyleJsonForColor(color: ApprovalAnnotationColor, customColor: string, previousStyleJson: string | null = null) {
  const style = parseAnnotationStyle(previousStyleJson);
  if (color === "custom") {
    return JSON.stringify({ ...style, strokeColor: normalizeHexColor(customColor) });
  }
  if ("strokeColor" in style) {
    delete style.strokeColor;
  }
  return Object.keys(style).length > 0 ? JSON.stringify(style) : null;
}

function readAnnotationStrokeColor(styleJson: string | null) {
  const strokeColor = parseAnnotationStyle(styleJson).strokeColor;
  return typeof strokeColor === "string" && /^#[0-9a-fA-F]{6}$/.test(strokeColor) ? strokeColor.toLowerCase() : null;
}

function parseAnnotationStyle(styleJson: string | null): Record<string, unknown> {
  if (!styleJson) return {};
  try {
    const parsed = JSON.parse(styleJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
  } catch {
    return {};
  }
}

function normalizeHexColor(color: string) {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : "#7c3aed";
}

function annotationColorTone(color: string) {
  return normalizeHexColor(color);
}

const annotationToolbarItems: Array<
  | { type: "tool"; tool: AnnotationTool; label: string; Icon: LucideIcon }
  | { type: "delete"; label: string; Icon: LucideIcon }
> = [
  { type: "tool", tool: "select", label: "选择", Icon: MousePointer2 },
  { type: "tool", tool: "pin", label: "定位", Icon: MapPin },
  { type: "tool", tool: "arrow", label: "箭头", Icon: ArrowUpRight },
  { type: "tool", tool: "rect", label: "矩形", Icon: Square },
  { type: "tool", tool: "circle", label: "圆形", Icon: Circle },
  { type: "tool", tool: "text", label: "文字", Icon: Type },
  { type: "tool", tool: "ink", label: "画笔", Icon: Pencil },
  { type: "tool", tool: "cloud", label: "云线", Icon: Cloud },
  { type: "delete", label: "删除", Icon: Trash2 }
];

const annotationColors: Array<{ color: Exclude<ApprovalAnnotationColor, "custom">; label: string; tone: string }> = [
  { color: "red", label: "红色", tone: "#c62828" },
  { color: "amber", label: "橙色", tone: "#b15f00" },
  { color: "blue", label: "蓝色", tone: "#195fbd" },
  { color: "green", label: "绿色", tone: "#1f7a45" }
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
