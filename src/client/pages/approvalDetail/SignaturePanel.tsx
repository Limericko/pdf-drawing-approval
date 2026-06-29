import type { Approval, SignaturePlacement } from "../../api.ts";
import { getSignedFileUrl } from "../../api.ts";
import { StatusChip } from "../../widgets/StatusChip.tsx";

export function SignaturePanel({
  approval,
  signedPdfReady,
  signedPdfCacheKey,
  signatureRequired,
  canRegenerateSigned,
  busyAction,
  showPlacementPanel,
  placementEditing,
  signaturePlacements,
  canEditPlacements,
  canSaveTemplate,
  pdfReady,
  savingPlacements,
  savingTemplate,
  templateName,
  onRetrySigning,
  onTogglePlacementEditing,
  onResetPlacements,
  onSavePlacements,
  onTemplateNameChange,
  onSaveTemplate
}: {
  approval: Approval;
  signedPdfReady: boolean;
  signedPdfCacheKey: string;
  signatureRequired: boolean;
  canRegenerateSigned: boolean;
  busyAction: string;
  showPlacementPanel: boolean;
  placementEditing: boolean;
  signaturePlacements: SignaturePlacement[];
  canEditPlacements: boolean;
  canSaveTemplate: boolean;
  pdfReady: boolean;
  savingPlacements: boolean;
  savingTemplate: boolean;
  templateName: string;
  onRetrySigning: () => void;
  onTogglePlacementEditing: () => void;
  onResetPlacements: () => void;
  onSavePlacements: () => void;
  onTemplateNameChange: (name: string) => void;
  onSaveTemplate: () => void;
}) {
  return (
    <div className="signed-file-panel">
      <div className="panel-heading compact-heading">
        <div>
          <h2>签审输出</h2>
          <span>左侧保留原始 PDF，签后 PDF 用于正式打印。</span>
        </div>
        <StatusChip status={approval.signatureStatus} context="signature" />
      </div>
      <dl className="compact-dl">
        <dt>签后文件</dt>
        <dd>{approval.signedFilePath ?? "尚未生成"}</dd>
        <dt>生成时间</dt>
        <dd>{approval.signedAt ? new Date(approval.signedAt).toLocaleString() : "未生成"}</dd>
        <dt>签后哈希</dt>
        <dd>{approval.signedFileHash ?? "未记录"}</dd>
      </dl>
      {signedPdfReady && (
        <a className="button-link signed-file-link" href={getSignedFileUrl(approval.id, signedPdfCacheKey)} target="_blank" rel="noreferrer">
          打开签后 PDF
        </a>
      )}
      {approval.signatureStatus === "failed" && (
        <div className="signature-warning">
          <strong>签名生成失败</strong>
          <span>{approval.signatureError ?? "未记录具体错误，请查看操作日志。"}</span>
        </div>
      )}
      {canRegenerateSigned && (
        <button type="button" className="secondary-button" onClick={onRetrySigning} disabled={busyAction === "sign"}>
          {busyAction === "sign" ? "生成中" : "重新生成签后 PDF"}
        </button>
      )}
      {showPlacementPanel && (
        <div className="signature-placement-panel">
          <div className="panel-heading compact-heading">
            <div>
              <h2>签名位置</h2>
              <span>{placementEditing ? "编辑中" : `${signaturePlacements.length} 个位置`}</span>
            </div>
          </div>
          <div className="signature-placement-summary signature-placement-summary--compact">
            {signaturePlacements.map((placement) => (
              <div key={placement.role}>
                <strong>{roleLabel(placement.role)}</strong>
                <span>
                  第 {placement.pageNumber} 页 · X {Math.round(placement.xRatio * 100)}% · Y {Math.round(placement.yRatio * 100)}%
                </span>
              </div>
            ))}
          </div>
          {canEditPlacements ? (
            <>
              <div className="placement-actions">
                <button type="button" className="secondary-button" onClick={onTogglePlacementEditing} disabled={!pdfReady}>
                  {placementEditing ? "收起编辑" : "编辑签名框"}
                </button>
                <button type="button" className="secondary-button" onClick={onResetPlacements} disabled={!pdfReady}>
                  重置默认
                </button>
                <button type="button" onClick={onSavePlacements} disabled={savingPlacements || !pdfReady}>
                  {savingPlacements ? "保存中" : "保存签名位置"}
                </button>
              </div>
              {canSaveTemplate && (
                <div className="template-save-row">
                  <input
                    value={templateName}
                    onChange={(event) => onTemplateNameChange(event.target.value)}
                    placeholder="模板名称，如 A3 标准图框"
                  />
                  <button type="button" className="secondary-button" onClick={onSaveTemplate} disabled={savingTemplate || !templateName.trim()}>
                    {savingTemplate ? "保存中" : "保存为模板"}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="signature-warning signature-warning--soft">
              <strong>等待签名定位</strong>
              <span>设计师或管理员补充位置后可继续生成签后 PDF。</span>
            </div>
          )}
        </div>
      )}
      {approval.status === "approved_for_print" && signatureRequired && !signedPdfReady && (
        <div className="signature-warning signature-warning--soft">
          <strong>待打印文件未就绪</strong>
          <span>此图纸需要签审 PDF。签后 PDF 生成前，请不要按原始 PDF 打印归档。</span>
        </div>
      )}
    </div>
  );
}

function roleLabel(role: SignaturePlacement["role"]) {
  return {
    designer: "设计",
    supervisor: "主管",
    process: "工艺"
  }[role];
}
