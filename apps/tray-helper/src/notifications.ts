import { approvalUrl, routeUrl } from "./linkBuilder.ts";
import type { TraySummary } from "./types.ts";

export type TaskNotification = {
  id: number;
  title: string;
  body: string;
  targetUrl: string;
};

export type NotificationBridge = {
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<NotificationPermission>;
  sendNotification: (options: {
    id: number;
    title: string;
    body?: string;
    actionTypeId?: string;
    extra?: Record<string, unknown>;
    autoCancel?: boolean;
  }) => void;
};

export function buildTaskNotification(summary: TraySummary, newIds: number[], baseUrl: string): TaskNotification | null {
  const ids = newIds.filter((id) => summary.tasks.latestIds.includes(id));
  if (ids.length === 0) return null;

  const tasksById = new Map(summary.tasks.latest.map((task) => [task.id, task]));
  const firstId = ids[0];
  const lines = ids
    .slice(0, 3)
    .map((id) => tasksById.get(id))
    .filter((task): task is TraySummary["tasks"]["latest"][number] => Boolean(task))
    .map((task) => `${task.projectName} / ${task.partName}-${task.version}`);

  return {
    id: firstId,
    title: `有 ${ids.length} 张图纸待审核`,
    body: lines.join("；"),
    targetUrl: ids.length === 1 ? approvalUrl(baseUrl, firstId) : routeUrl(baseUrl, "#/")
  };
}

export async function showTaskNotification(bridge: NotificationBridge, notification: TaskNotification) {
  let granted = await bridge.isPermissionGranted();
  if (!granted) {
    granted = (await bridge.requestPermission()) === "granted";
  }
  if (!granted) return false;

  bridge.sendNotification({
    id: notification.id,
    title: notification.title,
    body: notification.body,
    actionTypeId: "open-approval",
    extra: { targetUrl: notification.targetUrl },
    autoCancel: true
  });
  return true;
}
