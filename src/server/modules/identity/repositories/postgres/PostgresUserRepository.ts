import type { QueryResultRow } from "pg";
import { normalizeEmail } from "../../email.ts";
import { createIdentityId } from "../../ids.ts";
import type { MfaStatus, PlatformRole, PlatformUser, UserStatus } from "../../models.ts";
import type { QueryExecutor } from "../../../../platform/database/queryExecutor.ts";
import type { CreateUserInput, UserRepository } from "../userRepository.ts";

type UserRow = QueryResultRow & {
  id: string;
  email_normalized: string;
  display_name: string;
  password_hash: string;
  platform_role: PlatformRole;
  status: UserStatus;
  mfa_status: MfaStatus;
  mfa_enabled_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const USER_COLUMNS = `id, email_normalized, display_name, password_hash, platform_role, status,
  mfa_status, mfa_enabled_at, created_at, updated_at`;

function mapUser(row: UserRow): PlatformUser {
  return {
    id: row.id,
    emailNormalized: row.email_normalized,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    platformRole: row.platform_role,
    status: row.status,
    mfaStatus: row.mfa_status,
    mfaEnabledAt: row.mfa_enabled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async create(input: CreateUserInput) {
    const result = await this.executor.query<UserRow>(
      `INSERT INTO platform.users
        (id, email_normalized, display_name, password_hash, platform_role, status, mfa_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'disabled')
       RETURNING ${USER_COLUMNS}`,
      [
        createIdentityId(),
        normalizeEmail(input.email),
        input.displayName,
        input.passwordHash,
        input.platformRole,
        input.status
      ]
    );
    return mapUser(result.rows[0]!);
  }

  async findByEmail(email: string) {
    const result = await this.executor.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM platform.users WHERE email_normalized = $1`,
      [normalizeEmail(email)]
    );
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }
}
