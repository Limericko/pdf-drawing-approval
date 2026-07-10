import path from "node:path";

export const e2eRoot = path.resolve(".cache", "e2e", "runtime");
export const e2ePort = 18080;

export const e2eUsers = {
  admin: { username: "admin", password: "admin123", landingPath: "/settings" },
  supervisor: { username: "supervisor", password: "123456", landingPath: "/" },
  process: { username: "process", password: "123456", landingPath: "/" },
  designer: { username: "designer_e2e", password: "designer123", landingPath: "/submit" }
} as const;
