import type { Approval, ApprovalAnnotation, User } from "../../api.ts";
import { canEditAnnotation, canResolveAnnotation, type AnnotationFilterState } from "../approvalDetailLogic.ts";

type AnnotationFilters = Omit<AnnotationFilterState, "currentUserId">;

export function AnnotationSidePanel({
  approval,
  user,
  annotations,
  filteredAnnotations,
  selectedAnnotation,
  annotationMessage,
  annotationFilters,
  annotationReadonlyMessage,
  annotationCacheKey,
  annotatedFileUrl,
  openAnnotationCount,
  canCreateAnnotations,
  continuousAnnotationMode,
  busyAction,
  onContinuousAnnotationModeChange,
  onAnnotationMessageChange,
  onUpdateSelectedAnnotation,
  onCancelSelectedAnnotation,
  onFilterChange,
  onSelectAnnotation,
  onResolveAnnotation,
  onRemoveAnnotation,
  onResetAnnotations
}: {
  approval: Approval;
  user: User;
  annotations: ApprovalAnnotation[];
  filteredAnnotations: ApprovalAnnotation[];
  selectedAnnotation: ApprovalAnnotation | null;
  annotationMessage: string;
  annotationFilters: AnnotationFilters;
  annotationReadonlyMessage: string;
  annotationCacheKey: string;
  annotatedFileUrl: string;
  openAnnotationCount: number;
  canCreateAnnotations: boolean;
  continuousAnnotationMode: boolean;
  busyAction: string;
  onContinuousAnnotationModeChange: (enabled: boolean) => void;
  onAnnotationMessageChange: (message: string) => void;
  onUpdateSelectedAnnotation: () => void;
  onCancelSelectedAnnotation: () => void;
  onFilterChange: (filters: AnnotationFilters) => void;
  onSelectAnnotation: (annotation: ApprovalAnnotation) => void;
  onResolveAnnotation: (annotationId: number) => void;
  onRemoveAnnotation: (annotationId: number) => void;
  onResetAnnotations: () => void;
}) {
  return (
    <div className="annotation-panel">
      <div className="panel-heading compact-heading">
        <div>
          <h2>图纸批注</h2>
          <span>{annotations.length} 条 · {openAnnotationCount} 条未处理</span>
        </div>
        {annotations.length > 0 && (
          <div className="annotation-panel-actions">
            <a className="button-link secondary-link" href={annotatedFileUrl} target="_blank" rel="noreferrer">
              审查版 PDF
            </a>
            {canCreateAnnotations && (
              <button type="button" className="secondary-button" onClick={onResetAnnotations} disabled={busyAction === "annotations-reset"}>
                {busyAction === "annotations-reset" ? "回退中" : "回退到初始版"}
              </button>
            )}
          </div>
        )}
      </div>
      {canCreateAnnotations ? (
        <div className="annotation-compose">
          <label className="annotation-continuous-toggle">
            <input
              type="checkbox"
              checked={continuousAnnotationMode}
              onChange={(event) => onContinuousAnnotationModeChange(event.target.checked)}
            />
            连续标注
          </label>
          <div className="annotation-compose__hint">
            <strong>{selectedAnnotation ? `${annotationKindLabel(selectedAnnotation.kind)} · 第 ${selectedAnnotation.pageNumber} 页` : "未选择批注"}</strong>
            <span>{selectedAnnotation ? "可修改说明、颜色，或在左侧拖动位置。" : "在左侧 PDF 工具栏选择类型，画完后填写批注内容。"}</span>
          </div>
          <label>
            选中批注内容
            <textarea
              value={annotationMessage}
              onChange={(event) => onAnnotationMessageChange(event.target.value)}
              placeholder="选中批注后可修改说明"
              disabled={!selectedAnnotation || !canEditAnnotation(user, approval, selectedAnnotation)}
            />
          </label>
          {selectedAnnotation && canEditAnnotation(user, approval, selectedAnnotation) && (
            <div className="annotation-edit-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={onUpdateSelectedAnnotation}
                disabled={busyAction === `annotation-update-${selectedAnnotation.id}`}
              >
                {busyAction === `annotation-update-${selectedAnnotation.id}` ? "保存中" : "保存选中批注"}
              </button>
              <button type="button" className="secondary-button" onClick={onCancelSelectedAnnotation}>
                取消选择
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="signature-warning signature-warning--soft">
          <strong>当前账号不能新增批注</strong>
          <span>{annotationReadonlyMessage}</span>
        </div>
      )}
      <div className="annotation-filters">
        <div className="segmented-control">
          <button type="button" className={annotationFilters.status === "all" ? "active" : ""} onClick={() => onFilterChange({ ...annotationFilters, status: "all" })}>
            全部
          </button>
          <button type="button" className={annotationFilters.status === "open" ? "active" : ""} onClick={() => onFilterChange({ ...annotationFilters, status: "open" })}>
            未处理
          </button>
          <button type="button" className={annotationFilters.status === "resolved" ? "active" : ""} onClick={() => onFilterChange({ ...annotationFilters, status: "resolved" })}>
            已处理
          </button>
        </div>
        <select
          value={annotationFilters.author}
          onChange={(event) => onFilterChange({ ...annotationFilters, author: event.target.value as AnnotationFilters["author"] })}
          aria-label="批注作者筛选"
        >
          <option value="all">全部作者</option>
          <option value="mine">只看我的</option>
        </select>
        <select
          value={annotationFilters.kind}
          onChange={(event) => onFilterChange({ ...annotationFilters, kind: event.target.value as AnnotationFilters["kind"] })}
          aria-label="批注类型筛选"
        >
          <option value="all">全部类型</option>
          {annotationKindOptions.map((kind) => (
            <option key={kind} value={kind}>{annotationKindLabel(kind)}</option>
          ))}
        </select>
      </div>
      <ul className="annotation-list">
        {annotations.length === 0 && <li className="comment-empty">暂无图纸批注，审核人可在左侧 PDF 上直接标记问题。</li>}
        {annotations.length > 0 && filteredAnnotations.length === 0 && <li className="comment-empty">当前筛选下没有批注。</li>}
        {filteredAnnotations.map((annotation) => (
          <li key={annotation.id} className={annotation.resolved ? "annotation-item annotation-item--resolved" : "annotation-item"}>
            <button type="button" className="annotation-item__main" onClick={() => onSelectAnnotation(annotation)}>
              <strong>{annotationKindLabel(annotation.kind)} · 第 {annotation.pageNumber} 页</strong>
              <span>{annotation.message}</span>
              <em>{annotationAuthor(annotation)} · {annotationLocation(annotation)}</em>
            </button>
            <div className="annotation-item__actions">
              {annotation.resolved ? (
                <span>已处理</span>
              ) : (
                <>
                  {canResolveAnnotation(user, approval, annotation) && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => onResolveAnnotation(annotation.id)}
                      disabled={busyAction === `annotation-resolve-${annotation.id}`}
                    >
                      {busyAction === `annotation-resolve-${annotation.id}` ? "处理中" : "标记处理"}
                    </button>
                  )}
                  {canEditAnnotation(user, approval, annotation) && (
                    <button
                      type="button"
                      className="secondary-button danger-lite"
                      onClick={() => onRemoveAnnotation(annotation.id)}
                      disabled={busyAction === `annotation-delete-${annotation.id}`}
                    >
                      {busyAction === `annotation-delete-${annotation.id}` ? "删除中" : "删除"}
                    </button>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function annotationKindLabel(kind: ApprovalAnnotation["kind"]) {
  return {
    pin: "定位",
    rect: "矩形",
    arrow: "箭头",
    circle: "圆形",
    text: "文字",
    ink: "画笔",
    cloud: "云线"
  }[kind];
}

function annotationAuthor(annotation: ApprovalAnnotation) {
  return annotation.authorDisplayName ?? annotation.authorUsername ?? "用户";
}

function annotationLocation(annotation: ApprovalAnnotation) {
  return `X ${Math.round(annotation.xRatio * 100)}% · Y ${Math.round(annotation.yRatio * 100)}%`;
}

const annotationKindOptions: ApprovalAnnotation["kind"][] = ["pin", "arrow", "rect", "circle", "text", "ink", "cloud"];
