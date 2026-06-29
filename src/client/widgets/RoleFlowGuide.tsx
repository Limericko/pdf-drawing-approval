import { useState } from "react";
import type { User } from "../api.ts";
import { roleGuideForRole } from "../roleGuide.ts";

export function roleGuideStorageKey(role: User["role"]) {
  return `pdf_approval_role_guide_collapsed_${role}`;
}

export function readRoleGuideCollapsed(storage: Pick<Storage, "getItem">, role: User["role"]) {
  try {
    return storage.getItem(roleGuideStorageKey(role)) === "1";
  } catch {
    return false;
  }
}

export function writeRoleGuideCollapsed(storage: Pick<Storage, "setItem" | "removeItem">, role: User["role"], collapsed: boolean) {
  try {
    if (collapsed) {
      storage.setItem(roleGuideStorageKey(role), "1");
    } else {
      storage.removeItem(roleGuideStorageKey(role));
    }
  } catch {
    // Local storage can be unavailable in locked-down desktop/browser policies.
  }
}

export function RoleFlowGuide({ user }: { user: User }) {
  const guide = roleGuideForRole(user.role);
  const [collapsed, setCollapsed] = useState(() => {
    if (!guide || typeof localStorage === "undefined") return false;
    return readRoleGuideCollapsed(localStorage, user.role);
  });

  if (!guide) return null;

  function setGuideCollapsed(nextCollapsed: boolean) {
    setCollapsed(nextCollapsed);
    if (typeof localStorage !== "undefined") writeRoleGuideCollapsed(localStorage, user.role, nextCollapsed);
  }

  if (collapsed) {
    return (
      <div className="role-flow-guide role-flow-guide--collapsed">
        <div>
          <strong>{guide.title}</strong>
          <span>{guide.steps.join(" / ")}</span>
        </div>
        <button type="button" className="secondary-button" onClick={() => setGuideCollapsed(false)}>
          展开流程
        </button>
      </div>
    );
  }

  return (
    <section className="role-flow-guide" aria-label={`${guide.title}向导`}>
      <div className="role-flow-guide__copy">
        <span className="eyebrow">ROLE GUIDE</span>
        <h2>{guide.title}</h2>
        <p>{guide.summary}</p>
      </div>
      <ol className="role-flow-guide__steps">
        {guide.steps.map((step, index) => (
          <li key={step}>
            <span>{index + 1}</span>
            <strong>{step}</strong>
          </li>
        ))}
      </ol>
      <div className="role-flow-guide__actions">
        <a className="button-link" href={guide.primaryHref}>{guide.primaryLabel}</a>
        <button type="button" className="secondary-button" onClick={() => setGuideCollapsed(true)}>
          收起
        </button>
      </div>
    </section>
  );
}
