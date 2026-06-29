import { FormEvent, useEffect, useRef, useState } from "react";
import { apiCompatVersion } from "../../shared/appVersion.ts";
import { clearToken, checkServerHealth, confirmPasswordReset, login, registerDesigner, requestPasswordReset, type PublicServerHealth, type User } from "../api.ts";
import { getServerBaseUrl, isDesktopClient, persistServerBaseUrl } from "../clientConfig.ts";
import { analyzeServerAddress, isApiCompatible, type AddressAdvice } from "../connectionCheck.ts";

export const quickLoginPresets = [
  { label: "管理员", username: "admin" },
  { label: "主管", username: "supervisor" },
  { label: "工艺", username: "process" }
] as const;

type LoginMode = "login" | "register" | "forgot" | "reset";

export function LoginPage({ onLogin, resetToken }: { onLogin: (user: User) => void; resetToken?: string | null }) {
  const desktopClient = isDesktopClient();
  const [mode, setMode] = useState<LoginMode>(() => (resetToken ? "reset" : "login"));
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [registerForm, setRegisterForm] = useState({
    username: "",
    displayName: "",
    email: "",
    password: "",
    confirmPassword: ""
  });
  const [error, setError] = useState("");
  const [serverUrl, setServerUrl] = useState(() => getServerBaseUrl() ?? "");
  const [serverMessage, setServerMessage] = useState("");
  const [serverAdvice, setServerAdvice] = useState<AddressAdvice | null>(() => {
    const initial = getServerBaseUrl() ?? "";
    return initial ? analyzeServerAddress(initial) : null;
  });
  const [serverHealth, setServerHealth] = useState<PublicServerHealth | null>(null);
  const [serverSaving, setServerSaving] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetMessage, setResetMessage] = useState("");
  const [resetForm, setResetForm] = useState({
    username: "",
    email: "",
    token: resetToken ?? "",
    password: "",
    confirmPassword: ""
  });
  const passwordInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!resetToken) return;
    setResetForm((current) => ({ ...current, token: resetToken }));
    setMode("reset");
    setError("");
    setResetMessage("");
  }, [resetToken]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (mode === "register") {
      await registerDesignerAccount();
      return;
    }
    if (mode === "forgot") {
      await requestResetEmail();
      return;
    }
    if (mode === "reset") {
      await confirmResetPassword();
      return;
    }
    await loginWithCredentials(username, password);
  }

  async function loginWithCredentials(nextUsername: string, nextPassword: string) {
    setError("");
    setUsername(nextUsername);
    setPassword(nextPassword);
    try {
      onLogin(await login(nextUsername, nextPassword));
      if ("Notification" in window && Notification.permission === "default") {
        await Notification.requestPermission();
      }
    } catch (err) {
      setError(err instanceof TypeError ? "无法连接审批服务器，请检查服务器地址或网络。" : "账号或密码不正确");
    }
  }

  async function registerDesignerAccount() {
    const next = {
      username: registerForm.username.trim(),
      displayName: registerForm.displayName.trim(),
      email: registerForm.email.trim(),
      password: registerForm.password,
      confirmPassword: registerForm.confirmPassword
    };
    setError("");
    if (!next.username || !next.displayName) {
      setError("请填写账号和姓名");
      return;
    }
    if (next.password.length < 6) {
      setError("密码至少 6 位");
      return;
    }
    if (next.password !== next.confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }

    setRegistering(true);
    try {
      const user = await registerDesigner({
        username: next.username,
        password: next.password,
        displayName: next.displayName,
        email: next.email || undefined
      });
      onLogin(user);
      if ("Notification" in window && Notification.permission === "default") {
        await Notification.requestPermission();
      }
    } catch (err) {
      if (err instanceof TypeError) {
        setError("无法连接审批服务器，请检查服务器地址或网络。");
      } else if (err instanceof Error && err.message === "USERNAME_EXISTS") {
        setError("账号已存在，请更换账号或联系管理员重置密码。");
      } else {
        setError("注册失败，请检查填写内容。");
      }
    } finally {
      setRegistering(false);
    }
  }

  async function requestResetEmail() {
    const next = {
      username: resetForm.username.trim(),
      email: resetForm.email.trim()
    };
    setError("");
    setResetMessage("");
    if (!next.username || !next.email) {
      setError("请填写账号和邮箱");
      return;
    }
    if (!next.email.includes("@")) {
      setError("请填写正确的邮箱地址");
      return;
    }

    setResetSubmitting(true);
    try {
      await requestPasswordReset(next);
      setResetMessage("如果账号和邮箱匹配，将收到密码重置邮件。");
    } catch (err) {
      setError(err instanceof TypeError ? "无法连接审批服务器，请检查服务器地址或网络。" : "密码重置邮件申请失败，请稍后重试。");
    } finally {
      setResetSubmitting(false);
    }
  }

  async function confirmResetPassword() {
    const next = {
      token: resetForm.token.trim(),
      password: resetForm.password,
      confirmPassword: resetForm.confirmPassword
    };
    setError("");
    setResetMessage("");
    if (!next.token) {
      setError("密码重置链接无效，请重新申请。");
      return;
    }
    if (next.password.length < 6) {
      setError("密码至少 6 位");
      return;
    }
    if (next.password !== next.confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }

    setResetSubmitting(true);
    try {
      await confirmPasswordReset({ token: next.token, password: next.password });
      setResetForm((current) => ({ ...current, password: "", confirmPassword: "" }));
      setPassword("");
      setMode("login");
      setResetMessage("密码已重置，请使用新密码登录。");
      if (location.hash.startsWith("#/reset-password")) location.hash = "#/";
    } catch (err) {
      setError(
        err instanceof Error && err.message === "INVALID_OR_EXPIRED_RESET_TOKEN"
          ? "密码重置链接已失效，请重新申请。"
          : "密码重置失败，请稍后重试。"
      );
    } finally {
      setResetSubmitting(false);
    }
  }

  async function saveDesktopServerUrl() {
    setServerSaving(true);
    setServerMessage("");
    setError("");
    try {
      const health = await runDesktopConnectionCheck();
      if (!health) return;
      const normalized = await persistServerBaseUrl(serverUrl);
      setServerUrl(normalized);
      clearToken();
      setServerMessage("服务器地址已保存，请重新登录。");
    } catch (err) {
      setServerMessage(
        err instanceof Error && err.message === "INVALID_SERVER_URL"
          ? "请输入完整服务器地址，例如 http://192.168.1.20:8080"
          : "无法连接审批服务器，请检查服务、防火墙和 IP 地址。"
      );
    } finally {
      setServerSaving(false);
    }
  }

  async function runDesktopConnectionCheck() {
    const advice = analyzeServerAddress(serverUrl);
    setServerAdvice(advice);
    setServerHealth(null);
    if (advice.level === "error") {
      setServerMessage(advice.message);
      return null;
    }

    const health = await checkServerHealth(serverUrl);
    setServerHealth(health);
    setServerMessage(
      isApiCompatible({ clientApiCompatVersion: apiCompatVersion, serverApiCompatVersion: health.apiCompatVersion })
        ? `${advice.message} 服务在线，版本 ${health.version}。`
        : "服务可连接，但客户端与服务端版本不兼容，请更新后再使用。"
    );
    return health;
  }

  function fillUsername(preset: (typeof quickLoginPresets)[number]) {
    setError("");
    setResetMessage("");
    setMode("login");
    setUsername(preset.username);
    setPassword("");
    passwordInputRef.current?.focus();
  }

  function updateRegisterForm(key: keyof typeof registerForm, value: string) {
    setRegisterForm((current) => ({ ...current, [key]: value }));
  }

  function updateResetForm(key: keyof typeof resetForm, value: string) {
    setResetForm((current) => ({ ...current, [key]: value }));
  }

  function switchMode(nextMode: LoginMode) {
    setMode(nextMode);
    setError("");
    setResetMessage("");
    if (nextMode === "forgot") {
      setResetForm((current) => ({ ...current, username: username.trim() === "admin" ? "" : username.trim() }));
    }
  }

  function panelTitle() {
    if (mode === "register") return "设计师注册";
    if (mode === "forgot") return "找回密码";
    if (mode === "reset") return "设置新密码";
    return "登录工作台";
  }

  function submitLabel() {
    if (mode === "register") return registering ? "注册中" : "注册并进入";
    if (mode === "forgot") return resetSubmitting ? "发送中" : "发送重置邮件";
    if (mode === "reset") return resetSubmitting ? "提交中" : "确认重置密码";
    return "进入工作台";
  }

  return (
    <main className="login-layout">
      <div className="login-product-panel">
        <div className="login-copy">
          <span className="eyebrow">LAN DRAWING APPROVAL</span>
          <h1>PDF 图纸审批工作台</h1>
          <p>登录后处理提交、审核、签名和归档。</p>
        </div>
        <form className="login-panel" onSubmit={onSubmit}>
          <div className="login-mode-switch" role="tablist" aria-label="登录方式">
            <button type="button" className={mode === "login" ? "active" : ""} onClick={() => switchMode("login")}>
              登录
            </button>
            <button type="button" className={mode === "register" ? "active" : ""} onClick={() => switchMode("register")}>
              设计师注册
            </button>
          </div>
          <h2>{panelTitle()}</h2>
          {mode === "login" ? (
            <>
              <label>
                账号
                <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
              </label>
              <label>
                密码
                <input
                  ref={passwordInputRef}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </>
          ) : mode === "forgot" ? (
            <>
              <p className="hint login-register-hint">输入账号和已登记邮箱，系统会发送一次性密码重置链接。</p>
              <label>
                账号
                <input
                  autoComplete="username"
                  value={resetForm.username}
                  onChange={(event) => updateResetForm("username", event.target.value)}
                  placeholder="designer01"
                />
              </label>
              <label>
                邮箱
                <input
                  autoComplete="email"
                  value={resetForm.email}
                  onChange={(event) => updateResetForm("email", event.target.value)}
                  placeholder="designer@example.com"
                />
              </label>
            </>
          ) : mode === "reset" ? (
            <>
              <p className="hint login-register-hint">请设置新密码。重置链接 30 分钟内有效，使用后自动失效。</p>
              <input type="hidden" value={resetForm.token} readOnly aria-label="resetToken" />
              <label>
                新密码
                <input
                  type="password"
                  autoComplete="new-password"
                  value={resetForm.password}
                  onChange={(event) => updateResetForm("password", event.target.value)}
                />
              </label>
              <label>
                确认新密码
                <input
                  type="password"
                  autoComplete="new-password"
                  value={resetForm.confirmPassword}
                  onChange={(event) => updateResetForm("confirmPassword", event.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <p className="hint login-register-hint">注册后将以设计师身份进入工作台，首次使用需要先添加手写签名。</p>
              <label>
                账号
                <input
                  autoComplete="username"
                  value={registerForm.username}
                  onChange={(event) => updateRegisterForm("username", event.target.value)}
                  placeholder="designer01"
                />
              </label>
              <label>
                姓名
                <input
                  autoComplete="name"
                  value={registerForm.displayName}
                  onChange={(event) => updateRegisterForm("displayName", event.target.value)}
                  placeholder="设计师姓名"
                />
              </label>
              <label>
                邮箱（选填）
                <input
                  autoComplete="email"
                  value={registerForm.email}
                  onChange={(event) => updateRegisterForm("email", event.target.value)}
                  placeholder="designer@example.com"
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  autoComplete="new-password"
                  value={registerForm.password}
                  onChange={(event) => updateRegisterForm("password", event.target.value)}
                />
              </label>
              <label>
                确认密码
                <input
                  type="password"
                  autoComplete="new-password"
                  value={registerForm.confirmPassword}
                  onChange={(event) => updateRegisterForm("confirmPassword", event.target.value)}
                />
              </label>
            </>
          )}
          {error && <div className="error">{error}</div>}
          {resetMessage && <div className="success-message">{resetMessage}</div>}
          {desktopClient && (
            <div className="desktop-server-box">
              <label>
                审批服务器
                <input
                  autoComplete="url"
                  value={serverUrl}
                  onChange={(event) => {
                    const value = event.target.value;
                    setServerUrl(value);
                    setServerAdvice(analyzeServerAddress(value));
                    setServerHealth(null);
                  }}
                  placeholder="http://192.168.1.20:8080"
                />
              </label>
              <button type="button" className="secondary-button" onClick={runDesktopConnectionCheck} disabled={serverSaving || !serverUrl.trim()}>
                连接自检
              </button>
              <button type="button" className="secondary-button" onClick={saveDesktopServerUrl} disabled={serverSaving || !serverUrl.trim()}>
                {serverSaving ? "检查中" : "保存服务器"}
              </button>
              {serverAdvice && <span className={`connection-check ${serverAdvice.level}`}>{serverAdvice.message}</span>}
              {serverHealth && (
                <span className={`connection-check ${isApiCompatible({ clientApiCompatVersion: apiCompatVersion, serverApiCompatVersion: serverHealth.apiCompatVersion }) ? "ok" : "error"}`}>
                  服务端 {serverHealth.version}，{isApiCompatible({ clientApiCompatVersion: apiCompatVersion, serverApiCompatVersion: serverHealth.apiCompatVersion }) ? "版本兼容" : "版本不兼容"}
                </span>
              )}
              {serverMessage && <span>{serverMessage}</span>}
            </div>
          )}
          <button type="submit" disabled={registering || resetSubmitting}>{submitLabel()}</button>
          {mode === "login" && (
            <>
              <button type="button" className="link-button" onClick={() => switchMode("forgot")}>
                忘记密码
              </button>
              <div className="quick-login-panel" aria-label="快捷填入账号">
                {quickLoginPresets.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="secondary-button"
                    onClick={() => fillUsername(preset)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <p className="hint">快捷按钮只填入账号，仍需输入对应密码。</p>
            </>
          )}
          {(mode === "forgot" || mode === "reset") && (
            <button type="button" className="link-button" onClick={() => switchMode("login")}>
              返回登录
            </button>
          )}
        </form>
      </div>
    </main>
  );
}
