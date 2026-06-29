import type { UserRole } from "./types.ts";

export type TraySession = {
  serverUrl: string;
  username: string;
  role: UserRole;
  token: string;
};

const sessionKey = "pdf_approval_tray_session";
const notifiedIdsKey = "pdf_approval_tray_notified_ids";

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function createAuthStore(storage: StorageLike = localStorage) {
  return {
    load(): TraySession | null {
      const value = storage.getItem(sessionKey);
      if (!value) return null;

      try {
        const parsed = JSON.parse(value) as Partial<TraySession>;
        if (!parsed.serverUrl || !parsed.username || !parsed.token || !isUserRole(parsed.role)) {
          return null;
        }
        return {
          serverUrl: parsed.serverUrl,
          username: parsed.username,
          role: parsed.role,
          token: parsed.token
        };
      } catch {
        return null;
      }
    },

    save(session: TraySession) {
      storage.setItem(sessionKey, JSON.stringify(session));
    },

    clear() {
      storage.removeItem(sessionKey);
    },

    loadNotifiedIds(): number[] {
      const value = storage.getItem(notifiedIdsKey);
      if (!value) return [];

      try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) return [];
        return uniqueNumbers(parsed);
      } catch {
        return [];
      }
    },

    saveNotifiedIds(ids: number[]) {
      storage.setItem(notifiedIdsKey, JSON.stringify(uniqueNumbers(ids)));
    },

    clearNotifiedIds() {
      storage.removeItem(notifiedIdsKey);
    }
  };
}

function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "designer" || value === "supervisor" || value === "process";
}

function uniqueNumbers(values: unknown[]) {
  return Array.from(new Set(values.filter((value): value is number => Number.isInteger(value))));
}
