import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  confirmBatchSubmission,
  confirmSubmission,
  getProfile,
  listSubmissionExistingVersions,
  listSignatureTemplates,
  uploadBatchSubmission,
  uploadSubmissionPdf,
  type BatchSubmission,
  type BatchUploadItem,
  type Approval,
  type SignaturePlacement,
  type SignatureTemplate,
  type SubmissionUploadResult
} from "../api.ts";
import { defaultSignaturePlacements } from "../widgets/SignaturePlacementEditor.tsx";

type PlacementState = "missing" | "template" | "manual";
type BatchItemStatus = "ready" | "invalid" | "uploaded" | "submitting" | "completed" | "failed";

const PdfSignaturePlacementWorkspace = lazy(() =>
  import("../widgets/PdfSignaturePlacementWorkspace.tsx").then((module) => ({ default: module.PdfSignaturePlacementWorkspace }))
);

export type BatchSubmitItem = {
  clientId: string;
  fileName: string;
  file?: File;
  previewUrl: string;
  uploadId?: string;
  status: BatchItemStatus;
  projectName: string;
  partName: string;
  version: string;
  placements: SignaturePlacement[];
  placementState: PlacementState;
  templateId?: number;
  error?: string;
  approvalId?: number | null;
  existingVersions?: Approval[];
};

