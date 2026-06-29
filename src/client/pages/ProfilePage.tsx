import { useEffect, useState } from "react";
import {
  getProfile,
  sendProfileTestEmail,
  updateProfile,
  type NotificationEventOption,
  type NotificationPreferences,
  type Profile,
  type User
} from "../api.ts";

export function ProfilePage({ onUserUpdated }: { onUserUpdated: (user: User) => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [commonProjects, setCommonProjects] = useState<string[]>([]);
  const [projectInput, setProjectInput] = useState("");
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences>({ email: {} });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setBusy("load");
    setError("");
    getProfile()
      .then((nextProfile) => {
        if (!active) return;
        applyProfile(nextProfile);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "PROFILE_LOAD_FAILED");
      })
      .finally(() => {
        if (active) setBusy("");
      });
    return () => {
      active = false;
    };
  }, []);

  function applyProfile(nextProfile: Profile) {
    setProfile(nextProfile);
    setDisplayName(nextProfile.user.displayName);
    setEmail(nextProfile.user.email ?? "");
    setCommonProjects(roleUsesCommonProjects(nextProfile.user.role) ? nextProfile.commonProjects : []);
    setNotificationPreferences(nextProfile.notificationPreferences);
  }

  function addProject() {
    setCommonProjects((current) => addCommonProject(current, projectInput));
    setProjectInput("");
  }

  async function save() {
    setBusy("save");
    setError("");
    setMessage("");
    try {
      const saved = await updateProfile({
        displayName,
        email,
        commonProjects: roleUsesCommonProjects(profile?.user.role) ? commonProjects : [],
        notificationPreferences
      });
      applyProfile(saved);
      onUserUpdated(saved.user);
      setMessage("资料已保存。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "PROFILE_SAVE_FAILED");
    } finally {
      setBusy("");
    }
  }

  async function sendTestEmail() {
    setBusy("test-email");
    setError("");
    setMessage("");
    try {
      await sendProfileTestEmail();
      setMessage("测试邮件已发送，请检查你的邮箱。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "TEST_EMAIL_FAILED");
    } finally {
      setBusy("");
    }
  }

  const events = profile?.availableNotificationEvents ?? [];
  const showCommonProjects = roleUsesCommonProjects(profile?.user.role);

  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MY PROFILE</span>
          <h1>我的资料</h1>
          <p>{profileIntroText(profile?.user.role)}</p>
        </div>
        <button type="button" onClick={() => void save()} disabled={busy === "save" || !displayName.trim()}>
          {busy === "save" ? "保存中" : "保存资料"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}
      {busy === "load" && <div className="empty">正在读取个人资料...</div>}

      {profile && (
        <div className="profile-page-grid">
          <section className="profile-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">BASIC</span>
                <h2>基础资料</h2>
              </div>
            </div>
            <div className="profile-form-grid">
              <label>
                用户名
                <input value={profile.user.username} readOnly />
              </label>
              <label>
                角色
                <input value={roleLabel(profile.user.role)} readOnly />
              </label>
              <label>
                显示名
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
              </label>
              <label>
                邮箱
                <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" />
              </label>
            </div>
            <div className="form-actions">
              <button type="button" className="secondary-button" onClick={() => void sendTestEmail()} disabled={!profile.user.email || busy === "test-email"}>
                {busy === "test-email" ? "发送中" : "给自己发送测试邮件"}
              </button>
            </div>
          </section>

          {showCommonProjects && (
            <section className="profile-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">PROJECTS</span>
                  <h2>常用项目</h2>
                </div>
              </div>
              <div className="profile-inline-form">
                <input
                  value={projectInput}
                  onChange={(event) => setProjectInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addProject();
                    }
                  }}
                  placeholder="输入项目名称"
                />
                <button type="button" className="secondary-button" onClick={addProject} disabled={!projectInput.trim()}>
                  添加
                </button>
              </div>
              <div className="profile-chip-list">
                {commonProjects.length === 0 && <span className="hint">暂无常用项目。</span>}
                {commonProjects.map((project) => (
                  <button
                    key={project}
                    type="button"
                    className="profile-chip"
                    onClick={() => setCommonProjects((current) => removeCommonProject(current, project))}
                    title="点击移除"
                  >
                    {project}
                    <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="profile-panel profile-panel--wide">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">NOTIFICATIONS</span>
                <h2>通知偏好</h2>
              </div>
            </div>
            <div className="notification-preference-list">
              {events.map((event) => (
                <NotificationPreferenceRow
                  key={event.key}
                  event={event}
                  checked={Boolean(notificationPreferences.email[event.key])}
                  onChange={(checked) =>
                    setNotificationPreferences((current) => updateNotificationPreference(current, event.key, checked))
                  }
                />
              ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function NotificationPreferenceRow(props: {
  event: NotificationEventOption;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="notification-preference-row">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>
        <strong>{props.event.label}</strong>
        <em>{props.event.description}</em>
      </span>
    </label>
  );
}

export function addCommonProject(projects: string[], project: string) {
  const name = project.trim();
  if (!name || projects.includes(name)) return projects;
  return [...projects, name].slice(0, 20);
}

export function removeCommonProject(projects: string[], project: string) {
  return projects.filter((item) => item !== project);
}

export function roleUsesCommonProjects(role: string | null | undefined) {
  return role === "designer" || role === "supervisor" || role === "process";
}

export function profileIntroText(role: string | null | undefined) {
  return roleUsesCommonProjects(role) ? "维护邮箱、常用项目和审批进度提醒。" : "维护邮箱和系统运维提醒。";
}

export function updateNotificationPreference(
  preferences: NotificationPreferences,
  key: string,
  enabled: boolean
): NotificationPreferences {
  return {
    email: {
      ...preferences.email,
      [key]: enabled
    }
  };
}

function roleLabel(role: User["role"]) {
  return {
    designer: "设计师",
    supervisor: "主管",
    process: "工艺",
    admin: "管理员"
  }[role];
}
