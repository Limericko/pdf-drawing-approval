import { AlertCircle, CheckCircle2, Info, TriangleAlert, WifiOff, type LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "../actions/index.tsx";
import styles from "./Feedback.module.css";

export type FeedbackTone = "info" | "success" | "warning" | "danger";

const toneIcon: Readonly<Record<FeedbackTone, LucideIcon>> = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  danger: AlertCircle
};

export function InlineAlert({ tone = "info", title, children, className, ...props }:
  HTMLAttributes<HTMLDivElement> & { readonly tone?: FeedbackTone; readonly title?: string }) {
  const Icon = toneIcon[tone];
  return <div {...props} role={props.role ?? (tone === "danger" ? "alert" : "status")}
    tabIndex={props.tabIndex ?? (tone === "danger" ? -1 : undefined)} data-tone={tone}
    className={join(styles.alert, className)}>
    <Icon aria-hidden="true" size={18} strokeWidth={2} />
    <div>{title ? <strong>{title}</strong> : null}<div>{children}</div></div>
  </div>;
}

export function Toast({ tone = "info", children, className, ...props }:
  HTMLAttributes<HTMLDivElement> & { readonly tone?: FeedbackTone }) {
  return <div {...props} role={props.role ?? "status"} aria-live="polite" data-tone={tone}
    className={join(styles.toast, className)}>{children}</div>;
}

const saveLabels = {
  saving: "正在保存",
  saved: "已保存",
  error: "保存失败",
  offline: "离线草稿"
} as const;

export function SaveIndicator({ status }: { readonly status: keyof typeof saveLabels }) {
  return <span className={styles.saveIndicator} data-status={status} role="status" aria-live="polite"
    aria-busy={status === "saving" || undefined}>{saveLabels[status]}</span>;
}

export function Progress({ label, value }: { readonly label: string; readonly value: number }) {
  const bounded = Math.max(0, Math.min(100, value));
  return <div className={styles.progressBlock}>
    <div><span>{label}</span><strong>{bounded}%</strong></div>
    <div className={styles.progressTrack} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={bounded}><span style={{ transform: `scaleX(${bounded / 100})` }} /></div>
  </div>;
}

export function Skeleton({ lines = 1, label = "正在加载", className }: {
  readonly lines?: number;
  readonly label?: string;
  readonly className?: string;
}) {
  return <div className={join(styles.skeleton, className)} aria-busy="true" aria-label={label}>
    <span className={styles.visuallyHidden}>{label}</span>
    {Array.from({ length: Math.max(1, lines) }, (_, index) => <span key={index} />)}
  </div>;
}

export function EmptyState({ title, children, action }: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  return <section className={styles.state} data-state="empty"><Info aria-hidden="true" size={22} />
    <div><h3>{title}</h3>{children ? <p>{children}</p> : null}{action}</div></section>;
}

export function ErrorState({ title, children, onRetry }: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly onRetry?: () => void;
}) {
  return <section className={styles.state} data-state="error" role="alert" tabIndex={-1}>
    <AlertCircle aria-hidden="true" size={22} /><div><h3>{title}</h3>{children ? <p>{children}</p> : null}
      {onRetry ? <Button variant="secondary" size="sm" onClick={onRetry}>重试</Button> : null}</div>
  </section>;
}

export function ConnectionBanner({ status, children }: {
  readonly status: "offline" | "maintenance" | "reconnecting";
  readonly children: ReactNode;
}) {
  return <div className={styles.connection} data-status={status} role="status" aria-live="polite">
    <WifiOff aria-hidden="true" size={18} /><span>{children}</span>
  </div>;
}

function join(...values: readonly (string | undefined)[]) {
  return values.filter(Boolean).join(" ");
}
