import type { PlatformRole, PlatformUser, UserStatus } from "../models.ts";

export type CreateUserInput = {
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly platformRole: PlatformRole;
  readonly status: UserStatus;
  readonly mfaEnabledAt?: Date;
};

export interface UserRepository {
  create(input: CreateUserInput): Promise<PlatformUser>;
  findByEmail(email: string): Promise<PlatformUser | undefined>;
  findById(id: string): Promise<PlatformUser | undefined>;
  lockById(id: string): Promise<PlatformUser | undefined>;
  updatePasswordHash(id: string, passwordHash: string): Promise<PlatformUser | undefined>;
  disable(id: string): Promise<PlatformUser | undefined>;
}
