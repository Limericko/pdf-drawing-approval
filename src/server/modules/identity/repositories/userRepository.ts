import type { PlatformRole, PlatformUser, UserStatus } from "../models.ts";

export type CreateUserInput = {
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly platformRole: PlatformRole;
  readonly status: UserStatus;
};

export interface UserRepository {
  create(input: CreateUserInput): Promise<PlatformUser>;
  findByEmail(email: string): Promise<PlatformUser | undefined>;
}
