import { createHash } from "node:crypto";
import type { DatabaseConnection } from "../db.ts";

export const passwordResetTokenTtlMs = 30 * 60 * 1000;

export type PasswordResetToken = {
  id: number;
  userId: number;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
};

type PasswordResetTokenRow = {
  id: number;
  user_id: number;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
};

export function hashPasswordResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export class PasswordResetTokenRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(input: { userId: number; tokenHash: string; expiresAt: Date }): PasswordResetToken {
    const result = this.db
      .prepare(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES (@userId, @tokenHash, @expiresAt)`
      )
      .run({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt.toISOString()
      });
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): PasswordResetToken | null {
    const row = this.db.prepare("SELECT * FROM password_reset_tokens WHERE id = ?").get(id) as PasswordResetTokenRow | undefined;
    return row ? mapPasswordResetToken(row) : null;
  }

  consumeValid(tokenHash: string, now = new Date()): PasswordResetToken | null {
    const row = this.db
      .prepare(
        `SELECT * FROM password_reset_tokens
         WHERE token_hash = @tokenHash AND used_at IS NULL AND expires_at > @now
         ORDER BY id DESC
         LIMIT 1`
      )
      .get({ tokenHash, now: now.toISOString() }) as PasswordResetTokenRow | undefined;
    if (!row) return null;

    const usedAt = now.toISOString();
    this.db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").run(usedAt, row.id);
    return this.getById(row.id);
  }

  markUsed(id: number, now = new Date()) {
    this.db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now.toISOString(), id);
  }

  listForUser(userId: number): PasswordResetToken[] {
    const rows = this.db
      .prepare("SELECT * FROM password_reset_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC")
      .all(userId) as PasswordResetTokenRow[];
    return rows.map(mapPasswordResetToken);
  }
}

function mapPasswordResetToken(row: PasswordResetTokenRow): PasswordResetToken {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at
  };
}
