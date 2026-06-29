import { createApiClient } from "./apiClient.ts";
import { createAuthStore } from "./authStore.ts";
import { notifyTraySessionChanged } from "./tauriApp.ts";

const root = document.querySelector<HTMLDivElement>("#app");

if (root) {
  root.innerHTML = `
    <main class="tray-settings-shell">
      <header class="tray-settings-header">
        <h1>图纸审批托盘助手</h1>
      </header>
      <form class="tray-settings-form" id="settings-form">
        <div class="form-row">
          <label for="server-url">审批系统地址</label>
          <input id="server-url" placeholder="http://192.168.1.20:8080" autocomplete="url" />
        </div>
        <div class="form-row">
          <label for="username">账号</label>
          <input id="username" autocomplete="username" />
        </div>
        <div class="form-row">
          <label for="password">密码</label>
          <input id="password" type="password" autocomplete="current-password" />
        </div>
        <div class="form-actions">
          <button id="login" type="submit">登录</button>
        </div>
        <p class="form-status" id="status" role="status"></p>
      </form>
    </main>
  `;
  bindSettingsForm(root);
}

export function bindSettingsForm(container: ParentNode) {
  const form = container.querySelector<HTMLFormElement>("#settings-form");
  const serverUrlInput = container.querySelector<HTMLInputElement>("#server-url");
  const usernameInput = container.querySelector<HTMLInputElement>("#username");
  const passwordInput = container.querySelector<HTMLInputElement>("#password");
  const loginButton = container.querySelector<HTMLButtonElement>("#login");
  const status = container.querySelector<HTMLElement>("#status");

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const serverUrl = serverUrlInput?.value.trim() ?? "";
    const username = usernameInput?.value.trim() ?? "";
    const password = passwordInput?.value ?? "";

    if (!serverUrl || !username || !password) {
      setStatus(status, "请填写服务器地址、账号和密码。");
      return;
    }

    try {
      setLoginPending(loginButton, true);
      setStatus(status, "正在登录...");
      const result = await createApiClient(serverUrl).login(username, password);
      createAuthStore().save({
        serverUrl,
        username: result.user.username,
        role: result.user.role,
        token: result.token
      });
      setStatus(status, "登录成功，托盘助手已保存账号。");
      notifyTraySessionChanged();
      await hideSettingsWindowIfTauri();
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : "登录失败，请检查服务器地址和账号密码。");
    } finally {
      setLoginPending(loginButton, false);
    }
  });
}

function setStatus(element: HTMLElement | null | undefined, message: string) {
  if (element) {
    element.textContent = message;
  }
}

function setLoginPending(button: HTMLButtonElement | null | undefined, pending: boolean) {
  if (!button) return;
  button.disabled = pending;
  button.textContent = pending ? "登录中" : "登录";
}

async function hideSettingsWindowIfTauri() {
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (!isTauri()) return;
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    await getCurrentWebviewWindow().hide();
  } catch {
    // Browser dev mode has no Tauri window to hide.
  }
}
