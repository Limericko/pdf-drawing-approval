import type { FormEvent } from "react";
import type { LoginRequest } from "../../../shared/contracts/identity.ts";
import { Button } from "../../ui/actions/index.tsx";
import { PasswordInput, TextInput } from "../../ui/forms/index.tsx";
import { InlineAlert } from "../../ui/feedback/index.tsx";

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
    {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
    <form className="platform-form" onSubmit={submit} aria-busy={busy}>
      <TextInput id="platform-login-email" name="email" type="email" label="邮箱地址" autoComplete="username"
        maxLength={254} autoFocus required disabled={busy} />
      <PasswordInput id="platform-login-password" name="password" label="密码" autoComplete="current-password"
        maxLength={256} required disabled={busy} />
      <Button type="submit" loading={busy} loadingLabel="正在验证">继续验证</Button>
    </form>
  </div>;
}
