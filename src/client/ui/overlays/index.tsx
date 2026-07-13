import { X } from "lucide-react";
import { cloneElement, isValidElement, useEffect, useId, useRef, type ReactElement, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton } from "../actions/index.tsx";
import styles from "./Overlays.module.css";

type DialogProps = {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  readonly closeLabel?: string;
  readonly closeOnBackdrop?: boolean;
  readonly closeOnEscape?: boolean;
  readonly closeDisabled?: boolean;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly size?: "sm" | "md" | "lg";
  readonly className?: string;
};

export function Dialog({ open, title, description, children, footer, onClose, closeLabel = "关闭对话框",
  closeOnBackdrop = false, closeOnEscape = true, closeDisabled = false, initialFocusRef, size = "md", className }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useOverlayFocus(open, onClose, dialogRef, initialFocusRef, closeOnEscape);
  if (!open) return null;
  return renderPortal(<div className={styles.backdrop} onMouseDown={(event) => {
    if (closeOnBackdrop && event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialogRef} className={join(styles.dialog, className)} data-size={size} role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1}>
      <header className={styles.header}><div><h2 id={titleId}>{title}</h2>
        {description ? <p id={descriptionId}>{description}</p> : null}</div>
        <IconButton label={closeLabel} variant="ghost" size="sm" onClick={onClose} disabled={closeDisabled}><X size={18} aria-hidden="true" /></IconButton>
      </header>
      <div className={styles.body}>{children}</div>
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </div>
  </div>);
}

export function ConfirmDialog({ open, title, description, confirmLabel = "确认", cancelLabel = "取消", danger = false,
  busy = false, onConfirm, onClose }: {
  readonly open: boolean;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return <Dialog open={open} title={title} onClose={onClose} size="sm" initialFocusRef={cancelRef}
    footer={<><Button ref={cancelRef} variant="secondary" onClick={onClose} disabled={busy}>{cancelLabel}</Button>
      <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={busy}
        loadingLabel="正在处理">{confirmLabel}</Button></>}>
    <p>{description}</p>
  </Dialog>;
}

export function Drawer({ open, title, description, children, footer, onClose }: Omit<DialogProps, "size">) {
  const titleId = useId();
  const descriptionId = useId();
  const drawerRef = useRef<HTMLDivElement>(null);
  useOverlayFocus(open, onClose, drawerRef, undefined, true);
  if (!open) return null;
  return renderPortal(<div className={join(styles.backdrop, styles.drawerBackdrop)}>
    <aside ref={drawerRef} className={join(styles.dialog, styles.drawer)} role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1}>
      <header className={styles.header}><div><h2 id={titleId}>{title}</h2>
        {description ? <p id={descriptionId}>{description}</p> : null}</div>
        <IconButton label="关闭抽屉" variant="ghost" size="sm" onClick={onClose}><X size={18} aria-hidden="true" /></IconButton>
      </header><div className={styles.body}>{children}</div>{footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </aside>
  </div>);
}

export function Popover({ open, trigger, children, onClose, label }: {
  readonly open: boolean;
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly label: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [onClose, open]);
  return <div ref={rootRef} className={styles.popoverRoot}>{trigger}
    {open ? <div className={styles.popover} role="dialog" aria-label={label}>{children}</div> : null}</div>;
}

export function Tooltip({ content, children }: { readonly content: ReactNode; readonly children: ReactNode }) {
  const id = useId();
  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, { "aria-describedby": id })
    : children;
  return <span className={styles.tooltipRoot}>{trigger}<span id={id} role="tooltip" className={styles.tooltip}>{content}</span></span>;
}

function useOverlayFocus(open: boolean, onClose: () => void, containerRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null> | undefined, closeOnEscape: boolean) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => {
      const first = initialFocusRef?.current ?? focusable(containerRef.current)[0] ?? containerRef.current;
      first?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && closeOnEscape) { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable(containerRef.current);
      if (items.length === 0) { event.preventDefault(); containerRef.current?.focus(); return; }
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [closeOnEscape, containerRef, initialFocusRef, open]);
}

function focusable(container: HTMLElement | null) {
  if (!container) return [];
  return [...container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function renderPortal(node: ReactNode) {
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}

function join(...values: readonly (string | undefined)[]) { return values.filter(Boolean).join(" "); }
