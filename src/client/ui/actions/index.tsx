import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import styles from "./Actions.module.css";

export type ActionVariant = "primary" | "secondary" | "ghost" | "danger";
export type ActionSize = "sm" | "md";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: ActionVariant;
  readonly size?: ActionSize;
  readonly loading?: boolean;
  readonly loadingLabel?: string;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = "primary",
  size = "md",
  loading = false,
  loadingLabel = "处理中",
  disabled,
  className,
  children,
  type = "button",
  ...props
}, ref) {
  const accessibleLabel = props["aria-label"] ?? (loading ? loadingLabel : undefined);
  return <button {...props} ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
    aria-label={accessibleLabel}
    data-variant={variant} data-size={size} className={join(styles.button, className)}>
    <span className={styles.content}>
      <span className={loading ? styles.hiddenLabel : undefined}>{children}</span>
      {loading ? <span className={styles.loadingLabel} aria-hidden="true">{loadingLabel}</span> : null}
    </span>
  </button>;
});

export type IconButtonProps = Omit<ButtonProps, "children"> & {
  readonly label: string;
  readonly tooltip?: string;
  readonly children: ReactNode;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  label,
  tooltip = label,
  className,
  children,
  ...props
}, ref) {
  return <Button {...props} ref={ref} aria-label={label} title={tooltip} className={join(styles.iconButton, className)}>
    {children}
  </Button>;
});

export type ButtonLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  readonly variant?: Exclude<ActionVariant, "danger">;
  readonly size?: ActionSize;
};

export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}, ref) {
  return <a {...props} ref={ref} data-variant={variant} data-size={size}
    className={join(styles.button, styles.link, className)}>{children}</a>;
});

export const ButtonGroup = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ButtonGroup({
  className,
  children,
  ...props
}, ref) {
  return <div {...props} ref={ref} role={props.role ?? "group"} className={join(styles.group, className)}>{children}</div>;
});

function join(...values: readonly (string | undefined)[]) {
  return values.filter(Boolean).join(" ");
}
