import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { createDatabase } from "./db.ts";
import { login } from "./auth.ts";
import { UserRepository } from "./repositories/users.ts";

describe("auth", () => {
  it("logs in valid users and includes role in token", () => {
    const users = new UserRepository(createDatabase(":memory:"));
    users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });

    const result = login(users, "secret", "supervisor", "123456");
    const decoded = jwt.verify(result.token, "secret") as { role: string };

    expect(decoded.role).toBe("supervisor");
    expect(result.user.displayName).toBe("主管");
  });

  it("rejects invalid login", () => {
    const users = new UserRepository(createDatabase(":memory:"));
    users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });

    expect(() => login(users, "secret", "supervisor", "wrong")).toThrow("INVALID_CREDENTIALS");
  });
});
