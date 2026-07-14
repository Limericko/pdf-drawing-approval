import type { PlatformPool } from "../../platform/database/pool.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { globalCapabilitiesFor, projectCapabilitiesFor } from "./capabilities.ts";
import type { PlatformUser } from "./models.ts";
import type { ProjectAccessRecord } from "./repositories/projectRepository.ts";
import { PostgresAuditRepository } from "./repositories/postgres/PostgresAuditRepository.ts";
import { PostgresProjectRepository } from "./repositories/postgres/PostgresProjectRepository.ts";
import { PostgresUserRepository } from "./repositories/postgres/PostgresUserRepository.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class AuthorizationServiceError extends Error {
  constructor(readonly code: "AUTHORIZATION_INPUT_INVALID" | "AUTHORIZATION_FORBIDDEN" |
    "PROJECT_NOT_FOUND" | "AUTHORIZATION_DEPENDENCY_UNAVAILABLE", options?: ErrorOptions) {
    super(code, options);
    this.name = "AuthorizationServiceError";
  }
}

export function createAuthorizationService(options: { readonly pool: PlatformPool }) {
  if (!options?.pool) throw inputInvalid();
  return Object.freeze({
    async getSessionContext(input: { readonly userId: string }) {
      const userId = ownId(input?.userId);
      try {
        const user = await new PostgresUserRepository(options.pool).findById(userId);
        if (!user || user.status !== "active") throw forbidden();
        const access = await new PostgresProjectRepository(options.pool).listForMember(userId);
        return Object.freeze({ user: publicUser(user), globalCapabilities: globalCapabilitiesFor(user),
          projects: access.map(projectSummary) });
      } catch (error) {
        if (error instanceof AuthorizationServiceError) throw error;
        throw dependencyUnavailable(error);
      }
    },

    async listProjects(input: { readonly userId: string }) {
      const context = await this.getSessionContext(input);
      return Object.freeze({ projects: context.projects });
    },

    async getProjectAccess(input: { readonly projectId: string; readonly userId: string }) {
      const projectId = ownId(input?.projectId);
      const userId = ownId(input?.userId);
      try {
        const access = await new PostgresProjectRepository(options.pool).findAccessByIdForMember(projectId, userId);
        if (!access) throw notFound();
        const members = await new PostgresProjectRepository(options.pool).listMembers(projectId);
        return Object.freeze({ ...projectAccess(access), members });
      } catch (error) {
        if (error instanceof AuthorizationServiceError) throw error;
        throw dependencyUnavailable(error);
      }
    },

    async createProject(input: { readonly name: string; readonly actorUserId: string; readonly requestId: string }) {
      const name = ownProjectName(input?.name);
      const actorUserId = ownId(input?.actorUserId);
      const requestId = ownRequestId(input?.requestId);
      try {
        return await withTransaction(options.pool, async (transaction) => {
          const actor = await new PostgresUserRepository(transaction).lockById(actorUserId);
          if (!actor || actor.status !== "active" || actor.platformRole !== "admin") throw forbidden();
          const created = await new PostgresProjectRepository(transaction).create({ name, status: "active",
            createdByUserId: actorUserId });
          await new PostgresAuditRepository(transaction).append({
            actorUserId, actorType: "user", action: "project.create", targetType: "project",
            targetId: created.project.id, requestId, result: "success", metadata: { projectId: created.project.id }
          });
          return Object.freeze({ project: created.project, membership: created.creatorMembership,
            capabilities: projectCapabilitiesFor(created.creatorMembership) });
        });
      } catch (error) {
        if (error instanceof AuthorizationServiceError) throw error;
        throw dependencyUnavailable(error);
      }
    }
  });
}

function projectSummary(access: ProjectAccessRecord) {
  return Object.freeze({ id: access.project.id, name: access.project.name, status: access.project.status,
    role: access.membership.role, capabilities: projectCapabilitiesFor(access.membership) });
}

function projectAccess(access: ProjectAccessRecord) {
  return { project: access.project, membership: access.membership,
    capabilities: projectCapabilitiesFor(access.membership) };
}

function publicUser(user: PlatformUser) {
  const { passwordHash: _passwordHash, ...safe } = user;
  return Object.freeze({ ...safe, mfaEnabledAt: user.mfaEnabledAt ? new Date(user.mfaEnabledAt) : null,
    createdAt: new Date(user.createdAt), updatedAt: new Date(user.updatedAt) });
}

function ownId(value: unknown) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw inputInvalid();
  return value;
}

function ownProjectName(value: unknown) {
  if (typeof value !== "string") throw inputInvalid();
  const name = value.trim();
  if (!name || Buffer.byteLength(name) > 160 || /[\r\n\0]/.test(name)) throw inputInvalid();
  return name;
}

function ownRequestId(value: unknown) {
  if (typeof value !== "string" || value !== value.trim() || !value ||
      Buffer.byteLength(value) > 128 || /[\r\n\0]/.test(value)) throw inputInvalid();
  return value;
}

function inputInvalid() { return new AuthorizationServiceError("AUTHORIZATION_INPUT_INVALID"); }
function forbidden() { return new AuthorizationServiceError("AUTHORIZATION_FORBIDDEN"); }
function notFound() { return new AuthorizationServiceError("PROJECT_NOT_FOUND"); }
function dependencyUnavailable(cause?: unknown) {
  return new AuthorizationServiceError("AUTHORIZATION_DEPENDENCY_UNAVAILABLE", { cause });
}
