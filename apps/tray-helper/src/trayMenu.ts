import { routeUrl } from "./linkBuilder.ts";
import type { TraySession } from "./authStore.ts";
import type { PollStatus } from "./poller.ts";

export type TrayMenuAction = "open" | "settings" | "refresh" | "logout" | "scan-now" | "restart-server" | "quit" | "label";

export type TrayMenuItemModel = {
  id: string;
  text: string;
  action: TrayMenuAction;
  enabled?: boolean;
  href?: string;
};

export type TrayMenuModel = {
  tooltip: string;
  items: TrayMenuItemModel[];
};

export function buildTrayMenuModel(input: {
  session: TraySession | null;
  status: PollStatus;
  pendingCount: number;
  adminRiskCount?: number;
}): TrayMenuModel {
  if (!input.session) {
    return {
      tooltip: "PDF 图纸审批托盘助手 - 未登录",
      items: [
        { id: "status", text: "未登录", action: "label", enabled: false },
        { id: "open-settings", text: "登录设置", action: "settings" },
        { id: "quit", text: "退出托盘助手", action: "quit" }
      ]
    };
  }

  const items: TrayMenuItemModel[] = [
    { id: "status", text: statusLabel(input.status), action: "label", enabled: false },
    { id: "open-home", text: "打开审批工作台", action: "open", href: routeUrl(input.session.serverUrl, "#/") }
  ];

  if (input.session.role === "supervisor" || input.session.role === "process") {
    items.push({
      id: "open-tasks",
      text: `打开待审核（${input.pendingCount}）`,
      action: "open",
      href: routeUrl(input.session.serverUrl, "#/")
    });
  }

  if (input.session.role === "designer") {
    items.push(
      { id: "open-submit", text: "提交图纸", action: "open", href: routeUrl(input.session.serverUrl, "#/submit") },
      { id: "open-signature", text: "我的签名", action: "open", href: routeUrl(input.session.serverUrl, "#/signature") }
    );
  }

  if (input.session.role === "admin") {
    const riskSuffix = input.adminRiskCount ? `（${input.adminRiskCount} 项风险）` : "";
    items.push(
      { id: "open-system", text: `打开系统管理${riskSuffix}`, action: "open", href: routeUrl(input.session.serverUrl, "#/settings") },
      { id: "open-logs", text: "打开服务日志", action: "open", href: routeUrl(input.session.serverUrl, "#/settings?tab=logs") },
      { id: "scan-now", text: "立即扫描", action: "scan-now", enabled: input.status === "online" },
      { id: "restart-server", text: "重启服务", action: "restart-server", enabled: input.status === "online" }
    );
  }

  items.push(
    { id: "refresh", text: "立即刷新", action: "refresh" },
    { id: "open-settings", text: "托盘设置", action: "settings" },
    { id: "logout", text: "退出当前账号", action: "logout" },
    { id: "quit", text: "退出托盘助手", action: "quit" }
  );

  return {
    tooltip: `PDF 图纸审批托盘助手 - ${statusLabel(input.status)}`,
    items
  };
}

export async function installTrayIcon(input: {
  model: TrayMenuModel;
  onOpen: (url: string) => void | Promise<void>;
  onSettings: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onLogout: () => void | Promise<void>;
  onScanNow: () => void | Promise<void>;
  onRestartServer: () => void | Promise<void>;
  onQuit: () => void | Promise<void>;
}) {
  const [{ Menu }, { TrayIcon }] = await Promise.all([import("@tauri-apps/api/menu"), import("@tauri-apps/api/tray")]);
  const menu = await Menu.new({
    items: input.model.items.map((item) => ({
      id: item.id,
      text: item.text,
      enabled: item.enabled ?? true,
      action: () => {
        void runTrayAction(item, input);
      }
    }))
  });
  const existing = await TrayIcon.getById("pdf-approval-tray");
  if (existing) {
    await existing.setMenu(menu);
    await existing.setTooltip(input.model.tooltip);
    return existing;
  }

  return TrayIcon.new({
    id: "pdf-approval-tray",
    tooltip: input.model.tooltip,
    menu,
    showMenuOnLeftClick: true
  });
}

function statusLabel(status: PollStatus) {
  return {
    signed_out: "未登录",
    online: "在线",
    offline: "离线",
    auth_expired: "登录已过期",
    error: "异常"
  }[status];
}

async function runTrayAction(
  item: TrayMenuItemModel,
  handlers: Parameters<typeof installTrayIcon>[0]
) {
  if (item.action === "open" && item.href) await handlers.onOpen(item.href);
  if (item.action === "settings") await handlers.onSettings();
  if (item.action === "refresh") await handlers.onRefresh();
  if (item.action === "logout") await handlers.onLogout();
  if (item.action === "scan-now") await handlers.onScanNow();
  if (item.action === "restart-server") await handlers.onRestartServer();
  if (item.action === "quit") await handlers.onQuit();
}
