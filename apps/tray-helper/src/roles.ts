import type { UserRole } from "./types.ts";

export type MenuMode = "admin" | "designer" | "reviewer";

export function menuModeForRole(role: UserRole): MenuMode {
  if (role === "admin") return "admin";
  if (role === "designer") return "designer";
  return "reviewer";
}
