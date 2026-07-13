import type { FormEvent } from "react";
import type { LoginRequest } from "../../../shared/contracts/identity.ts";

export function PlatformLoginPage({
  busy,
  error,
  onSubmit
}: {
  readonly busy: boolean;
  readonly error: string;
  readonly onSubmit: (input: LoginRequest) => void | Promise<void>;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void onSubmit({ email: String(data.get("email") ?? ""), password: String(data.get("password") ?? "") });
  }

  return <div className="platform-panel platform-panel--narrow">
    <p className="platform-kicker">验证身份 · 01</p>
    <h1 tabIndex={-1}>登录审批平台</h1>
    <p className="platform-lead">使用受邀账号登录，密码验证后还需完成双重验证。</p>
    {error ? <p className="platform-error" role="alert" tabIndex={-1}>{error}</p> : null}
    <form className="platform-form" onSubmit={submit} aria-busy={busy}>
      <label htmlFor="platform-login-email">邮箱地址</label>
      <input id="platform-login-email" name="email" type="email" autoComplete="username" maxLength={254}
        autoFocus required disabled={busy} />
      <label htmlFor="platform-login-password">密码</label>
      <input id="platform-login-password" name="password" type="password" autoComplete="current-password"
        maxLength={256} required disabled={busy} />
      <button className="platform-button" type="submit" disabled={busy}>{busy ? "正在验证…" : "继续验证"}</button>
    </form>
  </div>;
}
