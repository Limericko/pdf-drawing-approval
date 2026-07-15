import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowUpRight,
  Check,
  Circle,
  Cloud,
  Copy,
  MapPin,
  MousePointer2,
  Palette,
  Pencil,
  PanelRightOpen,
  X,
  Printer,
  Square,
  Trash2,
  Type,
  Undo2,
  Redo2,
  type LucideIcon
} from "lucide-react";
import {
  createApprovalComment,
  createApprovalIssue,
  createApprovalIssueWithAnnotation,
  createApprovalAnnotation,
  deleteApprovalAnnotation,
  getApproval,
  getAnnotatedFileUrl,
  getApprovalFileUrl,
  getSignedFileUrl,
  listApprovalAnnotations,
  listApprovalComments,
  listApprovalIssueAssignees,
  listApprovalIssues,
  listApprovals,
  listApprovalOperationLogs,
  listSignaturePlacements,
  markPrinted,
  publishApprovalToPdm,
  rebindApprovalFile,
  resetApprovalAnnotations,
  repairApprovalPdmMetadata,
  resolveApprovalAnnotation,
  resolveApprovalComment,
  retryGenerateSignedPdf,
  retryApprovalValidation,
  saveApprovalPlacementsAsTemplate,
  saveSignaturePlacements,
  submitReview,
  subscribeApprovalIssueEvents,
  transitionApprovalIssue,
  updateApprovalIssue,
  updateApprovalAnnotation,
  voidApproval,
  type Approval,
  type ApprovalAnnotation,
  type ApprovalAnnotationColor,
  type ApprovalAnnotationInput,
  type ApprovalComment,
  type ApprovalIssue,
  type ApprovalIssueInput,
  type ApprovalIssueSeverity,
  type ApprovalIssueTransitionAction,
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
import { PdmMetadataPanel, type PdmRepairDraft } from "./approvalDetail/PdmMetadataPanel.tsx";
import { SignaturePanel } from "./approvalDetail/SignaturePanel.tsx";
import { Button, ButtonLink, IconButton } from "../ui/actions/index.tsx";
import { Checkbox, NumberInput, Select, TextInput } from "../ui/forms/index.tsx";
import { ConnectionBanner, InlineAlert } from "../ui/feedback/index.tsx";
import { Dialog } from "../ui/overlays/index.tsx";
import { IssueInspector } from "../features/pdf-studio/IssueInspector.tsx";
import studioStyles from "../features/pdf-studio/PdfStudioLayout.module.css";
import toolbarStyles from "../features/pdf-studio/PdfToolbar.module.css";
import { ReviewActionBar } from "../features/pdf-studio/ReviewActionBar.tsx";
import draftStyles from "../features/pdf-studio/AnnotationDraftPopover.module.css";
import { ActivityInspector, type ActivityTab } from "../features/pdf-studio/ActivityInspector.tsx";
import {
  ResizableInspectorHandle,
  usePersistentPdfInspectorWidth
} from "../features/pdf-studio/ResizableInspectorPane.tsx";
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
type AnnotationHistoryEntry =
  | { kind: "create"; annotationId: number | null; input: ApprovalAnnotationInput }
  | { kind: "update"; annotationId: number; before: ApprovalAnnotationInput; after: ApprovalAnnotationInput }
  | { kind: "delete"; annotationId: number | null; input: ApprovalAnnotationInput };

const PdfAnnotationWorkspace = lazy(() =>
  import("../widgets/PdfAnnotationWorkspace.tsx").then((module) => ({ default: module.PdfAnnotationWorkspace }))
);
const PdfSignaturePlacementWorkspace = lazy(() =>
  import("../widgets/PdfSignaturePlacementWorkspace.tsx").then((module) => ({ default: module.PdfSignaturePlacementWorkspace }))
);

export function ApprovalDetailPage({ id, user }: { id: number; user: User }) {
  const detailPdfStageRef = useRef<HTMLDivElement | null>(null);
  const annotationUndoStack = useRef<AnnotationHistoryEntry[]>([]);
  const annotationRedoStack = useRef<AnnotationHistoryEntry[]>([]);
  const { width: inspectorWidth, setWidth: setInspectorWidth } = usePersistentPdfInspectorWidth();
  const [approval, setApproval] = useState<Approval | null>(null);
  const [operationLogs, setOperationLogs] = useState<OperationLog[]>([]);
  const [approvalComments, setApprovalComments] = useState<ApprovalComment[]>([]);
  const [approvalIssues, setApprovalIssues] = useState<ApprovalIssue[]>([]);
  const [issueAssignees, setIssueAssignees] = useState<User[]>([]);
  const [annotations, setAnnotations] = useState<ApprovalAnnotation[]>([]);
  const [reviewComment, setReviewComment] = useState("");
  const [annotationMessage, setAnnotationMessage] = useState("");
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>("select");
  const [annotationColor, setAnnotationColor] = useState<ApprovalAnnotationColor>("red");
  const [annotationCustomColor, setAnnotationCustomColor] = useState(() => readPaletteHex("--palette-info-500"));
  const [annotationFilters, setAnnotationFilters] = useState<AnnotationFilters>({
    status: "all",
    author: "all",
    kind: "all"
  });
  const [continuousAnnotationMode, setContinuousAnnotationMode] = useState(false);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<number | null>(null);
  const [annotationScrollRequest, setAnnotationScrollRequest] = useState(0);
  const [annotationHistoryVersion, setAnnotationHistoryVersion] = useState(0);
  const [annotationSaveStatus, setAnnotationSaveStatus] = useState<"saving" | "saved" | "error" | "offline">("saved");
  const [issueRealtimeStatus, setIssueRealtimeStatus] = useState<"connected" | "reconnecting">("connected");
  const [pendingAnnotationDraft, setPendingAnnotationDraft] = useState<PendingAnnotationDraft | null>(null);
  const [draftAnnotationMessage, setDraftAnnotationMessage] = useState("");
  const [draftAnnotationMode, setDraftAnnotationMode] = useState<"note" | "issue">("note");
  const [draftIssueTitle, setDraftIssueTitle] = useState("");
  const [draftIssueSeverity, setDraftIssueSeverity] = useState<ApprovalIssueSeverity>("medium");
  const [draftIssueAssigneeId, setDraftIssueAssigneeId] = useState("");
  const [draftIssueDueAt, setDraftIssueDueAt] = useState("");
  const [collaborationMessage, setCollaborationMessage] = useState("");
  const [repairPath, setRepairPath] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const [pdmRepairDraft, setPdmRepairDraft] = useState<PdmRepairDraft>(() => emptyPdmRepairDraft());
  const [pdmRepairEditing, setPdmRepairEditing] = useState(false);
  const [signaturePlacements, setSignaturePlacements] = useState<SignaturePlacement[]>(() => defaultSignaturePlacements());
  const [placementEditing, setPlacementEditing] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [supportTab, setSupportTab] = useState<ActivityTab>("comments");
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"issues" | "annotations" | "details" | "activity">("issues");
  const [printSettings, setPrintSettings] = useState<PrintSettings>(() => defaultPrintSettings());
  const [printers, setPrinters] = useState<DesktopPrinter[]>([]);
  const [printError, setPrintError] = useState("");
  const [savingPlacements, setSavingPlacements] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [pdfState, setPdfState] = useState<"checking" | "ready" | "invalid" | "missing">("checking");
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const desktopClient = isDesktopClient();

  async function reload(isCurrent = () => true) {
    setError("");
    const [next, logs, comments, issues, assignees, placements, annotations] = await Promise.all([
      getApproval(id),
      listApprovalOperationLogs(id),
      listApprovalComments(id),
      listApprovalIssues(id),
      listApprovalIssueAssignees(id),
      listSignaturePlacements(id),
      listApprovalAnnotations(id)
    ]);
    if (!isCurrent()) return;
    setApproval(next);
    setPdmRepairDraft(pdmRepairDraftFromApproval(next));
    setPdmRepairEditing(false);
    setTemplateName((current) => current || `${next.projectName}-${next.partName}`);
    setOperationLogs(logs);
    setApprovalComments(comments);
    setApprovalIssues(issues);
    setIssueAssignees(assignees);
    setAnnotations(annotations);
    setSignaturePlacements(placements.length > 0 ? placements : defaultSignaturePlacements());
    setRepairPath((current) => current || next.currentFilePath);
    await checkPdf(next.id, isCurrent);
  }

  useEffect(() => {
    let active = true;
    annotationUndoStack.current = [];
    annotationRedoStack.current = [];
    setAnnotationHistoryVersion((current) => current + 1);
    reload(() => active).catch((err) => {
      if (active) setError(detailReloadErrorMessage(err));
    });
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!approval || busyAction || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        void undoAnnotationChange();
      } else if (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey)) {
        event.preventDefault();
        void redoAnnotationChange();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [approval?.id, busyAction]);

  useEffect(() => {
    const markOffline = () => setAnnotationSaveStatus("offline");
    const markOnline = () => setAnnotationSaveStatus((current) => current === "offline" ? "saved" : current);
    window.addEventListener("offline", markOffline);
    window.addEventListener("online", markOnline);
    if (!navigator.onLine) markOffline();
    return () => {
      window.removeEventListener("offline", markOffline);
      window.removeEventListener("online", markOnline);
    };
  }, []);

  useEffect(() => {
    if (!approval) return;
    return subscribeApprovalIssueEvents(approval.id, () => {
      void Promise.all([listApprovalIssues(approval.id), listApprovalOperationLogs(approval.id)])
        .then(([issues, logs]) => {
          setApprovalIssues(issues);
          setOperationLogs(logs);
        })
        .catch(() => setIssueRealtimeStatus("reconnecting"));
    }, setIssueRealtimeStatus);
  }, [approval?.id]);

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

  async function review(decision: "approved" | "rejected", openNext = false) {
    if (user.role !== "supervisor" && user.role !== "process") return;
    setError("");
    if (decision === "rejected" && !reviewComment.trim() && !annotations.some((annotation) => !annotation.resolved)) {
      setError("驳回时请填写意见，或先在图纸上添加批注。");
      return;
    }
    setBusyAction("review");
    try {
      const next = await submitReview(id, user.role, decision, reviewComment);
      await afterApprovalChanged(next, decision === "approved" ? "审核已通过。" : "审核已驳回。");
      setReviewComment("");
      if (openNext) {
        const queue = await listApprovals({ mine: true, status: "pending" });
        const nextTask = queue.find((item) => item.id !== id);
        window.location.hash = nextTask ? `#/approvals/${nextTask.id}` : "#/approvals";
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "提交失败";
      setError(detail === "OPEN_HIGH_SEVERITY_ISSUES" ? "仍有高或严重级问题未关闭，暂不能通过图纸。" : detail);
    } finally {
      setBusyAction("");
    }
  }

  async function afterApprovalChanged(next: Approval, nextMessage: string) {
    const previous = approval;
    setApproval(next);
    setPdmRepairDraft(pdmRepairDraftFromApproval(next));
    setPdmRepairEditing(false);
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
      await createApprovalComment(approval.id, { kind: "comment", message: collaborationMessage });
      setCollaborationMessage("");
      setMessage("讨论已添加。");
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

  async function createFormalIssue(input: ApprovalIssueInput) {
    if (!approval) return;
    setBusyAction("issue-create");
    setError("");
    setMessage("");
    try {
      await createApprovalIssue(approval.id, input);
      const [issues, logs] = await Promise.all([listApprovalIssues(approval.id), listApprovalOperationLogs(approval.id)]);
      setApprovalIssues(issues);
      setOperationLogs(logs);
      setInspectorTab("issues");
      setMessage("正式问题已创建并分配。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建正式问题失败");
      throw err;
    } finally {
      setBusyAction("");
    }
  }

  async function transitionFormalIssue(
    issue: ApprovalIssue,
    action: ApprovalIssueTransitionAction,
    note?: string
  ) {
    if (!approval) return;
    setBusyAction(`issue-${issue.id}-${action}`);
    setError("");
    setMessage("");
    try {
      await transitionApprovalIssue(approval.id, issue.id, { action, note, expectedVersion: issue.version });
      const [issues, logs] = await Promise.all([listApprovalIssues(approval.id), listApprovalOperationLogs(approval.id)]);
      setApprovalIssues(issues);
      setOperationLogs(logs);
      setMessage("问题状态已更新。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新问题状态失败");
      throw err;
    } finally {
      setBusyAction("");
    }
  }

  async function updateFormalIssue(issue: ApprovalIssue, input: Partial<Omit<ApprovalIssueInput, "annotationId" | "clientRequestId">>) {
    if (!approval) return;
    setBusyAction(`issue-${issue.id}-update`);
    setError("");
    try {
      await updateApprovalIssue(approval.id, issue.id, { ...input, expectedVersion: issue.version });
      const [issues, logs] = await Promise.all([listApprovalIssues(approval.id), listApprovalOperationLogs(approval.id)]);
      setApprovalIssues(issues);
      setOperationLogs(logs);
      setMessage("问题字段已更新。");
    } catch (err) {
      setError(err instanceof Error && err.message === "ISSUE_VERSION_CONFLICT"
        ? "问题已被其他用户更新，页面已刷新，请核对后重试。"
        : err instanceof Error ? err.message : "更新问题失败");
      setApprovalIssues(await listApprovalIssues(approval.id));
      throw err;
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
    setAnnotationSaveStatus("saved");
    return nextAnnotations;
  }

  function recordAnnotationHistory(entry: AnnotationHistoryEntry) {
    annotationUndoStack.current.push(entry);
    annotationRedoStack.current = [];
    setAnnotationHistoryVersion((current) => current + 1);
  }

  async function undoAnnotationChange() {
    if (!approval || busyAction) return;
    const entry = annotationUndoStack.current.pop();
    if (!entry) return;
    setBusyAction("annotation-history");
    setAnnotationSaveStatus("saving");
    setError("");
    try {
      if (entry.kind === "create") {
        if (entry.annotationId !== null) await deleteApprovalAnnotation(approval.id, entry.annotationId);
        entry.annotationId = null;
        setSelectedAnnotationId(null);
      } else if (entry.kind === "update") {
        await updateApprovalAnnotation(approval.id, entry.annotationId, entry.before);
        setSelectedAnnotationId(entry.annotationId);
      } else {
        const restored = await createApprovalAnnotation(approval.id, entry.input);
        entry.annotationId = restored.id;
        setSelectedAnnotationId(restored.id);
      }
      annotationRedoStack.current.push(entry);
      await refreshAnnotationTrace(approval.id);
      setMessage("已撤销上一项批注修改。");
    } catch (err) {
      annotationUndoStack.current.push(entry);
      setError(err instanceof Error ? `撤销失败：${err.message}` : "撤销批注修改失败");
      setAnnotationSaveStatus("error");
    } finally {
      setBusyAction("");
      setAnnotationHistoryVersion((current) => current + 1);
    }
  }

  async function redoAnnotationChange() {
    if (!approval || busyAction) return;
    const entry = annotationRedoStack.current.pop();
    if (!entry) return;
    setBusyAction("annotation-history");
    setAnnotationSaveStatus("saving");
    setError("");
    try {
      if (entry.kind === "create") {
        const restored = await createApprovalAnnotation(approval.id, entry.input);
        entry.annotationId = restored.id;
        setSelectedAnnotationId(restored.id);
      } else if (entry.kind === "update") {
        await updateApprovalAnnotation(approval.id, entry.annotationId, entry.after);
        setSelectedAnnotationId(entry.annotationId);
      } else if (entry.annotationId !== null) {
        await deleteApprovalAnnotation(approval.id, entry.annotationId);
        entry.annotationId = null;
        setSelectedAnnotationId(null);
      }
      annotationUndoStack.current.push(entry);
      await refreshAnnotationTrace(approval.id);
      setMessage("已重做批注修改。");
    } catch (err) {
      annotationRedoStack.current.push(entry);
      setError(err instanceof Error ? `重做失败：${err.message}` : "重做批注修改失败");
      setAnnotationSaveStatus("error");
    } finally {
      setBusyAction("");
      setAnnotationHistoryVersion((current) => current + 1);
    }
  }

  function startAnnotationDraft(input: ApprovalAnnotationInput, anchor: AnnotationDraftAnchor) {
    const stageRect = detailPdfStageRef.current?.getBoundingClientRect();
    const left = stageRect ? clamp(anchor.clientX - stageRect.left + 10, 12, Math.max(12, stageRect.width - 340)) : 18;
    const top = stageRect ? clamp(anchor.clientY - stageRect.top + 10, 56, Math.max(56, stageRect.height - 250)) : 72;

    setPendingAnnotationDraft({ input, left, top });
    setDraftAnnotationMessage("");
    setDraftAnnotationMode("note");
    setDraftIssueTitle("");
    setDraftIssueSeverity("medium");
    setDraftIssueAssigneeId(issueAssignees[0] ? String(issueAssignees[0].id) : "");
    setDraftIssueDueAt("");
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
    if (draftAnnotationMode === "issue" && (!draftIssueTitle.trim() || !Number(draftIssueAssigneeId))) {
      setError("创建正式问题时，请填写问题标题并选择负责人。");
      return;
    }
    setBusyAction("annotation");
    setAnnotationSaveStatus("saving");
    setError("");
    setMessage("");
    try {
      if (draftAnnotationMode === "issue") {
        const linked = await createApprovalIssueWithAnnotation(approval.id, {
          assigneeUserId: Number(draftIssueAssigneeId),
          title: draftIssueTitle.trim(),
          description: message,
          severity: draftIssueSeverity,
          dueAt: draftIssueDueAt ? new Date(draftIssueDueAt).toISOString() : null,
          annotation: { ...pendingAnnotationDraft.input, message }
        });
        const created = linked.annotation;
        recordAnnotationHistory({ kind: "create", annotationId: created.id, input: annotationToInput(created) });
        setApprovalIssues(await listApprovalIssues(approval.id));
        setInspectorOpen(true);
        setInspectorTab("issues");
        setMessage("正式问题已定位、创建并分配。");
        setSelectedAnnotationId(created.id);
      } else {
        const created = await createApprovalAnnotation(approval.id, { ...pendingAnnotationDraft.input, message });
        recordAnnotationHistory({ kind: "create", annotationId: created.id, input: annotationToInput(created) });
        setMessage("图纸说明已添加。");
        setSelectedAnnotationId(created.id);
      }
      setAnnotationScrollRequest((current) => current + 1);
      if (!continuousAnnotationMode) setAnnotationTool("select");
      setPendingAnnotationDraft(null);
      setDraftAnnotationMessage("");
      await refreshAnnotationTrace(approval.id);
    } catch (err) {
      setError(err instanceof Error && err.message ? `批注保存失败，请检查网络后重试。${err.message}` : "批注保存失败，请检查网络后重试。");
      setAnnotationSaveStatus(navigator.onLine ? "error" : "offline");
    } finally {
      setBusyAction("");
    }
  }

  function cancelDraftAnnotation() {
    setPendingAnnotationDraft(null);
    setDraftAnnotationMessage("");
    setDraftIssueTitle("");
    setDraftIssueDueAt("");
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
    setAnnotationSaveStatus("saving");
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
      recordAnnotationHistory({
        kind: "update",
        annotationId: selectedAnnotation.id,
        before: annotationToInput(selectedAnnotation),
        after: annotationToInput(updated)
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
      setAnnotationSaveStatus(navigator.onLine ? "error" : "offline");
    } finally {
      setBusyAction("");
    }
  }

  async function updateAnnotationGeometry(annotation: ApprovalAnnotation, input: ApprovalAnnotationInput) {
    if (!approval || !canEditAnnotation(user, approval, annotation)) return;
    setBusyAction(`annotation-update-${annotation.id}`);
    setAnnotationSaveStatus("saving");
    setError("");
    setMessage("");
    try {
      const updated = await updateApprovalAnnotation(approval.id, annotation.id, {
        ...input,
        message: annotation.message,
        color: input.color ?? annotation.color,
        styleJson: input.styleJson ?? annotation.styleJson
      });
      recordAnnotationHistory({
        kind: "update",
        annotationId: annotation.id,
        before: annotationToInput(annotation),
        after: annotationToInput(updated)
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
      setAnnotationSaveStatus(navigator.onLine ? "error" : "offline");
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
    const annotation = annotations.find((item) => item.id === annotationId);
    setBusyAction(`annotation-delete-${annotationId}`);
    setAnnotationSaveStatus("saving");
    setError("");
    setMessage("");
    try {
      await deleteApprovalAnnotation(approval.id, annotationId);
      if (annotation) recordAnnotationHistory({ kind: "delete", annotationId: null, input: annotationToInput(annotation) });
      setMessage("图纸批注已删除。");
      setSelectedAnnotationId((current) => (current === annotationId ? null : current));
      await refreshAnnotationTrace(approval.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "批注删除失败");
      setAnnotationSaveStatus(navigator.onLine ? "error" : "offline");
    } finally {
      setBusyAction("");
    }
  }

  async function duplicateSelectedAnnotation() {
    if (!approval || !selectedAnnotation) return;
    setBusyAction(`annotation-copy-${selectedAnnotation.id}`);
    setAnnotationSaveStatus("saving");
    setError("");
    try {
      const created = await createApprovalAnnotation(approval.id, duplicateAnnotationInput(selectedAnnotation));
      recordAnnotationHistory({ kind: "create", annotationId: created.id, input: annotationToInput(created) });
      setSelectedAnnotationId(created.id);
      setAnnotationMessage(created.message);
      setMessage("批注副本已创建，可在画布中拖动到新位置。");
      await refreshAnnotationTrace(approval.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "复制批注失败");
      setAnnotationSaveStatus(navigator.onLine ? "error" : "offline");
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
    setDraftIssueTitle("");
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

  async function savePdmMetadata() {
    if (!approval) return;
    setError("");
    setMessage("");
    setBusyAction("pdm-repair");
    try {
      await repairApprovalPdmMetadata(approval.id, {
        documentCode: pdmRepairDraft.documentCode,
        materialCode: pdmRepairDraft.materialCode,
        drawingName: pdmRepairDraft.drawingName
      });
      await reload();
      setMessage("PDM 信息已补录。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDM 信息补录失败");
    } finally {
      setBusyAction("");
    }
  }

  async function retryPdmPublish() {
    if (!approval) return;
    setError("");
    setMessage("");
    setBusyAction("pdm-publish");
    try {
      const result = await publishApprovalToPdm(approval.id);
      await reload();
      setMessage(result.status === "published" ? "已发布到 PDM 零件库。" : result.error ?? result.reason ?? "PDM 发布已提交。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDM 发布失败");
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
  const blockingIssueCount = approvalIssues.filter(
    (issue) => issue.status !== "closed" && (issue.severity === "high" || issue.severity === "critical")
  ).length;
  const pageIssueCounts = approvalIssues.reduce<Record<number, number>>((counts, issue) => {
    if (issue.status === "closed" || !issue.annotationId) return counts;
    const annotation = annotations.find((item) => item.id === issue.annotationId);
    if (annotation) counts[annotation.pageNumber] = (counts[annotation.pageNumber] ?? 0) + 1;
    return counts;
  }, {});
  const annotationPageById = annotations.reduce<Record<number, number>>((pages, annotation) => {
    pages[annotation.id] = annotation.pageNumber;
    return pages;
  }, {});
  const canUndoAnnotations = annotationHistoryVersion >= 0 && annotationUndoStack.current.length > 0;
  const canRedoAnnotations = annotationHistoryVersion >= 0 && annotationRedoStack.current.length > 0;
  const openFormalIssueCount = approvalIssues.filter((issue) => issue.status !== "closed").length;
  const canReviewCurrentTask = approval.status === "pending" && (
    (user.role === "supervisor" && approval.supervisorStatus === "pending") ||
    (user.role === "process" && approval.processStatus === "pending")
  );
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
  return (
    <section className={studioStyles.page}>
      <div className={studioStyles.header}>
        <div className={studioStyles.identity}>
          <h1>{approval.projectName} / {approval.partName}</h1>
          <p>工程图纸审阅 · {approval.version} · {statusLabel(approval.status)}</p>
        </div>
        <div className={studioStyles.headerActions}>
          <StatusChip status={approval.status} />
          <StatusChip status={approval.signatureStatus} context="signature" />
          <IconButton className={studioStyles.mobileInspectorButton} label="打开审阅检查器" variant="secondary" size="sm" onClick={() => setInspectorOpen(true)}>
            <PanelRightOpen size={16} />
          </IconButton>
          <a className="button-link secondary-link" href="#/approvals">返回列表</a>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}
      {issueRealtimeStatus === "reconnecting" && <ConnectionBanner status="reconnecting">问题实时更新正在重连，当前页面仍可继续查看。</ConnectionBanner>}
      <div className={studioStyles.contextStrip}>
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
      <div
        className={studioStyles.body}
        style={{ "--pdf-inspector-active-width": `${inspectorWidth}px` } as CSSProperties}
      >
        <div className={studioStyles.canvas} ref={detailPdfStageRef}>
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
                      canCopySelected={Boolean(selectedAnnotation && canEditAnnotation(user, approval, selectedAnnotation))}
                      deleteBusy={selectedAnnotation ? busyAction === `annotation-delete-${selectedAnnotation.id}` : false}
                      copyBusy={selectedAnnotation ? busyAction === `annotation-copy-${selectedAnnotation.id}` : false}
                      historyBusy={busyAction === "annotation-history"}
                      canUndo={canUndoAnnotations}
                      canRedo={canRedoAnnotations}
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
                      onCopySelected={() => void duplicateSelectedAnnotation()}
                      onUndo={() => void undoAnnotationChange()}
                      onRedo={() => void redoAnnotationChange()}
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
                    onPageCountChange={setPdfPageCount}
                    pageIssueCounts={pageIssueCounts}
                    onUpdateAnnotationGeometry={canCreateAnnotations ? updateAnnotationGeometry : undefined}
                  />
                  {pendingAnnotationDraft && (
                    <AnnotationDraftPopover
                      left={pendingAnnotationDraft.left}
                      top={pendingAnnotationDraft.top}
                      message={draftAnnotationMessage}
                      mode={draftAnnotationMode}
                      issueTitle={draftIssueTitle}
                      issueSeverity={draftIssueSeverity}
                      issueAssigneeId={draftIssueAssigneeId}
                      issueDueAt={draftIssueDueAt}
                      issueAssignees={issueAssignees}
                      busy={busyAction === "annotation"}
                      onMessageChange={setDraftAnnotationMessage}
                      onModeChange={setDraftAnnotationMode}
                      onIssueTitleChange={setDraftIssueTitle}
                      onIssueSeverityChange={setDraftIssueSeverity}
                      onIssueAssigneeChange={setDraftIssueAssigneeId}
                      onIssueDueAtChange={setDraftIssueDueAt}
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
        <ResizableInspectorHandle width={inspectorWidth} onWidthChange={setInspectorWidth} />
        {inspectorOpen && <button type="button" className={studioStyles.backdrop} aria-label="关闭审阅检查器" onClick={() => setInspectorOpen(false)} />}
        <aside className={studioStyles.inspector} data-open={inspectorOpen} aria-label="审阅检查器">
          <div className={studioStyles.inspectorHeader}>
          <div className={studioStyles.inspectorTitle}>
            <h2>审阅检查器</h2>
            <div className={studioStyles.inspectorDismiss}>
              <IconButton label="关闭审阅检查器" variant="ghost" size="sm" onClick={() => setInspectorOpen(false)}><X size={16} /></IconButton>
            </div>
          </div>
          <div className={studioStyles.reviewStatus}>
            <div>
              <span>主管</span>
              <StatusChip status={approval.supervisorStatus} />
            </div>
            <div>
              <span>工艺</span>
              <StatusChip status={approval.processStatus} />
            </div>
          </div>
          <div className={studioStyles.tabs} role="tablist" aria-label="检查器内容">
            {([['issues', `问题 ${openFormalIssueCount}`], ['annotations', `批注 ${openAnnotationCount}`], ['details', '属性'], ['activity', '记录']] as const).map(([tab, label]) =>
              <button key={tab} type="button" role="tab" aria-selected={inspectorTab === tab} onClick={() => setInspectorTab(tab)}>{label}</button>)}
          </div>
          </div>
          {inspectorTab === "issues" && <IssueInspector
            approvalId={approval.id}
            user={user}
            issues={approvalIssues}
            assignees={issueAssignees}
            selectedAnnotation={selectedAnnotation}
            annotationPageById={annotationPageById}
            documentPageCount={pdfPageCount}
            busyAction={busyAction}
            onCreate={createFormalIssue}
            onUpdate={updateFormalIssue}
            onTransition={transitionFormalIssue}
            onLocateAnnotation={(annotationId) => {
              const annotation = annotations.find((item) => item.id === annotationId);
              if (annotation) {
                setInspectorTab("annotations");
                selectAnnotation(annotation, { scrollIntoView: true });
              }
            }}
          />}
          {inspectorTab === "activity" && <ActivityInspector
            tab={supportTab}
            collaborationMessage={collaborationMessage}
            busyAction={busyAction}
            comments={approvalComments}
            logs={operationLogs}
            visibleLogs={visibleLogs}
            hiddenLogCount={hiddenLogCount}
            timelineExpanded={timelineExpanded}
            historyItems={historyItems}
            onTabChange={setSupportTab}
            onMessageChange={setCollaborationMessage}
            onSubmitComment={() => void submitCollaboration()}
            onResolveLegacyIssue={(commentId) => void resolveIssue(commentId)}
            onToggleTimeline={() => setTimelineExpanded((current) => !current)}
          />}
          {inspectorTab === "details" && <PdmMetadataPanel
            approval={approval}
            user={user}
            draft={pdmRepairDraft}
            editing={pdmRepairEditing}
            busyAction={busyAction}
            onDraftChange={setPdmRepairDraft}
            onStartEdit={() => {
              setPdmRepairDraft(pdmRepairDraftFromApproval(approval));
              setPdmRepairEditing(true);
            }}
            onCancelEdit={() => {
              setPdmRepairDraft(pdmRepairDraftFromApproval(approval));
              setPdmRepairEditing(false);
            }}
            onSaveRepair={savePdmMetadata}
            onRetryPublish={retryPdmPublish}
          />}
          {inspectorTab === "annotations" && showAnnotations && (
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
          {inspectorTab === "details" && <>
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
          </>}
        </aside>
      </div>
      <ReviewActionBar
        saveStatus={annotationSaveStatus}
        openIssueCount={openFormalIssueCount}
        blockingIssueCount={blockingIssueCount}
        canReview={canReviewCurrentTask}
        comment={reviewComment}
        busy={busyAction === "review"}
        onCommentChange={setReviewComment}
        onApprove={() => void review("approved")}
        onApproveAndNext={() => void review("approved", true)}
        onReject={() => void review("rejected")}
      />
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
  canCopySelected,
  deleteBusy,
  copyBusy,
  historyBusy,
  canUndo,
  canRedo,
  onToolChange,
  onColorChange,
  onCustomColorChange,
  onDeleteSelected,
  onCopySelected,
  onUndo,
  onRedo
}: {
  tool: AnnotationTool;
  color: ApprovalAnnotationColor;
  customColor: string;
  canDeleteSelected: boolean;
  canCopySelected: boolean;
  deleteBusy: boolean;
  copyBusy: boolean;
  historyBusy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onToolChange: (tool: AnnotationTool) => void;
  onColorChange: (color: ApprovalAnnotationColor) => void;
  onCustomColorChange: (color: string) => void;
  onDeleteSelected: () => void;
  onCopySelected: () => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div className={toolbarStyles.bar} aria-label="PDF 批注工具">
        <span className={toolbarStyles.mobileNotice}>精确绘制请使用桌面宽屏；当前仍可查看、定位和处理问题。</span>
        <div className={toolbarStyles.group}>
          {annotationToolbarItems.map((item) =>
            item.type === "delete" ? (
              <button
                 key={item.label}
                 type="button"
                 className={toolbarStyles.tool}
                 data-danger="true"
                 title={item.label}
                 aria-label={item.label}
                 onClick={onDeleteSelected}
                 disabled={!canDeleteSelected || deleteBusy}
               >
                 <item.Icon size={15} strokeWidth={2.2} aria-hidden="true" />
                 <span className={toolbarStyles.label}>{deleteBusy ? "删除中" : item.label}</span>
               </button>
             ) : (
               <button
                 key={item.tool}
                 type="button"
                 className={toolbarStyles.tool}
                 data-selected={tool === item.tool}
                 title={item.label}
                 aria-label={item.label}
                 aria-pressed={tool === item.tool}
                 onClick={() => onToolChange(item.tool)}
               >
                 <item.Icon size={15} strokeWidth={2.2} aria-hidden="true" />
                 <span className={toolbarStyles.label}>{item.label}</span>
               </button>
             )
           )}
        </div>
        <div className={toolbarStyles.group} aria-label="撤销与重做">
          <button type="button" className={toolbarStyles.tool} title="复制选中批注" aria-label="复制选中批注"
            disabled={!canCopySelected || copyBusy} onClick={onCopySelected}><Copy size={15} /><span className={toolbarStyles.label}>{copyBusy ? "复制中" : "复制"}</span></button>
          <button type="button" className={toolbarStyles.tool} title="撤销 Ctrl+Z" aria-label="撤销批注修改"
            disabled={!canUndo || historyBusy} onClick={onUndo}><Undo2 size={15} /><span className={toolbarStyles.label}>撤销</span></button>
          <button type="button" className={toolbarStyles.tool} title="重做 Ctrl+Y" aria-label="重做批注修改"
            disabled={!canRedo || historyBusy} onClick={onRedo}><Redo2 size={15} /><span className={toolbarStyles.label}>重做</span></button>
        </div>
         <div className={toolbarStyles.colors} aria-label="批注颜色">
          <span className={toolbarStyles.colorLabel}>
            <Palette size={14} strokeWidth={2.2} aria-hidden="true" />
            <span>颜色</span>
          </span>
            {annotationColors.map((item) => (
              <button
                key={item.color}
                type="button"
                className={toolbarStyles.swatch}
                data-selected={color === item.color}
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
              className={toolbarStyles.custom}
              data-selected={color === "custom"}
              style={{ "--annotation-choice": annotationColorTone(customColor) } as CSSProperties}
              title="自定义颜色"
              onClick={() => onColorChange("custom")}
            >
              <input
                type="color"
                value={customColor}
                aria-label="自定义批注颜色"
                onChange={(event) => onCustomColorChange(event.target.value)}
              />
              <span className={toolbarStyles.customWell}>
                {color === "custom" && <Check size={13} strokeWidth={2.6} aria-hidden="true" />}
              </span>
              <span className={toolbarStyles.customText}>自定义</span>
            </label>
        </div>
    </div>
  );
}

function AnnotationDraftPopover({
  left,
  top,
  message,
  mode,
  issueTitle,
  issueSeverity,
  issueAssigneeId,
  issueDueAt,
  issueAssignees,
  busy,
  onMessageChange,
  onModeChange,
  onIssueTitleChange,
  onIssueSeverityChange,
  onIssueAssigneeChange,
  onIssueDueAtChange,
  onConfirmDraftAnnotation,
  onCancel
}: {
  left: number;
  top: number;
  message: string;
  mode: "note" | "issue";
  issueTitle: string;
  issueSeverity: ApprovalIssueSeverity;
  issueAssigneeId: string;
  issueDueAt: string;
  issueAssignees: User[];
  busy: boolean;
  onMessageChange: (message: string) => void;
  onModeChange: (mode: "note" | "issue") => void;
  onIssueTitleChange: (title: string) => void;
  onIssueSeverityChange: (severity: ApprovalIssueSeverity) => void;
  onIssueAssigneeChange: (userId: string) => void;
  onIssueDueAtChange: (dueAt: string) => void;
  onConfirmDraftAnnotation: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className={draftStyles.popover}
      style={{ left, top }}
      onSubmit={(event) => {
        event.preventDefault();
        void onConfirmDraftAnnotation();
      }}
    >
      <div className={draftStyles.mode} role="group" aria-label="批注类型">
        <button type="button" data-selected={mode === "note"} aria-pressed={mode === "note"} onClick={() => onModeChange("note")}>普通说明</button>
        <button type="button" data-selected={mode === "issue"} aria-pressed={mode === "issue"} onClick={() => onModeChange("issue")}>正式问题</button>
      </div>
      {mode === "issue" ? <>
        <label className={draftStyles.field}>问题标题
          <input id="annotation-issue-title" value={issueTitle} onChange={(event) => onIssueTitleChange(event.target.value)} placeholder="例如：轴承孔公差未标注" />
        </label>
        <div className={draftStyles.row}>
          <label className={draftStyles.field}>严重级
            <select id="annotation-issue-severity" value={issueSeverity} onChange={(event) => onIssueSeverityChange(event.target.value as ApprovalIssueSeverity)}>
              <option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">严重</option>
            </select>
          </label>
          <label className={draftStyles.field}>负责人
            <select id="annotation-issue-assignee" value={issueAssigneeId} onChange={(event) => onIssueAssigneeChange(event.target.value)}>
              <option value="" disabled>选择设计人员</option>
              {issueAssignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.displayName}</option>)}
            </select>
          </label>
        </div>
        <label className={draftStyles.field}>到期时间
          <input id="annotation-issue-due-at" type="datetime-local" value={issueDueAt} onChange={(event) => onIssueDueAtChange(event.target.value)} />
        </label>
      </> : null}
      <label className={draftStyles.field}>
        {mode === "issue" ? "问题说明" : "说明内容"}
        <textarea
          id="annotation-issue-message"
          autoFocus
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          placeholder="说明这个位置需要修改或确认的内容"
        />
      </label>
      <div className={draftStyles.actions}>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>取消</Button>
        <Button type="submit" size="sm" loading={busy}
          disabled={!message.trim() || (mode === "issue" && (!issueTitle.trim() || !issueAssigneeId))}>
          {mode === "issue" ? "创建正式问题" : "保存说明"}
        </Button>
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
    <Dialog open title="打印签后 PDF" size="lg" onClose={onCancel} closeDisabled={busy}
      description="系统打印回调成功后，将自动标记打印归档。"
      footer={<>
        <ButtonLink variant="secondary" href={signedPdfUrl} target="_blank" rel="noreferrer">预览签后 PDF</ButtonLink>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>取消</Button>
        <Button type="submit" form="print-settings-form" loading={busy} loadingLabel="打印中">打印并归档</Button>
      </>}>
      <form id="print-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onPrintAndArchive();
        }}
      >
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        <div className="print-settings-grid">
          <Select id="print-printer" label="系统打印机" value={settings.printerName}
            onChange={(event) => onSettingsChange({ printerName: event.target.value })}
            options={[{ value: "", label: "使用系统默认打印机" }, ...printers.map((printer) => ({
              value: printer.name, label: `${printer.displayName || printer.name}${printer.isDefault ? "（默认）" : ""}`
            }))]} />
          <NumberInput id="print-copies" label="份数" min={1} max={99} value={settings.copies}
            onChange={(event) => onSettingsChange({ copies: Number(event.target.value) })} />
          <TextInput id="print-page-range" label="打印范围" value={settings.pageRange}
            onChange={(event) => onSettingsChange({ pageRange: event.target.value })} placeholder="留空为全部，例如 1,3,5-8" />
          <Select id="print-paper" label="纸张" value={settings.paperSize}
            onChange={(event) => onSettingsChange({ paperSize: event.target.value as PrintSettings["paperSize"] })}
            options={paperSizeOptions} />
          <Select id="print-orientation" label="方向" value={settings.orientation}
            onChange={(event) => onSettingsChange({ orientation: event.target.value as PrintSettings["orientation"] })}
            options={[{ value: "portrait", label: "纵向" }, { value: "landscape", label: "横向" }]} />
          <Select id="print-color" label="颜色" value={settings.colorMode}
            onChange={(event) => onSettingsChange({ colorMode: event.target.value as PrintSettings["colorMode"] })}
            options={[{ value: "color", label: "彩色" }, { value: "grayscale", label: "黑白" }]} />
          <Select id="print-duplex" label="双面" value={settings.duplexMode}
            onChange={(event) => onSettingsChange({ duplexMode: event.target.value as PrintSettings["duplexMode"] })}
            options={[{ value: "simplex", label: "单面" }, { value: "longEdge", label: "长边双面" }, { value: "shortEdge", label: "短边双面" }]} />
          <Select id="print-margin" label="边距" value={settings.marginMode}
            onChange={(event) => onSettingsChange({ marginMode: event.target.value as PrintSettings["marginMode"] })}
            options={[{ value: "default", label: "默认" }, { value: "none", label: "无边距" }, { value: "printableArea", label: "可打印区域" }]} />
          <NumberInput id="print-scale" label="缩放比例" min={25} max={200} value={settings.scaleFactor}
            onChange={(event) => onSettingsChange({ scaleFactor: Number(event.target.value) })} />
          <Checkbox id="print-background" label="打印背景" checked={settings.printBackground}
            onChange={(event) => onSettingsChange({ printBackground: event.target.checked })} />
        </div>
        <p className="print-settings-note">
          应用能确认打印任务已提交给 Windows，无法判断打印机后续缺纸、卡纸或实际出纸状态。
        </p>
      </form>
    </Dialog>
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

function emptyPdmRepairDraft(): PdmRepairDraft {
  return { documentCode: "", materialCode: "", drawingName: "" };
}

function pdmRepairDraftFromApproval(approval: Approval): PdmRepairDraft {
  return {
    documentCode: approval.documentCode ?? "",
    materialCode: approval.materialCode ?? "",
    drawingName: approval.drawingName ?? approval.partName
  };
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

function annotationToInput(annotation: ApprovalAnnotation): ApprovalAnnotationInput {
  return {
    kind: annotation.kind,
    message: annotation.message,
    pageNumber: annotation.pageNumber,
    xRatio: annotation.xRatio,
    yRatio: annotation.yRatio,
    widthRatio: annotation.widthRatio,
    heightRatio: annotation.heightRatio,
    endXRatio: annotation.endXRatio,
    endYRatio: annotation.endYRatio,
    pointsJson: annotation.pointsJson,
    styleJson: annotation.styleJson,
    color: annotation.color
  };
}

function duplicateAnnotationInput(annotation: ApprovalAnnotation): ApprovalAnnotationInput {
  const input = annotationToInput(annotation);
  const delta = 0.02;
  input.xRatio = clamp(annotation.xRatio + delta, 0, 1 - (annotation.widthRatio ?? 0));
  input.yRatio = clamp(annotation.yRatio + delta, 0, 1 - (annotation.heightRatio ?? 0));
  if (annotation.endXRatio !== null) input.endXRatio = clamp(annotation.endXRatio + delta, 0, 1);
  if (annotation.endYRatio !== null) input.endYRatio = clamp(annotation.endYRatio + delta, 0, 1);
  if (annotation.pointsJson) {
    try {
      const points = JSON.parse(annotation.pointsJson) as Array<{ xRatio: number; yRatio: number }>;
      input.pointsJson = JSON.stringify(points.map((point) => ({
        xRatio: clamp(point.xRatio + delta, 0, 1),
        yRatio: clamp(point.yRatio + delta, 0, 1)
      })));
    } catch {
      input.pointsJson = annotation.pointsJson;
    }
  }
  return input;
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
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : readPaletteHex("--palette-info-500");
}

function readPaletteHex(token: string) {
  if (typeof window === "undefined") return "";
  const color = window.getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : "";
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
  { color: "red", label: "红色", tone: "var(--color-danger)" },
  { color: "amber", label: "橙色", tone: "var(--color-warning)" },
  { color: "blue", label: "蓝色", tone: "var(--color-info)" },
  { color: "green", label: "绿色", tone: "var(--color-success)" }
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
