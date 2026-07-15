import type { FormEvent } from "react";
import type { LoginRequest } from "../../../shared/contracts/identity.ts";
import { Button } from "../../ui/actions/index.tsx";
import { PasswordInput, TextInput } from "../../ui/forms/index.tsx";
import { InlineAlert } from "../../ui/feedback/index.tsx";

export function PlatformLoginPage({
  busy,
  error,
  notice,
  onSubmit
}: {
  readonly busy: boolean;
  readonly error: string;
  readonly notice?: string;
  readonly onSubmit: (input: LoginRequest) => void | Promise<void>;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void onSubmit({ account: String(data.get("account") ?? ""), password: String(data.get("password") ?? "") });
  }

  return <div className="platform-panel platform-panel--narrow">
    <p className="platform-kicker">验证身份 · 01</p>
    <h1 tabIndex={-1}>登录审批平台</h1>
    <p className="platform-lead">管理员可使用用户名登录，受邀成员也可继续使用邮箱登录。</p>
    {notice ? <InlineAlert tone="success">{notice}</InlineAlert> : null}
    {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
    <form className="platform-form" onSubmit={submit} aria-busy={busy}>
      <TextInput id="platform-login-account" name="account" type="text" label="用户名或邮箱地址" autoComplete="username"
        maxLength={254} autoFocus required disabled={busy} />
      <PasswordInput id="platform-login-password" name="password" label="密码" autoComplete="current-password"
        maxLength={256} required disabled={busy} />
      <Button type="submit" loading={busy} loadingLabel="正在验证">继续验证</Button>
    </form>
  </div>;
}
