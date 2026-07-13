import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./Navigation.module.css";

export type AppNavigationItem = {
  readonly id: string;
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
};

export function AppNavigation({ items, currentId, collapsed, onIntent }: {
  readonly items: readonly AppNavigationItem[];
  readonly currentId: string;
  readonly collapsed: boolean;
  readonly onIntent?: (id: string) => void;
}) {
  return <nav className={styles.navigation} data-collapsed={collapsed} aria-label="主导航">
    {items.map((item) => { const Icon = item.icon; return <a key={item.href} href={item.href} title={item.label}
      aria-label={item.label} aria-current={currentId === item.id ? "page" : undefined} className={styles.link}
      onMouseEnter={() => onIntent?.(item.id)} onFocus={() => onIntent?.(item.id)}>
      <span className={styles.icon} aria-hidden="true"><Icon size={18} strokeWidth={2} /></span>
      <span className={styles.label}>{item.label}</span>
    </a>; })}
  </nav>;
}

export function Breadcrumbs({ items }: { readonly items: readonly { readonly label: string; readonly href?: string }[] }) {
  return <nav aria-label="面包屑"><ol className={styles.breadcrumbs}>{items.map((item, index) => <li key={`${item.label}-${index}`}>
    {item.href ? <a href={item.href}>{item.label}</a> : <span aria-current="page">{item.label}</span>}
  </li>)}</ol></nav>;
}

type ChoiceItem = { readonly id: string; readonly label: ReactNode; readonly disabled?: boolean };

export function Tabs({ items, activeId, onChange, label }: {
  readonly items: readonly ChoiceItem[];
  readonly activeId: string;
  readonly onChange: (id: string) => void;
  readonly label: string;
}) {
  return <div className={styles.tabs} role="tablist" aria-label={label}>{items.map((item) => <button key={item.id}
    type="button" role="tab" aria-selected={item.id === activeId} disabled={item.disabled}
    onClick={() => onChange(item.id)}>{item.label}</button>)}</div>;
}

export function SegmentedControl({ items, activeId, onChange, label }: {
  readonly items: readonly ChoiceItem[];
  readonly activeId: string;
  readonly onChange: (id: string) => void;
  readonly label: string;
}) {
  return <div className={styles.segments} role="group" aria-label={label}>{items.map((item) => <button key={item.id}
    type="button" aria-pressed={item.id === activeId} disabled={item.disabled}
    onClick={() => onChange(item.id)}>{item.label}</button>)}</div>;
}
