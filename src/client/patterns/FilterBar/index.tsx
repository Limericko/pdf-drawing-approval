import type { ReactNode } from "react";
import styles from "./FilterBar.module.css";

export function FilterBar({ children, actions, summary, label = "筛选条件" }: {
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly summary?: ReactNode;
  readonly label?: string;
}) {
  return <section className={styles.bar} aria-label={label}><div className={styles.fields}>{children}</div>
    {actions ? <div className={styles.actions}>{actions}</div> : null}
    {summary ? <div className={styles.summary} role="status">{summary}</div> : null}</section>;
}
