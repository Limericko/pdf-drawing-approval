import { ExternalLink } from "lucide-react";
import type { Approval, User } from "../../api.ts";
import {
  canRepairPdmMetadata,
  canRetryPdmPublish,
  pdmMetadataStatusCopy,
  pdmPublishStatusCopy
} from "../approvalDetailLogic.ts";
import styles from "./PdmMetadataPanel.module.css";

export type PdmRepairDraft = {
  documentCode: string;
  materialCode: string;
  drawingName: string;
};

export function PdmMetadataPanel({
  approval,
  user,
  draft,
  editing,
  busyAction,
  onDraftChange,
  onStartEdit,
  onCancelEdit,
  onSaveRepair,
  onRetryPublish
}: {
  approval: Approval;
  user: User;
  draft: PdmRepairDraft;
  editing: boolean;
  busyAction: string;
  onDraftChange: (draft: PdmRepairDraft) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveRepair: () => void;
  onRetryPublish: () => void;
}) {
  const canRepair = canRepairPdmMetadata(user, approval);
  const canPublish = canRetryPdmPublish(user, approval);
  const partHref = approval.materialCode?.trim()
    ? `#/pdm?keyword=${encodeURIComponent(approval.materialCode.trim())}`
    : "";

  return (
    <section className={styles.panel}>
      <div className="section-title-row">
        <div>
          <span className="eyebrow">PDM</span>
          <h2>PDM 信息</h2>
        </div>
        {canRepair && !editing && (
          <button type="button" className="secondary-button" onClick={onStartEdit}>
            补录 PDM 信息
          </button>
        )}
      </div>

      <dl className={`compact-dl ${styles.metadata}`}>
        <dt>体系文件号</dt>
        <dd>{approval.documentCode || "待补"}</dd>
        <dt>管家婆物料号</dt>
        <dd>{approval.materialCode || "待补"}</dd>
        <dt>图纸名称</dt>
        <dd>{approval.drawingName || approval.partName}</dd>
        <dt>元数据状态</dt>
        <dd>{pdmMetadataStatusCopy(approval.pdmMetadataStatus)}</dd>
        <dt>PDM 发布状态</dt>
        <dd>{pdmPublishStatusCopy(approval.pdmPublishStatus)}</dd>
        <dt>关联零件档案</dt>
        <dd>
          {partHref ? (
            <a className="table-action-link" href={partHref}>
              <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
              查询零件库
            </a>
          ) : (
            "待补物料号"
          )}
        </dd>
        {approval.pdmPublishError && (
          <>
            <dt>发布问题</dt>
            <dd className={styles.danger}>{approval.pdmPublishError}</dd>
          </>
        )}
      </dl>

      {editing && (
        <div className={styles.repairForm}>
          <label>
            体系文件号
            <input
              value={draft.documentCode}
              onChange={(event) => onDraftChange({ ...draft, documentCode: event.target.value })}
              placeholder="例如 MP300A000072，可后补"
            />
          </label>
          <label>
            管家婆物料号
            <input
              value={draft.materialCode}
              onChange={(event) => onDraftChange({ ...draft, materialCode: event.target.value })}
              placeholder="例如 0102A00700883"
            />
          </label>
          <label>
            图纸名称
            <input
              value={draft.drawingName}
              onChange={(event) => onDraftChange({ ...draft, drawingName: event.target.value })}
              placeholder="例如 400A按键"
            />
          </label>
          <div className="actions">
            <button type="button" className="secondary-button" onClick={onCancelEdit} disabled={busyAction === "pdm-repair"}>
              取消
            </button>
            <button type="button" onClick={onSaveRepair} disabled={!draft.drawingName.trim() || busyAction === "pdm-repair"}>
              {busyAction === "pdm-repair" ? "保存中" : "保存补录"}
            </button>
          </div>
        </div>
      )}

      {canPublish && (
        <button type="button" className="secondary-button" onClick={onRetryPublish} disabled={busyAction === "pdm-publish"}>
          {busyAction === "pdm-publish" ? "发布中" : "发布到 PDM"}
        </button>
      )}
    </section>
  );
}
