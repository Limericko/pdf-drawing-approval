import { FormEvent, useState } from "react";
import { checkServerHealth, type PublicServerHealth } from "../api.ts";
import { apiCompatVersion } from "../../shared/appVersion.ts";
import { persistServerBaseUrl } from "../clientConfig.ts";
import { analyzeServerAddress, isApiCompatible, type AddressAdvice } from "../connectionCheck.ts";

export function ServerConnectionPage(props: { initialServerUrl?: string | null; onConfigured: (serverUrl: string) => void }) {
  const [serverUrl, setServerUrl] = useState(props.initialServerUrl ?? "");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [advice, setAdvice] = useState<AddressAdvice | null>(() => (props.initialServerUrl ? analyzeServerAddress(props.initialServerUrl) : null));
  const [health, setHealth] = useState<PublicServerHealth | null>(null);

  async function runConnectionCheck() {
    const nextAdvice = analyzeServerAddress(serverUrl);
    setAdvice(nextAdvice);
    setHealth(null);
    setError("");
    if (nextAdvice.level === "error") {
      setError(nextAdvice.message);
      return null;
    }

    const nextHealth = await checkServerHealth(serverUrl);
    setHealth(nextHealth);
    return nextHealth;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError("");

    try {
      await runConnectionCheck();
      const normalized = await persistServerBaseUrl(serverUrl);
      props.onConfigured(normalized);
    } catch (err) {
      const message = err instanceof Error && err.message === "INVALID_SERVER_URL"
        ? "请输入完整服务器地址，例如 http://192.168.1.20:8080"
        : "无法连接审批服务器，请检查服务是否启动、IP 是否正确、防火墙是否放行 8080 端口。";
      setError(message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="login-layout">
      <div className="desktop-connect-panel">
        <div className="login-copy">
          <span className="eyebrow">DESKTOP CLIENT</span>
          <h1>连接公司审批服务端</h1>
          <p>首次使用客户端时填写服务端地址，图纸、签名和归档仍统一保存在服务器。</p>
        </div>
        <form className="login-panel desktop-connect-form" onSubmit={onSubmit}>
          <h2>服务器地址</h2>
          <label>
            审批服务器
            <input
              value={serverUrl}
              onChange={(event) => {
                const value = event.target.value;
                setServerUrl(value);
                setAdvice(analyzeServerAddress(value));
                setHealth(null);
              }}
              placeholder="http://192.168.1.20:8080"
              autoComplete="url"
              autoFocus
            />
          </label>
          <button type="button" className="secondary-button" onClick={runConnectionCheck} disabled={checking || !serverUrl.trim()}>
            连接自检
          </button>
          {advice && <div className={`connection-check ${advice.level}`}>{advice.message}</div>}
          {health && (
            <div className={`connection-check ${isApiCompatible({ clientApiCompatVersion: apiCompatVersion, serverApiCompatVersion: health.apiCompatVersion }) ? "ok" : "error"}`}>
              服务在线：{health.appName} {health.version}，
              {isApiCompatible({ clientApiCompatVersion: apiCompatVersion, serverApiCompatVersion: health.apiCompatVersion })
                ? "版本兼容"
                : "客户端与服务端版本不兼容"}
            </div>
          )}
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={checking || !serverUrl.trim()}>
            {checking ? "正在检查" : "连接并保存"}
          </button>
          <p className="hint">可在服务器电脑上打开 `/health` 确认服务在线。</p>
        </form>
      </div>
    </main>
  );
}
