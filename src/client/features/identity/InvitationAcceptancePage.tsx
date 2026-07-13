import { useRef, useState, type FormEvent } from "react";
import { Button } from "../../ui/actions/index.tsx";
import { FormActions, PasswordInput, TextInput } from "../../ui/forms/index.tsx";
import { InlineAlert } from "../../ui/feedback/index.tsx";

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
    {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
    {stage === "preparing" ? <p aria-busy="true">正在验证邀请并准备安全设置…</p> : <>
      <div className="platform-enrollment">
        <div className="platform-qr" aria-live="polite">
          {qrCode.status === "ready" ? <img src={qrCode.dataUrl} alt="身份验证器二维码" width="220" height="220" /> :
            qrCode.status === "loading" ? <p aria-busy="true">正在本地生成二维码…</p> :
              <InlineAlert tone="danger">{qrCode.message}</InlineAlert>}
        </div>
        <div><p className="platform-eyebrow">手工密钥</p><code>{manualSecret || "无法读取，请重新打开邀请链接"}</code>
          <p>若无法扫描二维码，请在身份验证器中手工输入此密钥。</p>
          {manualSecret ? <Button variant="secondary" disabled={busy} onClick={() => void copySecret()}>复制密钥</Button> : null}
          {copyFeedback?.version === copyGeneration.current.version ? <InlineAlert
            tone={copyFeedback.status === "error" ? "danger" : "success"}>{copyFeedback.message}</InlineAlert> : null}</div>
      </div>
      <form className="platform-form" onSubmit={submit} aria-busy={busy}>
        <div className="platform-form-grid"><PasswordInput id="platform-new-password" name="password" label="设置密码"
          autoComplete="new-password" minLength={12} maxLength={256} autoFocus required disabled={busy} />
          <PasswordInput id="platform-confirm-password" name="passwordConfirmation" label="确认密码"
            autoComplete="new-password" minLength={12} maxLength={256} required disabled={busy}
            onInput={(event) => event.currentTarget.setCustomValidity("")} /></div>
        <TextInput id="platform-enrollment-totp" name="totp" label="动态验证码" inputMode="numeric"
          autoComplete="one-time-code" maxLength={128} required disabled={busy} />
        <FormActions><Button type="submit" loading={busy} loadingLabel="正在激活">完成激活</Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>取消激活</Button></FormActions>
      </form>
    </>}
  </div>;
}
