import { useState, type FormEvent } from "react";
import type { UpdateOwnAccountRequest } from "../../../shared/contracts/identity.ts";
import type { PlatformIdentityUser } from "./identityState.ts";
import { Button } from "../../ui/actions/index.tsx";
import { InlineAlert } from "../../ui/feedback/index.tsx";
import { PasswordInput, TextInput } from "../../ui/forms/index.tsx";

export function InitialAccountSetupPage({ user, busy, error, onSubmit }: { readonly user: PlatformIdentityUser;
  readonly busy: boolean; readonly error: string;
  readonly onSubmit: (input: UpdateOwnAccountRequest) => void | Promise<void> }) {
  const [mismatch, setMismatch] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const newPassword = String(data.get("newPassword") ?? "");
    if (newPassword !== String(data.get("confirmPassword") ?? "")) {
      setMismatch("两次输入的新密码不一致。");
      return;
    }
    setMismatch("");
    void onSubmit({ username: String(data.get("username") ?? ""), email: String(data.get("email") ?? ""),
      currentPassword: String(data.get("currentPassword") ?? ""), newPassword });
  }
  return <div className="platform-panel platform-panel--narrow">
    <p className="platform-kicker">首次安全设置 · 必须完成</p>
    <h1 tabIndex={-1}>修改初始管理员密码</h1>
    <p className="platform-lead">为避免默认口令暴露，完成以下设置后才能进入工作台。用户名和邮箱以后仍可在系统管理中修改。</p>
    {error || mismatch ? <InlineAlert tone="danger">{mismatch || error}</InlineAlert> : null}
    <form className="platform-form" onSubmit={submit} aria-busy={busy}>
      <TextInput id="initial-username" name="username" label="管理员用户名"
        defaultValue={user.usernameNormalized ?? "admin"} minLength={3} maxLength={32} required disabled={busy} />
      <TextInput id="initial-email" name="email" type="email" label="管理员邮箱"
        defaultValue={user.emailNormalized} maxLength={254} required disabled={busy} />
      <PasswordInput id="initial-current-password" name="currentPassword" label="当前初始密码"
        autoComplete="current-password" maxLength={256} required disabled={busy} />
      <PasswordInput id="initial-new-password" name="newPassword" label="新密码（至少 12 个字符）"
        autoComplete="new-password" minLength={12} maxLength={256} required disabled={busy} />
      <PasswordInput id="initial-confirm-password" name="confirmPassword" label="确认新密码"
        autoComplete="new-password" minLength={12} maxLength={256} required disabled={busy} />
      <Button type="submit" loading={busy} loadingLabel="正在保存">完成安全设置</Button>
    </form>
  </div>;
}