export function SubmitDrawingPage() {
  const [items, setItems] = useState<BatchSubmitItem[]>([]);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [signatureTemplates, setSignatureTemplates] = useState<SignatureTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [commonProjects, setCommonProjects] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [batchResult, setBatchResult] = useState<BatchSubmission | null>(null);
  const previewUrlsRef = useRef<string[]>([]);

  const selectedItem = items.find((item) => item.clientId === selectedClientId) ?? items[0] ?? null;
  const previewUrl = selectedItem?.previewUrl ?? "";
  const placements = selectedItem?.placements ?? defaultSignaturePlacements();
  const multiFileMode = items.length > 1;
  const selectedVersionWarning = versionTraceWarning(selectedItem?.existingVersions);
  const versionLookupKey = useMemo(
    () => items.map((item) => `${item.clientId}:${item.partName.trim()}`).join("|"),
    [items]
  );
  const submitReason = useMemo(() => submitDisabledReason(projectName, items), [items, projectName]);
  const canSubmit = !submitReason;
  const uploadableCount = items.filter((item) => item.status === "uploaded").length;
  const infoReady = items.length > 0 && items.every((item) => item.status !== "uploaded" || (item.partName.trim() && item.version.trim()));
  const placementsReady = items.length > 0 && items.every((item) => item.status !== "uploaded" || hasRequiredSignaturePlacementRoles(item.placements));

  useEffect(() => {
    return () => {
      revokePreviewUrls(previewUrlsRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getProfile()
      .then((profile) => {
        if (!cancelled) setCommonProjects(profile.commonProjects);
      })
      .catch(() => {
        if (!cancelled) setCommonProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const project = projectName.trim();
    listSignatureTemplates(project || undefined)
      .then((templates) => {
        if (cancelled) return;
        setSignatureTemplates(templates);
        setSelectedTemplateId((current) => (templates.some((template) => String(template.id) === current) ? current : ""));
      })
      .catch(() => {
        if (!cancelled) setSignatureTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  useEffect(() => {
    let cancelled = false;
    const project = projectName.trim();
    const lookupPlan = buildExistingVersionLookupPlan(project, items);
    if (lookupPlan.length === 0) return;

    const timeoutId = window.setTimeout(() => {
      Promise.all(
        lookupPlan.map((request) =>
          listSubmissionExistingVersions(project, request.partName)
            .then((existingVersions) => request.clientIds.map((clientId) => ({ clientId, existingVersions })))
            .catch(() => [])
        )
      ).then((results) => {
        if (cancelled) return;
        setItems((current) => mergeExistingVersionHints(current, results.flat()));
      });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [projectName, versionLookupKey]);

  async function chooseFiles(fileList: FileList | null) {
    revokePreviewUrls(previewUrlsRef.current);
    setError("");
    setMessage("");
    setBatchResult(null);

    const files = Array.from(fileList ?? []);
    const nextItems = files.map(createBatchItem);
    previewUrlsRef.current = nextItems.map((item) => item.previewUrl);
    setItems(nextItems);
    setSelectedClientId(nextItems[0]?.clientId ?? "");
    if (nextItems.length === 0) return;

    setBusy("upload");
    try {
      const project = projectName.trim();
      if (nextItems.length === 1) {
        const result = await uploadSubmissionPdf(nextItems[0].file!, project || undefined);
        applySingleUploadResult(nextItems[0].clientId, result);
      } else {
        const result = await uploadBatchSubmission(files, project || undefined);
        applyBatchUploadResult(nextItems, result.items);
      }
      setMessage(nextItems.length === 1 ? "PDF 已上传，请确认图纸信息和签名位置。" : "PDF 已批量上传，请逐张确认信息和签名位置。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setBusy("");
    }
  }

  function applySingleUploadResult(clientId: string, result: SubmissionUploadResult) {
    setItems((current) =>
      current.map((item) =>
        item.clientId === clientId
          ? {
              ...item,
              uploadId: result.uploadId,
              status: "uploaded",
              partName: result.parsed?.partName ?? item.partName,
              version: result.parsed?.version ?? item.version,
              existingVersions: result.existingVersions ?? []
            }
          : item
      )
    );
  }

  function applyBatchUploadResult(currentItems: BatchSubmitItem[], results: BatchUploadItem[]) {
    setItems(
      currentItems.map((item, index) => {
        const result = results[index];
        if (!result || result.status === "failed") {
          return { ...item, status: "failed", error: result?.error ?? "UPLOAD_FAILED", placementState: "missing" };
        }
        return {
          ...item,
          uploadId: result.uploadId,
          status: "uploaded",
          partName: result.parsed?.partName ?? item.partName,
          version: result.parsed?.version ?? item.version,
          existingVersions: result.existingVersions ?? []
        };
      })
    );
  }

  function setPlacements(nextPlacements: SignaturePlacement[]) {
    if (!selectedItem) return;
    setItems((current) => updateBatchItemPlacements(current, selectedItem.clientId, nextPlacements));
  }

  function updateSelectedItem(input: Partial<Pick<BatchSubmitItem, "partName" | "version">>) {
    if (!selectedItem) return;
    setItems((current) => current.map((item) => (item.clientId === selectedItem.clientId ? { ...item, ...input } : item)));
  }

  function applySelectedTemplate() {
    const template = selectedTemplate();
    if (!template || !selectedItem) return;
    setItems((current) => applyTemplateToSelectedBatchItem(current, selectedItem.clientId, template, template.id));
    setMessage(`已套用签名模板：${template.name}`);
  }

  function applyTemplateToAllItems() {
    const template = selectedTemplate();
    if (!template) return;
    setItems((current) => applyTemplateToBatchItems(current, template, template.id));
    setMessage(`已批量套用签名模板：${template.name}`);
  }

  function resetSelectedPlacements() {
    if (!selectedItem) return;
    setItems((current) => updateBatchItemPlacements(current, selectedItem.clientId, defaultSignaturePlacements()));
  }

  async function submit() {
    const uploadable = items.filter((item) => item.status === "uploaded");
    if (uploadable.length === 0) return;
    setBusy("submit");
    setError("");
    setMessage("");
    setBatchResult(null);
    try {
      if (uploadable.length === 1 && items.length === 1) {
        const item = uploadable[0];
        const approval = await confirmSubmission({
          uploadId: item.uploadId!,
          projectName,
          partName: item.partName,
          version: item.version,
          placements: item.placements
        });
        setMessage("图纸已提交审批。");
        location.hash = `/approvals/${approval.id}`;
        return;
      }

      setItems((current) =>
        current.map((item) => (item.status === "uploaded" ? { ...item, status: "submitting" } : item))
      );
      const result = await confirmBatchSubmission({
        projectName,
        items: uploadable.map((item) => ({
          uploadId: item.uploadId,
          fileName: item.fileName,
          partName: item.partName,
          version: item.version,
          placements: item.placements,
          placementState: item.placementState
        }))
      });
      setBatchResult(result);
      setItems((current) => mergeBatchResult(current, result));
      setMessage(`批量提交完成：成功 ${result.successCount}，失败 ${result.failedCount}。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
      setItems((current) => current.map((item) => (item.status === "submitting" ? { ...item, status: "uploaded" } : item)));
    } finally {
      setBusy("");
    }
  }

  function selectedTemplate() {
    return signatureTemplates.find((item) => String(item.id) === selectedTemplateId);
  }

  return (
    <section>
      <div className="page-heading row">
        <div>
          <span className="eyebrow">SUBMIT DRAWING</span>
          <h1>上传并提交图纸</h1>
          <p>逐张确认零件、版本和三处签名框后提交审批。</p>
        </div>
        <button type="button" className="secondary-button" onClick={resetSelectedPlacements} disabled={!selectedItem}>
          重置签名框
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <div className="submit-layout">
        <aside className="submit-panel">
          <label>
            PDF 文件
            <input
              type="file"
              accept="application/pdf,.pdf"
              multiple
              onChange={(event) => void chooseFiles(event.target.files)}
            />
          </label>
          <div className="submit-form-grid">
            <label>
              项目
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="例如 项目A" />
            </label>
            {commonProjects.length > 0 && (
              <div className="common-projects" aria-label="常用项目">
                <span>常用项目</span>
                <div>
                  {commonProjects.map((project) => (
                    <button
                      key={project}
                      type="button"
                      className="common-project-chip"
                      onClick={() => setProjectName(applyCommonProject(projectName, project))}
                    >
                      {project}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {selectedItem && (
              <>
                <label>
                  零件
                  <input value={selectedItem.partName} onChange={(event) => updateSelectedItem({ partName: event.target.value })} placeholder="零件名" />
                </label>
                <label>
                  版本
                  <input value={selectedItem.version} onChange={(event) => updateSelectedItem({ version: event.target.value })} placeholder="a0A0" />
                </label>
              </>
            )}
          </div>
          {selectedVersionWarning && (
            <div className="version-trace-warning">
              <strong>版本提醒</strong>
              <span>{selectedVersionWarning}</span>
            </div>
          )}
          <div className="template-selector">
            <label>
              签名模板
              <select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}>
                <option value="">不使用模板</option>
                {signatureTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}{template.projectName ? ` · ${template.projectName}` : " · 通用"}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="secondary-button" onClick={applySelectedTemplate} disabled={!selectedTemplateId || !selectedItem}>
              套用模板
            </button>
          </div>
          {multiFileMode && (
            <button type="button" className="secondary-button" onClick={applyTemplateToAllItems} disabled={!selectedTemplateId}>
              批量套用模板
            </button>
          )}
          <div className="submit-checklist" aria-label="提交前检查">
            <SubmitCheckItem label="PDF" value={items.length > 0 ? `已选择 ${items.length} 个` : "未选择"} complete={items.length > 0 && uploadableCount > 0} />
            <SubmitCheckItem label="项目" value={projectName.trim() || "未填写"} complete={Boolean(projectName.trim())} />
            <SubmitCheckItem label="零件和版本" value={infoReady ? "已补全" : "待补全"} complete={infoReady} />
            <SubmitCheckItem label="签名框" value={placementsReady ? "已放置" : "待放置"} complete={placementsReady} />
          </div>
          {items.length > 0 && (
            <div className="batch-item-list">
              {items.map((item) => (
                <div
                  key={item.clientId}
                  className={item.clientId === selectedItem?.clientId ? "batch-item-row batch-item-row--active" : "batch-item-row"}
                >
                  <button type="button" className="batch-item-select" onClick={() => setSelectedClientId(item.clientId)}>
                    <span>{item.fileName}</span>
                    <strong>{batchStatusLabel(item.status)}</strong>
                    <small>
                      {placementStateLabel(item.placementState)}
                      {item.existingVersions?.length ? ` · 同零件已有 ${item.existingVersions.length} 个版本` : ""}
                      {item.error ? ` · ${item.error}` : ""}
                    </small>
                  </button>
                  {batchItemApprovalHref(item) && (
                    <a className="batch-item-detail-link" href={batchItemApprovalHref(item)}>
                      查看图纸
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="signature-placement-summary">
            {placements.map((placement) => (
              <div key={placement.role}>
                <strong>{roleLabel(placement.role)}</strong>
                <span>
                  第 {placement.pageNumber} 页 · X {Math.round(placement.xRatio * 100)}% · Y {Math.round(placement.yRatio * 100)}%
                </span>
              </div>
            ))}
          </div>
          {batchResult && (
            <div className="batch-result-summary">
              <strong>{batchStatusLabel(batchResult.status)}</strong>
              <span>成功 {batchResult.successCount} · 失败 {batchResult.failedCount}</span>
            </div>
          )}
          {submitReason && <div className="submit-disabled-reason">{submitReason}</div>}
          <button type="button" onClick={submit} disabled={!canSubmit || busy === "submit"}>
            {busy === "submit" ? "提交中" : multiFileMode ? "批量提交审批" : "提交审批"}
          </button>
        </aside>

        <div className="placement-workspace">
          {previewUrl ? (
            <Suspense fallback={<div className="empty empty-state">正在加载 PDF 定位工具...</div>}>
              <PdfSignaturePlacementWorkspace pdfUrl={previewUrl} placements={placements} onChange={setPlacements} />
            </Suspense>
          ) : (
            <div className="empty empty-state">
              <strong>选择 PDF 后开始定位</strong>
              <span>左侧上传后，在 PDF 预览上拖动并缩放三处签名框。</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function createBatchItem(file: File, index: number): BatchSubmitItem {
  return {
    clientId: `${Date.now()}-${index}-${file.name}`,
    fileName: file.name,
    file,
    previewUrl: URL.createObjectURL(file),
    status: "ready",
    projectName: "",
    partName: parsePartName(file.name),
    version: "",
    placements: defaultSignaturePlacements(),
    placementState: "manual"
  };
}

function mergeBatchResult(items: BatchSubmitItem[], result: BatchSubmission): BatchSubmitItem[] {
  const resultByFileName = new Map(result.items.map((item) => [item.fileName, item]));
  return items.map((item) => {
    const resultItem = resultByFileName.get(item.fileName);
    if (!resultItem) return item;
    return {
      ...item,
      status: resultItem.status === "completed" ? "completed" : "failed",
      error: resultItem.errorMessage ?? undefined,
      approvalId: resultItem.approvalId
    };
  });
}

export function applySignatureTemplatePlacements(
  _current: SignaturePlacement[],
  template: Pick<SignatureTemplate, "placements">
): SignaturePlacement[] {
  return template.placements.map((placement) => ({ ...placement }));
}

export function applyCommonProject(_projectName: string, project: string) {
  return project.trim();
}

export function applyTemplateToBatchItems<T extends { placements: SignaturePlacement[]; placementState: string; templateId?: number }>(
  items: T[],
  template: Pick<SignatureTemplate, "placements">,
  templateId?: number
): T[] {
  return items.map((item) => ({
    ...item,
    placements: applySignatureTemplatePlacements(item.placements, template),
    placementState: "template",
    templateId
  }));
}

export function applyTemplateToSelectedBatchItem<
  T extends { clientId: string; placements: SignaturePlacement[]; placementState: string; templateId?: number }
>(items: T[], selectedClientId: string, template: Pick<SignatureTemplate, "placements">, templateId?: number): T[] {
  return items.map((item) =>
    item.clientId === selectedClientId
      ? {
          ...item,
          placements: applySignatureTemplatePlacements(item.placements, template),
          placementState: "template",
          templateId
        }
      : item
  );
}

export function updateBatchItemPlacements<T extends { clientId: string; placements: SignaturePlacement[]; placementState: string }>(
  items: T[],
  selectedClientId: string,
  placements: SignaturePlacement[]
): T[] {
  return items.map((item) =>
    item.clientId === selectedClientId
      ? { ...item, placements: placements.map((placement) => ({ ...placement })), placementState: "manual" }
      : item
  );
}

export function versionTraceWarning(versions: Array<Pick<Approval, "version">> | undefined) {
  if (!versions || versions.length === 0) return "";
  const preview = versions.slice(0, 3).map((item) => item.version).join("、");
  const suffix = versions.length > 3 ? ` 等 ${versions.length} 个版本` : "";
  return `同零件已有 ${versions.length} 个版本：${preview}${suffix}`;
}

export function mergeExistingVersionHints<T extends { clientId: string; existingVersions?: Approval[] }>(
  items: T[],
  hints: Array<{ clientId: string; existingVersions: Approval[] }>
): T[] {
  const versionsByItem = new Map(hints.map((hint) => [hint.clientId, hint.existingVersions]));
  return items.map((item) =>
    versionsByItem.has(item.clientId)
      ? { ...item, existingVersions: versionsByItem.get(item.clientId)?.map((version) => ({ ...version })) ?? [] }
      : item
  );
}

export function buildExistingVersionLookupPlan(
  projectName: string,
  items: Array<{ clientId: string; partName: string }>
): Array<{ partName: string; clientIds: string[] }> {
  if (!projectName.trim()) return [];
  const clientIdsByPartName = new Map<string, string[]>();
  for (const item of items) {
    const partName = item.partName.trim();
    if (!partName) continue;
    const clientIds = clientIdsByPartName.get(partName) ?? [];
    clientIds.push(item.clientId);
    clientIdsByPartName.set(partName, clientIds);
  }
  return [...clientIdsByPartName.entries()].map(([partName, clientIds]) => ({ partName, clientIds }));
}

export function submitDisabledReason(
  projectName: string,
  items: Array<{ status: string; partName: string; version: string; placements: Array<{ role: string }> }>
) {
  if (items.length === 0) return "请选择 PDF 文件";
  const uploadable = items.filter((item) => item.status === "uploaded");
  if (uploadable.length === 0) {
    if (items.every((item) => item.status === "completed")) return "已提交完成";
    return "当前没有可提交的文件";
  }
  if (!projectName.trim()) return "请填写项目名称";
  if (uploadable.some((item) => !item.partName.trim() || !item.version.trim())) return "请补全零件名称和版本";
  if (uploadable.some((item) => !hasRequiredSignaturePlacementRoles(item.placements))) return "请放置设计、主管、工艺三个签名框";
  return "";
}

export function batchItemApprovalHref(item: { status: string; approvalId?: number | null }) {
  return item.status === "completed" && item.approvalId ? `#/approvals/${item.approvalId}` : "";
}

function hasRequiredSignaturePlacementRoles(placements: Array<{ role: string }>) {
  const roles = new Set(placements.map((placement) => placement.role));
  return placements.length === 3 && roles.size === 3 && roles.has("designer") && roles.has("supervisor") && roles.has("process");
}

function SubmitCheckItem(props: { label: string; value: string; complete: boolean }) {
  return (
    <div className={props.complete ? "submit-check-item submit-check-item--complete" : "submit-check-item"}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <em>{props.complete ? "完成" : "待补"}</em>
    </div>
  );
}

function parsePartName(fileName: string) {
  return fileName.replace(/\.pdf$/i, "").replace(/-[a-z]\d[A-Z]\d$/, "");
}

function roleLabel(role: SignaturePlacement["role"]) {
  return {
    designer: "设计",
    supervisor: "主管",
    process: "工艺"
  }[role];
}

function batchStatusLabel(status: BatchItemStatus | BatchSubmission["status"]) {
  return {
    ready: "待上传",
    invalid: "无效",
    uploaded: "已上传",
    submitting: "提交中",
    completed: "成功",
    failed: "失败",
    running: "处理中",
    partial: "部分成功"
  }[status];
}

function placementStateLabel(state: PlacementState | string | null) {
  return {
    missing: "签名框缺失",
    template: "已套用模板",
    manual: "已人工调整"
  }[state ?? "missing"];
}

function revokePreviewUrls(urls: string[]) {
  for (const url of urls) {
    if (url) URL.revokeObjectURL(url);
  }
}
