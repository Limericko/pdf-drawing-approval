import { LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../ui/actions/index.tsx";
import styles from "./AppShell.module.css";

export function AppShell({ collapsed, onToggleCollapsed, brand, navigation, user, onLogout, children }: {
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly brand: { readonly name: string; readonly subtitle: string; readonly logoSrc: string };
  readonly navigation: ReactNode;
  readonly user: { readonly displayName: string; readonly roleLabel: string; readonly compactRoleLabel: string };
  readonly onLogout: () => void;
  readonly children: ReactNode;
}) {
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return <div className={styles.shell} data-collapsed={collapsed}>
    <a className={styles.skipLink} href="#main-content">跳到主要内容</a>
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <span className={styles.mark}><img src={brand.logoSrc} alt={brand.name} /></span>
        <div className={styles.brandText}><strong>{brand.name}</strong><span>{brand.subtitle}</span></div>
      </div>
      <Button variant="ghost" size="sm" className={styles.toggle} aria-pressed={collapsed}
        aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"} onClick={onToggleCollapsed}>
        <span className={styles.toggleContent}><ToggleIcon size={18} aria-hidden="true" />
          <span>{collapsed ? "展开侧栏" : "收起侧栏"}</span></span>
      </Button>
      {navigation}
      <div className={styles.userPanel}>
        <div className={styles.userIdentity}><strong>{user.displayName}</strong><span>{user.roleLabel}</span>
          <span className={styles.compactRole} aria-hidden="true">{user.compactRoleLabel}</span></div>
        <Button variant="ghost" size="sm" className={styles.logout} aria-label="退出登录" title="退出登录" onClick={onLogout}>
          <LogOut size={16} aria-hidden="true" /><span>退出</span>
        </Button>
      </div>
    </aside>
    <main id="main-content" className={styles.main}><div className={styles.content}>{children}</div></main>
  </div>;
}
