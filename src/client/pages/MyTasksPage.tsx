import { useEffect, useState } from "react";
import { listApprovals, type Approval, type User } from "../api.ts";
import { ApprovalTable } from "../widgets/ApprovalTable.tsx";
import { newTaskNotificationIds, readNotifiedTaskIds, writeNotifiedTaskIds } from "../notifications.ts";

const notifiedTaskKey = "pdf_approval_notified_task_ids";

export function MyTasksPage({ user }: { user: User }) {
  const [items, setItems] = useState<Approval[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    listApprovals({ mine: true })
      .then((approvals) => {
        setItems(approvals);
        const currentIds = approvals.map((approval) => approval.id);
        const notifiedIds = readNotifiedTaskIds(localStorage, notifiedTaskKey);
        const newIds = newTaskNotificationIds(currentIds, notifiedIds);
        if (newIds.length > 0 && "Notification" in window && Notification.permission === "granted") {
          new Notification("有新的待审核图纸", { body: `${newIds.length} 个新 PDF 等待处理` });
        }
        writeNotifiedTaskIds(localStorage, notifiedTaskKey, [...notifiedIds, ...currentIds]);
      })
      .catch((err) => setError(err.message));
  }, []);

  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow">REVIEW QUEUE</span>
          <h1>我的待审图纸</h1>
          <p>{user.role === "supervisor" || user.role === "process" ? "按提交时间处理待审核 PDF，打开图纸后给出通过或驳回意见。" : "当前角色没有固定审核任务。"}</p>
        </div>
        <div className="metric-row">
          <div className="metric">
            <strong>{items.length}</strong>
            <span>待处理</span>
          </div>
          <div className="metric metric--quiet">
            <strong>{items.filter((item) => item.status === "pending").length}</strong>
            <span>审批中</span>
          </div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <ApprovalTable approvals={items} emptyText="暂无待审图纸" />
    </section>
  );
}
