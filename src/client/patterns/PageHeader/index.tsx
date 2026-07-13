import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

export function PageHeader({ title, eyebrow, description, breadcrumbs, actions, metadata }: {
  readonly title: string;
  readonly eyebrow?: string;
  readonly description?: ReactNode;
  readonly breadcrumbs?: ReactNode;
  readonly actions?: ReactNode;
  readonly metadata?: ReactNode;
}) {
  return <header className={styles.header}>
    {breadcrumbs ? <div className={styles.breadcrumbs}>{breadcrumbs}</div> : null}
    <div className={styles.row}><div className={styles.copy}>{eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
      <h1>{title}</h1>{description ? <p className={styles.description}>{description}</p> : null}</div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}</div>
    {metadata ? <div className={styles.metadata}>{metadata}</div> : null}
  </header>;
}
