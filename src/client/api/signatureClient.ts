import { signatureAssetResponseSchema, setSignatureAssetRequestSchema,
  type SetSignatureAssetRequest } from "../../shared/contracts/business.ts";
import { platformSessionRequest } from "./identityClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";
import { uploadPlatformObject } from "./storageClient.ts";

export function getMySignature(signal?: AbortSignal) {
  return platformSessionRequest("/api/v2/signature", {
    responseSchema: signatureAssetResponseSchema.nullable(), signal
  });
}

export function setMySignature(input: SetSignatureAssetRequest, signal?: AbortSignal) {
  const parsed = setSignatureAssetRequestSchema.safeParse(input);
  if (!parsed.success) throw new PlatformRequestError(0, "REQUEST_INPUT_INVALID", "", "Invalid request input");
  return platformSessionRequest("/api/v2/signature", { method: "PUT", json: parsed.data,
    responseSchema: signatureAssetResponseSchema, signal });
}

export async function uploadMySignature(file: Blob, idempotencyKey: string, signal?: AbortSignal) {
  if (!(file instanceof Blob) || file.type !== "image/png") {
    throw new PlatformRequestError(0, "REQUEST_INPUT_INVALID", "", "Invalid signature image");
  }
  const object = await uploadPlatformObject(file, signal);
  return setMySignature({ objectId: object.id, idempotencyKey }, signal);
}
