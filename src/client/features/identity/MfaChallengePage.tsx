import { useState, type FormEvent } from "react";
import type { MfaCompleteRequest } from "../../../shared/contracts/identity.ts";
import { Button } from "../../ui/actions/index.tsx";
import { FormActions, RadioGroup, TextInput } from "../../ui/forms/index.tsx";
import { InlineAlert } from "../../ui/feedback/index.tsx";

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
    {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
    <form className="platform-form" onSubmit={submit} aria-busy={busy}>
      <RadioGroup legend="验证方式" name="method" value={method} disabled={busy}
        onChange={(value) => setMethod(value as MfaCompleteRequest["factor"]["method"])} options={[
          { value: "totp", label: "身份验证器", description: "输入 6 位动态验证码" },
          { value: "recovery", label: "恢复码", description: "使用一枚未使用的恢复码" }
        ]} />
      <TextInput id="platform-mfa-code" name="code" label={method === "totp" ? "6 位动态验证码" : "恢复码"}
        inputMode={method === "totp" ? "numeric" : "text"} autoComplete="one-time-code" autoFocus required
        maxLength={128} disabled={busy} />
      <FormActions><Button type="submit" loading={busy} loadingLabel="正在确认">确认并登录</Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>返回登录</Button></FormActions>
    </form>
  </div>;
}
