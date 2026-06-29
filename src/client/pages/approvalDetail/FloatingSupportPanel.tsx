import type { PointerEvent as ReactPointerEvent } from "react";
import type { Approval, ApprovalComment, OperationLog } from "../../api.ts";
import { StatusChip } from "../../widgets/StatusChip.tsx";

export type SupportTab = "comments" | "timeline" | "history";

export function FloatingSupportPanel({
  activeTab,
  title,
  position,
  supportTab,
  collaborationKind,
  collaborationMessage,
  busyAction,
  approvalComments,
  operationLogs,
  visibleLogs,
  hiddenLogCount,
  timelineExpanded,
  historyItems,
  onStartDrag,
  onClose,
  onCollaborationKindChange,
  onCollaborationMessageChange,
  onSubmitCollaboration,
  onResolveIssue,
  onToggleTimelineExpanded,
  onExpandTimeline
}: {
  activeTab: SupportTab;
  title: string;
  position: { x: number; y: number };
  supportTab: SupportTab;
  collaborationKind: "comment" | "issue";
  collaborationMessage: string;
  busyAction: string;
  approvalComments: ApprovalComment[];
  operationLogs: OperationLog[];
  visibleLogs: OperationLog[];
  hiddenLogCount: number;
  timelineExpanded: boolean;
  historyItems: Approval[];
  onStartDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClose: () => void;
  onCollaborationKindChange: (kind: "comment" | "issue") => void;
  onCollaborationMessageChange: (message: string) => void;
  onSubmitCollaboration: () => void;
  onResolveIssue: (commentId: number) => void;
  onToggleTimelineExpanded: () => void;
  onExpandTimeline: () => void;
}) {
  return (
    <div
      className="floating-support-panel"
      style={{ left: position.x, top: position.y }}
      role="dialog"
      aria-label={title}
      data-active-tab={activeTab}
    >
      <div className="floating-panel-header" onPointerDown={onStartDrag}>
        <div>
          <span>协同与追溯</span>
          <strong>{title}</strong>
        </div>
        <button
          type="button"
          className="floating-panel-close"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        >
          关闭
        </button>
      </div>
      <div className="floating-panel-body">
        {supportTab === "comments" && (
          <div className="support-panel-grid">
            <div className="comment-compose">
              <div className="segmented-control">
                <button type="button" className={collaborationKind === "comment" ? "active" : ""} onClick={() => onCollaborationKindChange("comment")}>
                  评论
                </button>
                <button type="button" className={collaborationKind === "issue" ? "active" : ""} onClick={() => onCollaborationKindChange("issue")}>
                  问题
                </button>
              </div>
              <textarea
                value={collaborationMessage}
                onChange={(event) => onCollaborationMessageChange(event.target.value)}
                placeholder={collaborationKind === "issue" ? "记录需要处理的问题" : "补充说明或协作信息"}
              />
              <button type="button" onClick={onSubmitCollaboration} disabled={!collaborationMessage.trim() || busyAction === "comment"}>
                {busyAction === "comment" ? "提交中" : collaborationKind === "issue" ? "记录问题" : "添加评论"}
              </button>
            </div>
            <ul className="comment-list">
              {approvalComments.length === 0 && <li className="comment-empty">暂无协同记录</li>}
              {approvalComments.map((item) => (
                <li key={item.id} className={`comment-item comment-item--${item.kind} ${item.resolved ? "comment-item--resolved" : ""}`}>
                  <div className="comment-item__meta">
                    <strong>{item.authorDisplayName ?? item.authorUsername ?? "用户"}</strong>
                    <span>{item.kind === "issue" ? "问题" : "评论"} · {new Date(item.createdAt).toLocaleString()}</span>
                  </div>
                  <p>{item.message}</p>
                  {item.kind === "issue" && (
                    <div className="comment-item__actions">
                      <span>{item.resolved ? `已解决 ${item.resolvedAt ? new Date(item.resolvedAt).toLocaleString() : ""}` : "未解决"}</span>
                      {!item.resolved && (
                        <button type="button" className="secondary-button" onClick={() => onResolveIssue(item.id)} disabled={busyAction === `resolve-${item.id}`}>
                          {busyAction === `resolve-${item.id}` ? "处理中" : "标记解决"}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {supportTab === "timeline" && (
          <>
            <div className="support-panel-heading">
              <div>
                <h2>操作时间线</h2>
                <span>{operationLogs.length} 条记录</span>
              </div>
              {hiddenLogCount > 0 && (
                <button type="button" className="secondary-button" onClick={onToggleTimelineExpanded}>
                  {timelineExpanded ? "收起" : `展开全部 ${operationLogs.length} 条`}
                </button>
              )}
            </div>
            <ul className="timeline-list">
              {operationLogs.length === 0 && <li><span>暂无操作记录</span></li>}
              {visibleLogs.map((log) => (
                <li key={log.id}>
                  <time>{new Date(log.createdAt).toLocaleString()}</time>
                  <strong>{operationActor(log)}</strong>
                  <span>{log.message}</span>
                </li>
              ))}
            </ul>
            {!timelineExpanded && hiddenLogCount > 0 && (
              <button type="button" className="timeline-more-button secondary-button" onClick={onExpandTimeline}>
                还有 {hiddenLogCount} 条
              </button>
            )}
          </>
        )}
        {supportTab === "history" && (
          <ul className="history-list history-list--cards">
            {historyItems.length === 0 && <li className="comment-empty">暂无其它版本</li>}
            {historyItems.map((item) => (
              <li key={item.id}>
                <div>
                  <a href={`#/approvals/${item.id}`}>{item.version}</a>
                  <span>{new Date(item.submittedAt).toLocaleDateString()}</span>
                </div>
                <div>
                  <StatusChip status={item.status} />
                  {item.archivedAt && <span>已归档</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function operationActor(log: OperationLog) {
  return log.actorUsername ?? "system";
}
