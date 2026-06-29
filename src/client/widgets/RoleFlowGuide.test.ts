import { describe, expect, it } from "vitest";
import { readRoleGuideCollapsed, roleGuideStorageKey, writeRoleGuideCollapsed } from "./RoleFlowGuide.tsx";

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const state = new Map(Object.entries(seed));
  return {
    get length() {
      return state.size;
    },
    clear: () => state.clear(),
    getItem: (key) => state.get(key) ?? null,
    key: (index) => Array.from(state.keys())[index] ?? null,
    removeItem: (key) => state.delete(key),
    setItem: (key, value) => {
      state.set(key, value);
    }
  };
}

describe("RoleFlowGuide storage helpers", () => {
  it("stores collapsed state per user role", () => {
    const storage = memoryStorage();

    writeRoleGuideCollapsed(storage, "designer", true);

    expect(roleGuideStorageKey("designer")).toBe("pdf_approval_role_guide_collapsed_designer");
    expect(readRoleGuideCollapsed(storage, "designer")).toBe(true);
    expect(readRoleGuideCollapsed(storage, "admin")).toBe(false);
  });

  it("can expand a previously collapsed guide", () => {
    const storage = memoryStorage({ pdf_approval_role_guide_collapsed_admin: "1" });

    writeRoleGuideCollapsed(storage, "admin", false);

    expect(readRoleGuideCollapsed(storage, "admin")).toBe(false);
  });
});
