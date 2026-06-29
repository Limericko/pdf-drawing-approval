import type { DatabaseConnection } from "../db.ts";
import type { User } from "./users.ts";

export type NotificationEventKey =
  | "reviewTaskCreated"
  | "peerReviewCompleted"
  | "approvalRejected"
  | "approvalApprovedForPrint"
  | "signatureFailed"
  | "approvalPrinted"
  | "systemRisk";

export type NotificationPreferences = {
  email: Record<NotificationEventKey, boolean>;
};

export type UserPreferenceProfile = {
  userId: number;
  commonProjects: string[];
  notificationPreferences: NotificationPreferences;
  updatedAt: string | null;
};

export type UserPreferenceInput = {
  commonProjects?: string[];
  notificationPreferences?: Partial<{
    email: Partial<Record<NotificationEventKey, boolean>>;
  }>;
};

type UserPreferenceRow = {
  user_id: number;
  common_projects_json: string;
  notification_preferences_json: string;
  updated_at: string;
};

export const notificationEventKeys: NotificationEventKey[] = [
  "reviewTaskCreated",
  "peerReviewCompleted",
  "approvalRejected",
  "approvalApprovedForPrint",
  "signatureFailed",
  "approvalPrinted",
  "systemRisk"
];

const maxCommonProjects = 20;
const maxCommonProjectLength = 80;

export class UserPreferenceRepository {
  constructor(private readonly db: DatabaseConnection) {}

  getForUser(user: Pick<User, "id" | "role">): UserPreferenceProfile {
    const row = this.db.prepare("SELECT * FROM user_preferences WHERE user_id = ?").get(user.id) as UserPreferenceRow | undefined;
    if (!row) {
      return {
        userId: user.id,
        commonProjects: [],
        notificationPreferences: defaultNotificationPreferencesForRole(user.role),
        updatedAt: null
      };
    }

    return {
      userId: row.user_id,
      commonProjects: parseCommonProjects(row.common_projects_json),
      notificationPreferences: mergeNotificationPreferences(user.role, parseNotificationPreferences(row.notification_preferences_json)),
      updatedAt: row.updated_at
    };
  }

  upsertForUser(user: Pick<User, "id" | "role">, input: UserPreferenceInput): UserPreferenceProfile {
    const current = this.getForUser(user);
    const commonProjects =
      input.commonProjects === undefined ? current.commonProjects : cleanCommonProjects(input.commonProjects);
    const notificationPreferences = mergeNotificationPreferences(user.role, {
      email: {
        ...current.notificationPreferences.email,
        ...(input.notificationPreferences?.email ?? {})
      }
    });
    const updatedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO user_preferences (
          user_id, common_projects_json, notification_preferences_json, updated_at
        ) VALUES (
          @userId, @commonProjectsJson, @notificationPreferencesJson, @updatedAt
        )
        ON CONFLICT(user_id) DO UPDATE SET
          common_projects_json = excluded.common_projects_json,
          notification_preferences_json = excluded.notification_preferences_json,
          updated_at = excluded.updated_at`
      )
      .run({
        userId: user.id,
        commonProjectsJson: JSON.stringify(commonProjects),
        notificationPreferencesJson: JSON.stringify(notificationPreferences),
        updatedAt
      });

    return this.getForUser(user);
  }
}

export function defaultNotificationPreferencesForRole(role: string): NotificationPreferences {
  const email = allDisabledPreferences();

  if (role === "designer") {
    email.approvalRejected = true;
    email.approvalApprovedForPrint = true;
    email.signatureFailed = true;
    email.approvalPrinted = true;
  }

  if (role === "supervisor" || role === "process") {
    email.reviewTaskCreated = true;
    email.peerReviewCompleted = true;
    email.approvalRejected = true;
    email.approvalApprovedForPrint = true;
  }

  if (role === "admin") {
    email.signatureFailed = true;
    email.systemRisk = false;
  }

  return { email };
}

export function cleanCommonProjects(projects: string[]) {
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const project of projects) {
    const name = project.trim().slice(0, maxCommonProjectLength);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    cleaned.push(name);
    if (cleaned.length >= maxCommonProjects) break;
  }

  return cleaned;
}

export function mergeNotificationPreferences(role: string, input: unknown): NotificationPreferences {
  const defaults = defaultNotificationPreferencesForRole(role);
  if (!input || typeof input !== "object") return defaults;

  const email = (input as { email?: unknown }).email;
  if (!email || typeof email !== "object") return defaults;

  const next = { ...defaults.email };
  for (const key of notificationEventKeys) {
    const value = (email as Partial<Record<NotificationEventKey, unknown>>)[key];
    if (typeof value === "boolean") next[key] = value;
  }
  return { email: next };
}

function allDisabledPreferences() {
  return Object.fromEntries(notificationEventKeys.map((key) => [key, false])) as Record<NotificationEventKey, boolean>;
}

function parseCommonProjects(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? cleanCommonProjects(parsed.filter((item): item is string => typeof item === "string")) : [];
  } catch {
    return [];
  }
}

function parseNotificationPreferences(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
