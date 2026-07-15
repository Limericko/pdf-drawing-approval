import type { Approval, ApprovalComment, OperationLog } from "../../api.ts";
import { Button } from "../../ui/actions/index.tsx";
import { TextArea } from "../../ui/forms/index.tsx";
import { StatusChip } from "../../widgets/StatusChip.tsx";
import styles from "./ActivityInspector.module.css";

export type ActivityTab = "comments" | "timeline" | "history";

export function ActivityInspector({
  tab,
  collaborationMessage,
  busyAction,
  comments,
  logs,
  visibleLogs,
  hiddenLogCount,
  timelineExpanded,
  historyItems,
  onTabChange,
  onMessageChange,
  onSubmitComment,
  onResolveLegacyIssue,
  onToggleTimeline
}: {
  tab: ActivityTab;
  collaborationMessage: string;
  busyAction: string;
  comments: ApprovalComment[];
  logs: OperationLog[];
  visibleLogs: OperationLog[];
  hiddenLogCount: number;
  timelineExpanded: boolean;
  historyItems: Approval[];
  onTabChange: (tab: ActivityTab) => void;
  onMessageChange: (message: string) => void;
  onSubmitComment: () => void;
  onResolveLegacyIssue: (commentId: number) => void;
  onToggleTimeline: () => void;
}) {
  return <section className={styles.root} aria-label="协同与追溯">
    <div className={styles.tabs} role="tablist" aria-label="协同记录类型">
      <button type="button" role="tab" aria-selected={tab === "comments"} onClick={() => onTabChange("comments")}>讨论 {comments.length}</button>
      <button type="button" role="tab" aria-selected={tab === "timeline"} onClick={() => onTabChange("timeline")}>时间线 {logs.length}</button>
      <button type="button" role="tab" aria-selected={tab === "history"} onClick={() => onTabChange("history")}>版本 {historyItems.length}</button>
    </div>
    {tab === "comments" ? <div className={styles.section}>
      <div className={styles.compose}>
        <TextArea id="activity-comment" label="添加讨论" rows={3} value={collaborationMessage}
          placeholder="补充说明或协作信息" onChange={(event) => onMessageChange(event.target.value)} />
        <Button size="sm" disabled={!collaborationMessage.trim()} loading={busyAction === "comment"} onClick={onSubmitComment}>添加讨论</Button>
      </div>
      <ul className={styles.list}>
        {comments.length === 0 ? <li className={styles.empty}>暂无讨论记录</li> : null}
        {comments.map((item) => <li key={item.id} className={styles.item} data-kind={item.kind} data-resolved={item.resolved}>
          <div className={styles.meta}><strong>{item.authorDisplayName ?? item.authorUsername ?? "用户"}</strong><span>{new Date(item.createdAt).toLocaleString()}</span></div>
          {item.kind === "issue" ? <span>旧版问题记录</span> : null}
          <p>{item.message}</p>
          {item.kind === "issue" ? <div className={styles.itemActions}>
            <span>{item.resolved ? "已解决" : "未解决"}</span>
            {!item.resolved ? <Button variant="secondary" size="sm" loading={busyAction === `resolve-${item.id}`}
              onClick={() => onResolveLegacyIssue(item.id)}>标记解决</Button> : null}
          </div> : null}
        </li>)}
      </ul>
    </div> : null}
    {tab === "timeline" ? <div className={styles.section}>
      <ul className={styles.timeline}>
        {logs.length === 0 ? <li className={styles.empty}>暂无操作记录</li> : null}
        {visibleLogs.map((log) => <li key={log.id}><div><time>{new Date(log.createdAt).toLocaleString()}</time><strong>{log.actorUsername ?? "system"}</strong><span>{log.message}</span></div></li>)}
      </ul>
      {hiddenLogCount > 0 ? <Button variant="secondary" size="sm" onClick={onToggleTimeline}>{timelineExpanded ? "收起" : `展开全部 ${logs.length} 条`}</Button> : null}
    </div> : null}
    {tab === "history" ? <div className={styles.section}><ul className={styles.list}>
      {historyItems.length === 0 ? <li className={styles.empty}>暂无其它版本</li> : null}
      {historyItems.map((item) => <li key={item.id} className={styles.item}>
        <a className={styles.historyLink} href={`#/approvals/${item.id}`}><strong>{item.version}</strong><span>{new Date(item.submittedAt).toLocaleDateString()}</span></a>
        <StatusChip status={item.status} />
      </li>)}
    </ul></div> : null}
  </section>;
}
