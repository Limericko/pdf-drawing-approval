import { useState, type FormEvent } from "react";
import type { MfaCompleteRequest } from "../../../shared/contracts/identity.ts";

export function MfaChallengePage({
  busy,
  error,
  onSubmit,
  onCancel
}: {
  readonly busy: boolean;
  readonly error: string;
  readonly onSubmit: (factor: MfaCompleteRequest["factor"]) => void | Promise<void>;
  readonly onCancel: () => void;
}) {
  const [method, setMethod] = useState<MfaCompleteRequest["factor"]["method"]>("totp");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void onSubmit({ method, code: String(data.get("code") ?? "") } as MfaCompleteRequest["factor"]);
  }
  return <div className="platform-panel platform-panel--narrow">
    <p className="platform-kicker">安全确认 · 02</p>
    <h1 tabIndex={-1}>完成双重验证</h1>
    <p className="platform-lead">选择当前可用的验证方式。</p>
    {error ? <p className="platform-error" role="alert" tabIndex={-1}>{error}</p> : null}
    <form className="platform-form" onSubmit={submit} aria-busy={busy}>
      <fieldset className="platform-factor"><legend>验证方式</legend>
        <label><input type="radio" name="method" value="totp" checked={method === "totp"}
          aria-labelledby="platform-mfa-totp-name" aria-describedby="platform-mfa-totp-description"
          onChange={() => setMethod("totp")} /> <span><strong id="platform-mfa-totp-name">身份验证器</strong>
            <small id="platform-mfa-totp-description">输入 6 位动态验证码</small></span></label>
        <label><input type="radio" name="method" value="recovery" checked={method === "recovery"}
          aria-labelledby="platform-mfa-recovery-name" aria-describedby="platform-mfa-recovery-description"
          onChange={() => setMethod("recovery")} /> <span><strong id="platform-mfa-recovery-name">恢复码</strong>
            <small id="platform-mfa-recovery-description">使用一枚未使用的恢复码</small></span></label>
      </fieldset>
      <label htmlFor="platform-mfa-code">{method === "totp" ? "6 位动态验证码" : "恢复码"}</label>
      <input id="platform-mfa-code" name="code" inputMode={method === "totp" ? "numeric" : "text"}
        autoComplete="one-time-code" autoFocus required maxLength={128} disabled={busy} />
      <div className="platform-actions"><button className="platform-button" type="submit" disabled={busy}>
        {busy ? "正在确认…" : "确认并登录"}</button>
        <button className="platform-button platform-button--secondary" type="button" onClick={onCancel} disabled={busy}>
          返回登录</button></div>
    </form>
  </div>;
}
