import type { PlatformRole, ProjectMemberRole, ProjectMemberStatus, UserStatus } from "./models.ts";

export type GlobalCapability = "platform.security.manage" | "projects.create";
export type ProjectCapability = "project.read" | "project.members.manage" | "project.invitations.create" |
  "drawings.submit" | "drawings.review" | "drawings.process";

const ADMIN_CAPABILITIES: readonly GlobalCapability[] = Object.freeze([
  "platform.security.manage", "projects.create"
]);

const PROJECT_CAPABILITIES: Readonly<Record<ProjectMemberRole, readonly ProjectCapability[]>> = Object.freeze({
  manager: ["project.read", "project.members.manage", "project.invitations.create",
    "drawings.submit", "drawings.review", "drawings.process"],
  designer: ["project.read", "drawings.submit"],
  supervisor: ["project.read", "drawings.review"],
  process: ["project.read", "drawings.process"],
  viewer: ["project.read"]
});

export function globalCapabilitiesFor(input: { readonly platformRole: PlatformRole; readonly status: UserStatus }) {
  return input.status === "active" && input.platformRole === "admin" ? [...ADMIN_CAPABILITIES] : [];
}

export function projectCapabilitiesFor(input: {
  readonly role: ProjectMemberRole;
  readonly status: ProjectMemberStatus;
}) {
  return input.status === "active" ? [...PROJECT_CAPABILITIES[input.role]] : [];
}
