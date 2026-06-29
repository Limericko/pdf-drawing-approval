import { describe, expect, it } from "vitest";
import { createAuthStore } from "./authStore.ts";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key)
  } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

describe("createAuthStore", () => {
  it("stores and clears tray login session", () => {
    const store = createAuthStore(memoryStorage());

    store.save({
      serverUrl: "http://127.0.0.1:8080",
      username: "supervisor",
      role: "supervisor",
      token: "token-1"
    });

    expect(store.load()).toEqual({
      serverUrl: "http://127.0.0.1:8080",
      username: "supervisor",
      role: "supervisor",
      token: "token-1"
    });

    store.clear();

    expect(store.load()).toBeNull();
  });

  it("stores notified approval ids across restarts", () => {
    const store = createAuthStore(memoryStorage());

    store.saveNotifiedIds([1, 2, 2, 3]);

    expect(store.loadNotifiedIds()).toEqual([1, 2, 3]);

    store.clearNotifiedIds();

    expect(store.loadNotifiedIds()).toEqual([]);
  });
});
