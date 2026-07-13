export function RecoveryCodesPage({
  recoveryCodes,
  acknowledged,
  onAcknowledgedChange,
  onContinue
}: {
  readonly recoveryCodes: readonly string[];
  readonly acknowledged: boolean;
  readonly onAcknowledgedChange: (checked: boolean) => void;
  readonly onContinue: () => void;
}) {
  return <div className="platform-panel platform-panel--narrow">
    <p className="platform-kicker">安全确认 · 最后一步</p><h1 tabIndex={-1}>保存恢复码</h1>
    <p className="platform-lead">每枚恢复码只能使用一次。离开此页面后将不再显示。</p>
    <ol className="platform-recovery-codes">{recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ol>
    <label className="platform-confirmation"><input type="checkbox" checked={acknowledged}
      onChange={(event) => onAcknowledgedChange(event.currentTarget.checked)} />
      <span>我已将恢复码保存在安全位置</span></label>
    <button className="platform-button platform-button--wide" type="button" disabled={!acknowledged} onClick={onContinue}>
      继续登录</button>
  </div>;
}
