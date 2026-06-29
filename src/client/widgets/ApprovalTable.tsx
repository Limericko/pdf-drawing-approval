import type { Approval } from "../api.ts";
import { StatusChip } from "./StatusChip.tsx";

export function ApprovalTable({
  approvals,
  emptyText,
  selectedIds,
  onToggleSelection,
  onToggleAll,
  onDelete
}: {
  approvals: Approval[];
  emptyText: string;
  selectedIds?: ReadonlySet<number>;
  onToggleSelection?: (approvalId: number) => void;
  onToggleAll?: (selected: boolean) => void;
  onDelete?: (approval: Approval) => void;
}) {
  if (approvals.length === 0) {
    return (
      <div className="empty empty-state">
        <strong>{emptyText}</strong>
        <span>有新 PDF 提交或目录扫描入库后会自动显示。</span>
      </div>
    );
  }

  const selectable = Boolean(selectedIds && onToggleSelection && onToggleAll);
  const allSelected = selectable && approvals.every((approval) => selectedIds?.has(approval.id));

  return (
    <div className="table-surface">
      <table className="data-table approval-table">
        <thead>
          <tr>
            {selectable && (
              <th className="selection-cell">
                <input
                  type="checkbox"
                  aria-label="选择全部图纸"
                  checked={allSelected}
                  onChange={(event) => onToggleAll?.(event.target.checked)}
                  onClick={(event) => event.stopPropagation()}
                />
              </th>
            )}
            <th>项目</th>
            <th>零件</th>
            <th>版本</th>
            <th>主管</th>
            <th>工艺</th>
            <th>总状态</th>
            <th>签审</th>
            <th>提交时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {approvals.map((approval) => (
            <tr key={approval.id} onClick={() => { location.hash = `/approvals/${approval.id}`; }}>
              {selectable && (
                <td className="selection-cell" data-label="选择" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${approval.partName}`}
                    checked={selectedIds?.has(approval.id) ?? false}
                    onChange={() => onToggleSelection?.(approval.id)}
                  />
                </td>
              )}
              <td data-label="项目">
                <span className="project-name">{approval.projectName}</span>
              </td>
              <td data-label="零件">
                <strong>{approval.partName}</strong>
              </td>
              <td data-label="版本">
                <span className="version-badge">{approval.version}</span>
              </td>
              <td data-label="主管"><StatusChip status={approval.supervisorStatus} /></td>
              <td data-label="工艺"><StatusChip status={approval.processStatus} /></td>
              <td data-label="总状态"><StatusChip status={approval.status} /></td>
              <td data-label="签审"><StatusChip status={approval.signatureStatus} context="signature" /></td>
              <td className="time-cell" data-label="提交时间">{new Date(approval.submittedAt).toLocaleString()}</td>
              <td className="row-actions" data-label="操作" onClick={(event) => event.stopPropagation()}>
                <a className="table-action-link" href={`#/approvals/${approval.id}`} aria-label={`查看图纸 ${approval.partName}`}>
                  查看
                </a>
                {onDelete && (
                  <button type="button" className="danger table-action-button" onClick={() => onDelete(approval)}>
                    删除
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
