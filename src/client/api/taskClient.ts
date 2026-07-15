import { taskListQuerySchema, taskListResponseSchema } from "../../shared/contracts/business.ts";
import { PlatformRequestError } from "./platformRequest.ts";
import { platformSessionRequest } from "./identityClient.ts";

export function listMyTasks(input: { projectId?: string } = {}, signal?: AbortSignal) {
  const parsed = taskListQuerySchema.safeParse(input);
  if (!parsed.success) throw new PlatformRequestError(0, "REQUEST_INPUT_INVALID", "", "Invalid request input");
  const query = parsed.data.projectId ? `?projectId=${encodeURIComponent(parsed.data.projectId)}` : "";
  return platformSessionRequest(`/api/v2/tasks${query}`, { responseSchema: taskListResponseSchema, signal });
}
