import { useRef, useState, type FormEvent } from "react";

export type InvitationQrCode =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly dataUrl: string }
  | { readonly status: "error"; readonly message: string };

type ClipboardWriter = { writeText(value: string): Promise<void> };

export async function copyInvitationSecret(
  secret: string,
  clipboard: ClipboardWriter | undefined = globalThis.navigator?.clipboard
) {
  if (!clipboard?.writeText) {
    return { status: "error" as const, message: "当前浏览器无法复制，请手工选择并复制密钥。" };
  }
  try {
    await clipboard.writeText(secret);
    return { status: "success" as const, message: "密钥已复制，请立即保存到身份验证器。" };
  } catch {
    return { status: "error" as const, message: "复制失败，请手工选择并复制密钥。" };
  }
}

export function InvitationAcceptancePage({
  stage,
  busy,
  error,
  manualSecret,
  qrCode,
  onComplete,
  onCancel
}: {
  readonly stage: "preparing" | "prepared";
  readonly busy: boolean;
  readonly error: string;
  readonly manualSecret: string;
  readonly qrCode: InvitationQrCode;
  readonly onComplete: (input: { readonly password: string; readonly totp: string }) => void | Promise<void>;
  readonly onCancel: () => void;
}) {
  const copyGeneration = useRef({ stage, secret: manualSecret, version: 0 });
  if (copyGeneration.current.stage !== stage || copyGeneration.current.secret !== manualSecret) {
    copyGeneration.current = { stage, secret: manualSecret, version: copyGeneration.current.version + 1 };
  }
  const [copyFeedback, setCopyFeedback] = useState<{
    readonly version: number;
    readonly status: "success" | "error";
    readonly message: string;
  }>();

  async function copySecret() {
    const current = copyGeneration.current;
    const result = await copyInvitationSecret(current.secret);
    if (copyGeneration.current.version === current.version && copyGeneration.current.stage === "prepared") {
      setCopyFeedback({ version: current.version, ...result });
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") ?? "");
    const confirmation = String(data.get("passwordConfirmation") ?? "");
    if (password !== confirmation) {
      const confirmationInput = event.currentTarget.elements.namedItem("passwordConfirmation") as HTMLInputElement;
      confirmationInput.setCustomValidity("两次输入的密码不一致");
      confirmationInput.reportValidity();
      return;
    }
    void onComplete({ password, totp: String(data.get("totp") ?? "") });
  }
  return <div className="platform-panel platform-panel--activation">
    <p className="platform-kicker">账号激活 · 02</p><h1 tabIndex={-1}>设置安全登录</h1>
    <p className="platform-lead">设置密码并绑定身份验证器，完成后会生成一次性恢复码。</p>
    {error ? <p className="platform-error" role="alert" tabIndex={-1}>{error}</p> : null}
    {stage === "preparing" ? <p aria-busy="true">正在验证邀请并准备安全设置…</p> : <>
      <div className="platform-enrollment">
        <div className="platform-qr" aria-live="polite">
          {qrCode.status === "ready" ? <img src={qrCode.dataUrl} alt="身份验证器二维码" width="220" height="220" /> :
            qrCode.status === "loading" ? <p aria-busy="true">正在本地生成二维码…</p> :
              <p className="platform-error" role="alert" tabIndex={-1}>{qrCode.message}</p>}
        </div>
        <div><p className="platform-eyebrow">手工密钥</p><code>{manualSecret || "无法读取，请重新打开邀请链接"}</code>
          <p>若无法扫描二维码，请在身份验证器中手工输入此密钥。</p>
          {manualSecret ? <button className="platform-button platform-button--secondary" type="button"
            disabled={busy} onClick={() => void copySecret()}>复制密钥</button> : null}
          <p className={copyFeedback?.status === "error" ? "platform-copy-feedback platform-error" :
            "platform-copy-feedback"} aria-live="polite">
            {copyFeedback?.version === copyGeneration.current.version ? copyFeedback.message : ""}
          </p></div>
      </div>
      <form className="platform-form" onSubmit={submit} aria-busy={busy}>
        <div className="platform-form-grid"><div><label htmlFor="platform-new-password">设置密码</label>
          <input id="platform-new-password" name="password" type="password" autoComplete="new-password"
            minLength={12} maxLength={256} autoFocus required disabled={busy} /></div>
          <div><label htmlFor="platform-confirm-password">确认密码</label>
          <input id="platform-confirm-password" name="passwordConfirmation" type="password" autoComplete="new-password"
            minLength={12} maxLength={256} required disabled={busy}
            onInput={(event) => event.currentTarget.setCustomValidity("")} /></div></div>
        <label htmlFor="platform-enrollment-totp">动态验证码</label>
        <input id="platform-enrollment-totp" name="totp" inputMode="numeric" autoComplete="one-time-code"
          maxLength={128} required disabled={busy} />
        <div className="platform-actions"><button className="platform-button" type="submit" disabled={busy}>
          {busy ? "正在激活…" : "完成激活"}</button>
          <button className="platform-button platform-button--secondary" type="button" onClick={onCancel} disabled={busy}>
            取消激活</button></div>
      </form>
    </>}
  </div>;
}
