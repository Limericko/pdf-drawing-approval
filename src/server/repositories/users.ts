import bcrypt from "bcryptjs";
import type { DatabaseConnection } from "../db.ts";

export const activeUserRoles = ["designer", "supervisor", "process", "admin"] as const;
export type UserRole = (typeof activeUserRoles)[number];

const activeRoleSql = "'designer', 'supervisor', 'process', 'admin'";

export type User = {
  id: number;
  username: string;
  role: string;
  email: string | null;
  displayName: string;
  active: boolean;
};

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  email: string | null;
  display_name: string;
  active: number;
};

export class UserRepository {
  constructor(private readonly db: DatabaseConnection) {}

  list(): User[] {
    const rows = this.db.prepare(`SELECT * FROM users WHERE role IN (${activeRoleSql}) ORDER BY active DESC, role, username`).all() as UserRow[];
    return rows.map(mapUser);
  }

  create(input: { username: string; password: string; role: UserRole; email?: string | null; displayName: string }): User {
    const passwordHash = bcrypt.hashSync(input.password, 10);
    const result = this.db
      .prepare(
        `INSERT INTO users (username, password_hash, role, email, display_name)
         VALUES (@username, @passwordHash, @role, @email, @displayName)`
      )
      .run({
        username: input.username,
        passwordHash,
        role: input.role,
        email: input.email ?? null,
        displayName: input.displayName
      });
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ? AND role IN (${activeRoleSql})`).get(id) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  findByUsername(username: string): (User & { passwordHash: string }) | null {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE username = ? AND active = 1 AND role IN (${activeRoleSql})`)
      .get(username) as UserRow | undefined;
    return row ? { ...mapUser(row), passwordHash: row.password_hash } : null;
  }

  findByRole(role: UserRole): User[] {
    const rows = this.db.prepare("SELECT * FROM users WHERE role = ? AND active = 1").all(role) as UserRow[];
    return rows.map(mapUser);
  }

  update(
    id: number,
    input: { role: UserRole; email?: string | null; displayName: string; active: boolean }
  ): User {
    const current = this.getById(id);
    if (!current) throw new Error("USER_NOT_FOUND");
    if (current.role === "admin" && (input.role !== "admin" || !input.active) && this.activeAdminCount() <= 1) {
      throw new Error("LAST_ADMIN_REQUIRED");
    }

    this.db
      .prepare(
        `UPDATE users
         SET role = @role, email = @email, display_name = @displayName, active = @active
         WHERE id = @id`
      )
      .run({
        id,
        role: input.role,
        email: input.email ?? null,
        displayName: input.displayName,
        active: input.active ? 1 : 0
      });
    return this.getById(id)!;
  }

  updateProfile(id: number, input: { displayName: string; email?: string | null }): User {
    const current = this.getById(id);
    if (!current) throw new Error("USER_NOT_FOUND");

    this.db
      .prepare(
        `UPDATE users
         SET email = @email, display_name = @displayName
         WHERE id = @id`
      )
      .run({
        id,
        email: input.email ?? null,
        displayName: input.displayName
      });
    return this.getById(id)!;
  }

  resetPassword(id: number, password: string): User {
    const current = this.getById(id);
    if (!current) throw new Error("USER_NOT_FOUND");
    const passwordHash = bcrypt.hashSync(password, 10);
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
    return this.getById(id)!;
  }

  private activeAdminCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get() as { count: number };
    return row.count;
  }

  ensureDefaultUsers() {
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    if (count.count > 0) return;

    this.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    this.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
    this.create({ username: "process", password: "123456", role: "process", displayName: "工艺" });
  }
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role as UserRole,
    email: row.email,
    displayName: row.display_name,
    active: row.active === 1
  };
}
