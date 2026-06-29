import { ApiClientError, createApiClient } from "./apiClient.ts";
import type { TraySession } from "./authStore.ts";
import { mergeNotifiedIds, newNotificationIds } from "./notificationState.ts";
import { buildTaskNotification, type TaskNotification } from "./notifications.ts";
import type { TraySummary } from "./types.ts";

export type PollStatus = "signed_out" | "online" | "offline" | "auth_expired" | "error";

export type PollResult = {
  status: PollStatus;
  summary?: TraySummary;
  error?: string;
};

type AuthStoreLike = {
  load: () => TraySession | null;
  clear: () => void;
  loadNotifiedIds: () => number[];
  saveNotifiedIds: (ids: number[]) => void;
};

type ApiClientLike = {
  fetchTraySummary: (token: string) => Promise<TraySummary>;
};

export type PollTraySummaryOnceOptions = {
  authStore: AuthStoreLike;
  createClient?: (serverUrl: string) => ApiClientLike;
  notify: (notification: TaskNotification) => Promise<boolean | void> | boolean | void;
};

export function nextPollDelayMs(status: PollStatus) {
  if (status === "online") return 30_000;
  if (status === "offline" || status === "error") return 60_000;
  return null;
}

export async function pollTraySummaryOnce({
  authStore,
  createClient = createApiClient,
  notify
}: PollTraySummaryOnceOptions): Promise<PollResult> {
  const session = authStore.load();
  if (!session) return { status: "signed_out" };

  try {
    const summary = await createClient(session.serverUrl).fetchTraySummary(session.token);
    const notifiedIds = authStore.loadNotifiedIds();
    const idsToNotify = newNotificationIds(summary.tasks.latestIds, notifiedIds);
    const notification = buildTaskNotification(summary, idsToNotify, session.serverUrl);
    if (notification) {
      const shown = await notify(notification);
      if (shown !== false) {
        authStore.saveNotifiedIds(mergeNotifiedIds(notifiedIds, idsToNotify));
      }
    }
    return { status: "online", summary };
  } catch (error) {
    if (error instanceof ApiClientError && error.code === "auth_expired") {
      authStore.clear();
      return { status: "auth_expired", error: error.message };
    }
    if (error instanceof ApiClientError && error.code === "network_error") {
      return { status: "offline", error: error.message };
    }
    return { status: "error", error: error instanceof Error ? error.message : "Polling failed" };
  }
}

export function createTrayPoller(
  options: PollTraySummaryOnceOptions & {
    onResult?: (result: PollResult) => void;
  }
) {
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const run = async () => {
    if (stopped) return;
    const result = await pollTraySummaryOnce(options);
    options.onResult?.(result);
    const delay = nextPollDelayMs(result.status);
    if (delay !== null && !stopped) {
      timer = setTimeout(run, delay);
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      clearTimer();
      void run();
    },
    refresh() {
      if (stopped) return;
      clearTimer();
      void run();
    },
    stop() {
      stopped = true;
      clearTimer();
    }
  };
}
