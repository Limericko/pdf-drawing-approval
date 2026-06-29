import { describe, expect, it } from "vitest";
import {
  readSidebarCollapsed,
  passwordResetTokenFromHash,
  requiresServerConnectionSetup,
  routeFromHash,
  shouldBlockForMissingSignature,
  sidebarCollapsedStorageKey,
  signatureSetupRequired,
  writeSidebarCollapsed
} from "./App.tsx";
import type { User } from "./api.ts";

function user(role: User["role"]): User {
  return { id: 1, username: role, role, displayName: role };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    }
  };
}

describe("app hash routing", () => {
  it("keeps query-string risk links on the approvals route", () => {
    expect(routeFromHash("#/approvals?status=file_missing")).toEqual({ name: "approvals" });
    expect(routeFromHash("#/approvals/12?from=risk")).toEqual({ name: "detail", id: 12 });
    expect(routeFromHash("#/profile")).toEqual({ name: "profile" });
  });

  it("reads password reset tokens from email links without treating them as app routes", () => {
    expect(passwordResetTokenFromHash("#/reset-password?token=abc123")).toBe("abc123");
    expect(passwordResetTokenFromHash("#/reset-password?token=abc%20123")).toBe("abc 123");
    expect(passwordResetTokenFromHash("#/approvals?token=abc123")).toBeNull();
    expect(routeFromHash("#/reset-password?token=abc123")).toEqual({ name: "tasks" });
  });
});

describe("desktop server connection gating", () => {
  it("requires connection setup only for desktop clients without a server base URL", () => {
    expect(requiresServerConnectionSetup({ desktopClient: true, configLoaded: true, serverBaseUrl: null })).toBe(true);
    expect(requiresServerConnectionSetup({ desktopClient: true, configLoaded: true, serverBaseUrl: "http://127.0.0.1:8080" })).toBe(false);
    expect(requiresServerConnectionSetup({ desktopClient: false, configLoaded: true, serverBaseUrl: null })).toBe(false);
    expect(requiresServerConnectionSetup({ desktopClient: true, configLoaded: false, serverBaseUrl: null })).toBe(false);
  });
});

describe("signature setup gating", () => {
  it("requires configured signatures for non-admin users before business routes", () => {
    expect(signatureSetupRequired(user("designer"))).toBe(true);
    expect(signatureSetupRequired(user("supervisor"))).toBe(true);
    expect(signatureSetupRequired(user("process"))).toBe(true);
    expect(signatureSetupRequired(user("admin"))).toBe(false);

    expect(shouldBlockForMissingSignature({ user: user("designer"), signatureConfigured: false, routeName: "submit" })).toBe(true);
    expect(shouldBlockForMissingSignature({ user: user("supervisor"), signatureConfigured: false, routeName: "tasks" })).toBe(true);
    expect(shouldBlockForMissingSignature({ user: user("process"), signatureConfigured: false, routeName: "signature" })).toBe(false);
    expect(shouldBlockForMissingSignature({ user: user("designer"), signatureConfigured: false, routeName: "profile" })).toBe(false);
    expect(shouldBlockForMissingSignature({ user: user("designer"), signatureConfigured: true, routeName: "submit" })).toBe(false);
    expect(shouldBlockForMissingSignature({ user: user("designer"), signatureConfigured: null, routeName: "submit" })).toBe(false);
    expect(shouldBlockForMissingSignature({ user: user("admin"), signatureConfigured: false, routeName: "settings" })).toBe(false);
  });
});

describe("sidebar collapse persistence", () => {
  it("stores the collapsed sidebar preference safely", () => {
    const storage = memoryStorage();

    expect(sidebarCollapsedStorageKey).toBe("pdf_approval_sidebar_collapsed");
    expect(readSidebarCollapsed(storage)).toBe(false);
    writeSidebarCollapsed(storage, true);
    expect(readSidebarCollapsed(storage)).toBe(true);
    writeSidebarCollapsed(storage, false);
    expect(readSidebarCollapsed(storage)).toBe(false);
    expect(readSidebarCollapsed(null)).toBe(false);
  });
});
