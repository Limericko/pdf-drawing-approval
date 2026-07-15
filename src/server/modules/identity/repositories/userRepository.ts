import type { PlatformRole, PlatformUser, UserStatus } from "../models.ts";

export type CreateUserInput = {
  readonly username?: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly platformRole: PlatformRole;
  readonly status: UserStatus;
  readonly mfaEnabledAt?: Date;
  readonly passwordChangeRequired?: boolean;
};

export interface UserRepository {
  create(input: CreateUserInput): Promise<PlatformUser>;
  findByEmail(email: string): Promise<PlatformUser | undefined>;
  findByUsername(username: string): Promise<PlatformUser | undefined>;
  findById(id: string): Promise<PlatformUser | undefined>;
  lockById(id: string): Promise<PlatformUser | undefined>;
  lockByIds(ids: readonly string[]): Promise<readonly PlatformUser[]>;
  updatePasswordHash(id: string, passwordHash: string): Promise<PlatformUser | undefined>;
  updateAccount(input: { id: string; username: string; email: string; passwordHash: string;
    passwordChangeRequired: boolean }): Promise<PlatformUser | undefined>;
  disable(id: string): Promise<PlatformUser | undefined>;
}
