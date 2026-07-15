import {
  completeInvitationRequestSchema,
  createInvitationRequestSchema,
  createInvitationResponseSchema,
  createProjectRequestSchema,
  createProjectResponseSchema,
  invitationCompleteResponseSchema,
  invitationPrepareResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  mfaCompleteRequestSchema,
  mfaCompleteResponseSchema,
  prepareInvitationRequestSchema,
  projectAccessResponseSchema,
  projectIdParamsSchema,
  projectListResponseSchema,
  sessionResponseSchema,
  type CompleteInvitationRequest,
  type CreateInvitationRequest,
  type CreateProjectRequest,
  type LoginRequest,
  type MfaCompleteRequest,
  type PrepareInvitationRequest
} from "../../shared/contracts/identity.ts";
import type { z } from "zod";
import { PlatformRequestAbortError, PlatformRequestError, platformRequest,
  type PlatformRequestOptions } from "./platformRequest.ts";

type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type PlatformSessionContext = Omit<SessionResponse, "csrfToken">;

let csrfToken: string | undefined;
let csrfEpoch = 0;

export async function login(input: LoginRequest, signal?: AbortSignal) {
  clearCsrf();
  return request("/api/v2/auth/login", {
    method: "POST",
    json: parseInput(loginRequestSchema, input),
    responseSchema: loginResponseSchema,
    signal
  });
}

export async function completeMfa(input: MfaCompleteRequest, signal?: AbortSignal): Promise<PlatformSessionContext> {
  clearCsrf();
  await request("/api/v2/auth/mfa/complete", {
    method: "POST",
    json: parseInput(mfaCompleteRequestSchema, input),
    responseSchema: mfaCompleteResponseSchema,
    signal
  });
  return getSession(signal);
}

export async function getSession(signal?: AbortSignal): Promise<PlatformSessionContext> {
  clearCsrf();
  const session = await request("/api/v2/session", { responseSchema: sessionResponseSchema, signal });
  if (signal?.aborted) throw new PlatformRequestAbortError();
  storeCsrf(session.csrfToken);
  return publicSession(session);
}

export const refreshSession = getSession;

export async function logout(signal?: AbortSignal) {
  const ownedCsrf = requireCsrf();
  const ownedEpoch = csrfEpoch;
  await request("/api/v2/session", { method: "DELETE", json: {}, csrfToken: ownedCsrf, signal }, ownedEpoch);
  clearCsrfIfUnchanged(ownedEpoch);
}

export function prepareInvitation(input: PrepareInvitationRequest, signal?: AbortSignal) {
  return request("/api/v2/invitations/prepare", {
    method: "POST",
    json: parseInput(prepareInvitationRequestSchema, input),
    responseSchema: invitationPrepareResponseSchema,
    signal
  });
}

export function completeInvitation(input: CompleteInvitationRequest, signal?: AbortSignal) {
  return request("/api/v2/invitations/complete", {
    method: "POST",
    json: parseInput(completeInvitationRequestSchema, input),
    responseSchema: invitationCompleteResponseSchema,
    signal
  });
}

export async function createInvitation(input: CreateInvitationRequest, signal?: AbortSignal) {
  return request("/api/v2/invitations", {
    method: "POST",
    json: parseInput(createInvitationRequestSchema, input),
    csrfToken: requireCsrf(),
    responseSchema: createInvitationResponseSchema,
    signal
  });
}

export async function createProject(input: CreateProjectRequest, signal?: AbortSignal) {
  return request("/api/v2/projects", {
    method: "POST",
    json: parseInput(createProjectRequestSchema, input),
    csrfToken: requireCsrf(),
    responseSchema: createProjectResponseSchema,
    signal
  });
}

export function listProjects(signal?: AbortSignal) {
  return request("/api/v2/projects", { responseSchema: projectListResponseSchema, signal });
}

export function getProjectAccess(projectId: string, signal?: AbortSignal) {
  const parsed = parseInput(projectIdParamsSchema, { projectId });
  return request(`/api/v2/projects/${parsed.projectId}/access`, { responseSchema: projectAccessResponseSchema, signal });
}

export function platformSessionRequest<T>(
  target: string,
  options: Omit<PlatformRequestOptions<T>, "csrfToken"> = {}
) {
  const mutating = options.method !== undefined && options.method !== "GET";
  return request(target, {
    ...options,
    ...(mutating ? { csrfToken: requireCsrf() } : {})
  });
}

export function disposeIdentityClient() {
  clearCsrf();
}

async function request<T>(target: string, options: Parameters<typeof platformRequest<T>>[1],
  ownedCsrfEpoch = csrfEpoch) {
  try {
    return await platformRequest(target, options);
  } catch (error) {
    if (error instanceof PlatformRequestError && error.status === 401) clearCsrfIfUnchanged(ownedCsrfEpoch);
    throw error;
  }
}

function parseInput<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PlatformRequestError(0, "REQUEST_INPUT_INVALID", "", "Invalid request input");
  return parsed.data;
}

function requireCsrf() {
  if (!csrfToken) throw new PlatformRequestError(0, "CSRF_UNAVAILABLE", "", "Session refresh required");
  return csrfToken;
}

function clearCsrf() {
  csrfToken = undefined;
  csrfEpoch += 1;
}

function storeCsrf(value: string) {
  csrfToken = value;
  csrfEpoch += 1;
}

function clearCsrfIfUnchanged(epoch: number) {
  if (csrfEpoch === epoch) clearCsrf();
}

function publicSession(session: SessionResponse): PlatformSessionContext {
  return { user: session.user, globalCapabilities: session.globalCapabilities, projects: session.projects };
}
