const serviceName = "PDF 图纸审批服务端";

function renderConsoleHtml(input) {
  const state = input.state ?? "starting";
  const badgeText = statusLabel(state);
  const badgeClass = state === "running" ? "running" : state === "error" ? "error" : "starting";
  const envPortNotice = input.envPort ? `<div class="notice warn">当前端口由环境变量 PORT=${escapeHtml(input.envPort)} 覆盖，保存配置后需取消环境变量才会生效。</div>` : "";
  const configMessage = input.lastConfigMessage ? `<div class="notice ok">${escapeHtml(input.lastConfigMessage)}</div>` : "";
  const lanUrl = input.lanUrl || "未检测到局域网 IPv4 地址";
  const updateManifestUrl = input.updateManifestUrl || buildUpdateManifestUrl(input.lanUrl || input.localUrl);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${serviceName}</title>
  <style>
    :root {
      color: #18212b;
      background: #eef2f5;
      font-family: "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
      font-size: 14px;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #eef2f5; }
    button, input { font: inherit; }
    .shell { min-height: 100vh; padding: 28px; display: grid; grid-template-rows: auto 1fr; gap: 18px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
    h1 { margin: 0; font-size: 23px; line-height: 1.25; letter-spacing: 0; }
    .subtitle { margin-top: 7px; color: #52606d; line-height: 1.55; }
    .badge { flex: 0 0 auto; min-width: 76px; text-align: center; padding: 7px 12px; border-radius: 999px; font-weight: 700; }
    .badge.running { color: #0d5b43; background: #dff4ea; }
    .badge.starting { color: #7a4b00; background: #fff0c2; }
    .badge.error { color: #9b1c1c; background: #fde2e2; }
    .layout { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(310px, .92fr); gap: 16px; align-items: start; }
    .panel { background: #fff; border: 1px solid #d6dde5; border-radius: 8px; padding: 18px; min-width: 0; }
    .panel h2 { margin: 0 0 14px; font-size: 16px; line-height: 1.3; letter-spacing: 0; }
    .message { margin: 0 0 16px; font-size: 16px; line-height: 1.5; font-weight: 700; color: ${state === "error" ? "#9b1c1c" : "#17202a"}; }
    .metric { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px 12px; align-items: center; }
    .label { color: #687584; text-align: right; line-height: 1.4; }
    .value { min-width: 0; overflow-wrap: anywhere; color: #1f2933; line-height: 1.45; }
    .address-value { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .address-value .mono { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .mono { font-family: "Cascadia Mono", Consolas, monospace; font-size: 13px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    .button { height: 38px; border: 1px solid #c7d1da; border-radius: 6px; padding: 0 13px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: #1f2933; background: #fff; text-decoration: none; font-weight: 700; }
    .button:hover { border-color: #8fa1b2; background: #f8fafb; }
    .button.primary { border-color: #126353; background: #126353; color: #fff; }
    .button.primary:hover { background: #0f5547; }
    .button.danger { border-color: #c25454; color: #9b1c1c; background: #fff7f7; }
    .form-grid { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 12px; align-items: center; }
    .form-grid input { width: 100%; height: 38px; border: 1px solid #c7d1da; border-radius: 6px; padding: 0 11px; outline: none; }
    .form-grid input:focus { border-color: #126353; box-shadow: 0 0 0 3px rgba(18, 99, 83, .16); }
    .help { margin: 13px 0 0; color: #52606d; line-height: 1.65; }
    .notice { margin-top: 12px; padding: 10px 12px; border-radius: 6px; line-height: 1.55; }
    .notice.ok { color: #0d5b43; background: #e4f5ee; border: 1px solid #b8ddcf; }
    .notice.warn { color: #775400; background: #fff5d8; border: 1px solid #ead08b; }
    .directory-list { display: grid; gap: 12px; }
    .directory-item { display: grid; grid-template-columns: 70px minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .directory-name { color: #687584; text-align: right; }
    .footer-note { color: #52606d; line-height: 1.65; }
    @media (max-width: 760px) {
      .shell { padding: 20px; }
      .topbar { display: block; }
      .badge { display: inline-block; margin-top: 12px; }
      .layout { grid-template-columns: 1fr; }
      .label, .directory-name { text-align: left; }
      .metric, .form-grid, .directory-item { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="topbar">
      <div>
        <h1>${serviceName}</h1>
        <div class="subtitle">服务端可隐藏到系统托盘，团队电脑仍可通过局域网地址访问审批系统。</div>
      </div>
      <div class="badge ${badgeClass}">${badgeText}</div>
    </section>
    <section class="layout">
      <div class="panel">
        <h2>服务状态</h2>
        <p class="message">${escapeHtml(input.message || "")}</p>
        <div class="metric">
          <div class="label">当前端口</div><div class="value mono">${escapeHtml(input.effectivePort || "-")}</div>
          <div class="label">本机地址</div><div class="value mono">${escapeHtml(input.localUrl || "-")}</div>
          <div class="label">局域网地址</div><div class="value address-value"><span class="mono">${escapeHtml(lanUrl)}</span>${input.lanUrl ? `<button class="button" type="button" data-copy-text="${escapeHtml(input.lanUrl)}">复制客户端地址</button>` : ""}</div>
          <div class="label">配置文件</div><div class="value mono">${escapeHtml(input.configPath || "-")}</div>
        </div>
        <div class="actions">
          ${input.localUrl ? `<button class="button primary" type="button" data-url="${escapeHtml(input.localUrl)}">打开本机工作台</button>` : ""}
          ${input.lanUrl ? `<button class="button" type="button" data-url="${escapeHtml(input.lanUrl)}">打开局域网地址</button>` : ""}
          <button class="button" type="button" data-hide-window="1">隐藏窗口</button>
          <button class="button" type="button" data-restart="1">重启服务端</button>
        </div>
      </div>

      <div class="panel">
        <h2>启动设置</h2>
        <form id="port-form">
          <div class="form-grid">
            <label class="label" for="port-input">HTTP 端口</label>
            <input id="port-input" name="port" inputmode="numeric" autocomplete="off" value="${escapeHtml(input.savedPort || input.effectivePort || "")}" />
          </div>
          <p class="help">端口建议保持 8080。修改后需要重启服务端，团队电脑也要使用新的访问地址。</p>
          <div class="actions">
            <button class="button" type="button" id="save-port">保存</button>
            <button class="button primary" type="submit">保存并重启</button>
          </div>
          <div id="form-message">${configMessage}${envPortNotice}</div>
        </form>
      </div>

      <div class="panel">
        <h2>运行目录</h2>
        <div class="directory-list">
          ${directoryRow("data", "数据", input.dataDir)}
          ${directoryRow("backups", "备份", input.backupDir)}
          ${directoryRow("logs", "日志", input.logDir)}
          ${directoryRow("releases", "更新", input.releaseDir)}
        </div>
      </div>

      <div class="panel">
        <h2>更新发布</h2>
        <div class="metric">
          <div class="label">更新目录</div><div class="value mono">${escapeHtml(input.releaseDir || "-")}</div>
          <div class="label">清单地址</div><div class="value address-value"><span class="mono">${escapeHtml(updateManifestUrl || "服务启动后自动生成")}</span>${updateManifestUrl ? `<button class="button" type="button" data-copy-text="${escapeHtml(updateManifestUrl)}" data-copy-label="复制清单地址">复制清单地址</button>` : ""}</div>
        </div>
        <div class="actions">
          <button class="button" type="button" data-directory="releases">打开更新目录</button>
        </div>
        <p class="help">客户端和管理端会自动使用服务端的 /updates/latest.json 检查更新，无需在网页端填写更新清单地址。</p>
      </div>

      <div class="panel">
        <h2>部署提示</h2>
        <p class="footer-note">首次部署时，先在服务器电脑启动本程序，用本机地址完成管理员登录和系统配置。确认可用后，点击复制客户端地址，把局域网地址给同事填写到客户端。发布新版安装包时，把 updates 和 installers 放到服务端更新目录。</p>
      </div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#port-form");
    const input = document.querySelector("#port-input");
    const message = document.querySelector("#form-message");

    async function savePort(restart) {
      try {
        const result = restart
          ? await window.serverConsole.savePortAndRestart(input.value)
          : await window.serverConsole.savePort(input.value);
        if (message) message.innerHTML = '<div class="notice ok">' + escapeHtml(result.message) + '</div>';
      } catch (error) {
        if (message) message.innerHTML = '<div class="notice warn">' + escapeHtml(error.message || '保存失败') + '</div>';
      }
    }

    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      savePort(true);
    });
    document.querySelector("#save-port")?.addEventListener("click", () => savePort(false));
    document.querySelectorAll("[data-url]").forEach((button) => {
      button.addEventListener("click", () => window.serverConsole.openUrl(button.dataset.url));
    });
    document.querySelectorAll("[data-directory]").forEach((button) => {
      button.addEventListener("click", () => window.serverConsole.openDirectory(button.dataset.directory));
    });
    document.querySelectorAll("[data-copy-text]").forEach((button) => {
      button.addEventListener("click", async () => {
        await window.serverConsole.copyText(button.dataset.copyText);
        const originalText = button.dataset.copyLabel || button.textContent || "复制";
        button.textContent = "已复制";
        window.setTimeout(() => { button.textContent = originalText; }, 1200);
      });
    });
    document.querySelector("[data-hide-window]")?.addEventListener("click", () => window.serverConsole.hideWindow());
    document.querySelector("[data-restart]")?.addEventListener("click", () => window.serverConsole.restart());

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }
  </script>
</body>
</html>`;
}

function directoryRow(key, label, value) {
  return `<div class="directory-item">
    <div class="directory-name">${escapeHtml(label)}</div>
    <div class="value mono">${escapeHtml(value || "-")}</div>
    <button class="button" type="button" data-directory="${escapeHtml(key)}">打开</button>
  </div>`;
}

function buildUpdateManifestUrl(baseUrl) {
  if (!baseUrl) return "";
  return `${String(baseUrl).replace(/\/+$/, "")}/updates/latest.json`;
}

function statusLabel(state) {
  if (state === "running") return "运行中";
  if (state === "error") return "启动失败";
  return "启动中";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

module.exports = { renderConsoleHtml };
