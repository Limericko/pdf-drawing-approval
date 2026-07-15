import { uploadedObjectResponseSchema } from "../../shared/contracts/business.ts";
import { platformSessionRequest } from "./identityClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";

export function uploadPlatformObject(file: Blob, signal?: AbortSignal) {
  if (!(file instanceof Blob) || !["application/pdf", "image/png"].includes(file.type) || file.size === 0) {
    throw new PlatformRequestError(0, "REQUEST_INPUT_INVALID", "", "Invalid upload");
  }
  return platformSessionRequest("/api/v2/storage/objects", {
    method: "POST",
    body: file,
    contentType: file.type,
    responseSchema: uploadedObjectResponseSchema,
    signal
  });
}
