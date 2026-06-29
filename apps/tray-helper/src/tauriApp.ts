import { isTauri } from "@tauri-apps/api/core";
import { createApiClient } from "./apiClient.ts";
import { createAuthStore } from "./authStore.ts";
import { buildTrayMenuModel, installTrayIcon } from "./trayMenu.ts";
import { createTrayPoller, type PollResult, type PollStatus } from "./poller.ts";
import { showTaskNotification, type TaskNotification } from "./notifications.ts";

const sessionChangedEvent = "pdf-approval-tray-session-changed";

export function notifyTraySessionChanged() {
  window.dispatchEvent(new CustomEvent(sessionChangedEvent));
}

export async function bootstrapTrayApp() {
  if (!isTauri()) return;

  const authStore = createAuthStore();
  let status: PollStatus = authStore.load() ? "offline" : "signed_out";
  let pendingCount = 0;
  let adminRiskCount = 0;

  const renderTray = async () => {
    const session = authStore.load();
    await installTrayIcon({
      model: buildTrayMenuModel({ session, status, pendingCount, adminRiskCount }),
      onOpen: openExternalUrl,
      onSettings: showSettingsWindow,
      onRefresh: () => poller.refresh(),
      onLogout: async () => {
        authStore.clear();
        authStore.clearNotifiedIds();
        status = "signed_out";
        pendingCount = 0;
        adminRiskCount = 0;
        poller.stop();
        await renderTray();
        await showSettingsWindow();
      },
      onScanNow: async () => {
        const session = authStore.load();
        if (!session || session.role !== "admin") return;
        await createApiClient(session.serverUrl).scanNow(session.token);
        poller.refresh();
      },
      onRestartServer: async () => {
        const session = authStore.load();
        if (!session || session.role !== "admin") return;
        await createApiClient(session.serverUrl).restartServer(session.token);
        poller.refresh();
      },
      onQuit: quitApp
    });
  };

  const poller = createTrayPoller({
    authStore,
    notify: notifyTask,
    onResult: (result) => {
      applyPollResult(result);
      void renderTray();
    }
  });

  const applyPollResult = (result: PollResult) => {
    status = result.status;
    pendingCount = result.summary?.tasks.pendingCount ?? 0;
    adminRiskCount = result.summary?.admin?.riskCount ?? 0;
  };

  window.addEventListener(sessionChangedEvent, () => {
    status = authStore.load() ? "offline" : "signed_out";
    pendingCount = 0;
    adminRiskCount = 0;
    void renderTray();
    poller.start();
    poller.refresh();
  });

  await registerNotificationOpenHandler();
  await renderTray();
  poller.start();
  if (authStore.load()) {
    await hideSettingsWindow();
  }
}

async function notifyTask(notification: TaskNotification) {
  const bridge = await import("@tauri-apps/plugin-notification");
  return showTaskNotification(bridge, notification);
}

async function openExternalUrl(url: string) {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

async function showSettingsWindow() {
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const window = getCurrentWebviewWindow();
  await window.show();
  await window.setFocus();
}

async function hideSettingsWindow() {
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().hide();
}

async function registerNotificationOpenHandler() {
  const { onAction, registerActionTypes } = await import("@tauri-apps/plugin-notification");
  await registerActionTypes([
    {
      id: "open-approval",
      actions: [{ id: "open", title: "打开" }]
    }
  ]);
  await onAction((notification) => {
    const targetUrl = notification.extra?.targetUrl;
    if (typeof targetUrl === "string") {
      void openExternalUrl(targetUrl);
    }
  });
}

async function quitApp() {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("quit_app");
}
