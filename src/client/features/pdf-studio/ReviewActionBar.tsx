import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "../../ui/actions/index.tsx";
import { SaveIndicator } from "../../ui/feedback/index.tsx";
import { TextArea } from "../../ui/forms/index.tsx";
import styles from "./ReviewActionBar.module.css";

export function ReviewActionBar({
  saveStatus,
  openIssueCount,
  blockingIssueCount,
  canReview,
  comment,
  busy,
  onCommentChange,
  onApprove,
  onApproveAndNext,
  onReject
}: {
  saveStatus: "saving" | "saved" | "error" | "offline";
  openIssueCount: number;
  blockingIssueCount: number;
  canReview: boolean;
  comment: string;
  busy: boolean;
  onCommentChange: (value: string) => void;
  onApprove: () => void;
  onApproveAndNext: () => void;
  onReject: () => void;
}) {
  return <footer className={styles.bar} aria-label="PDF 审阅动作">
    <div className={styles.status}>
      <SaveIndicator status={saveStatus} />
      <span className={styles.issueSummary} data-blocking={blockingIssueCount > 0}>
        {blockingIssueCount > 0 ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
        {blockingIssueCount > 0 ? `${blockingIssueCount} 个审批阻断` : `${openIssueCount} 个未关闭问题`}
      </span>
    </div>
    {canReview ? <TextArea className={styles.comment} id="review-action-comment" label="审核意见" hideLabel
      value={comment} rows={1} placeholder="审核意见；驳回时必填" onChange={(event) => onCommentChange(event.target.value)} /> : <div />}
    {canReview ? <div className={styles.actions}>
      <Button size="sm" variant="secondary" disabled={blockingIssueCount > 0} loading={busy} onClick={onApproveAndNext}>通过并打开下一张</Button>
      <Button size="sm" disabled={blockingIssueCount > 0} loading={busy} onClick={onApprove}>通过</Button>
      <Button size="sm" variant="danger" loading={busy} onClick={onReject}>驳回</Button>
    </div> : <div />}
  </footer>;
}
