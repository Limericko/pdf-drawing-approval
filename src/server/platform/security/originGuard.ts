import type { RequestHandler } from "express";
import { HttpProblem } from "../http/problemResponse.ts";

export function createOriginGuard(options: { readonly publicBaseUrl: string; readonly contentTypes?: readonly string[] }): RequestHandler {
  const trustedOrigin = trustedPublicOrigin(options?.publicBaseUrl);
  const customContentTypes = options.contentTypes !== undefined;
  const allowedContentTypes = options.contentTypes ?? ["application/json"];
  if (!Array.isArray(allowedContentTypes) || allowedContentTypes.length === 0 ||
      allowedContentTypes.some((value) => typeof value !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value))) {
    throw new Error("ORIGIN_GUARD_CONTENT_TYPES_INVALID");
  }
  return (request, _response, next) => {
    const contentType = request.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!allowedContentTypes.includes(contentType)) {
      next(new HttpProblem(415, customContentTypes ? "CONTENT_TYPE_REQUIRED" : "JSON_CONTENT_TYPE_REQUIRED",
        customContentTypes ? "Supported content type required" : "JSON content type required"));
      return;
    }
    const origin = request.get("origin");
    if (!origin) {
      next(new HttpProblem(403, "ORIGIN_REQUIRED", "Origin required"));
      return;
    }
    if (origin !== trustedOrigin) {
      next(new HttpProblem(403, "ORIGIN_FORBIDDEN", "Forbidden"));
      return;
    }
    if (request.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
      next(new HttpProblem(403, "CROSS_SITE_REQUEST_FORBIDDEN", "Cross-site request forbidden"));
      return;
    }
    next();
  };
}

function trustedPublicOrigin(value: unknown) {
  if (typeof value !== "string") throw new Error("PUBLIC_BASE_URL_INVALID");
  try {
    return new URL(value).origin;
  } catch {
    throw new Error("PUBLIC_BASE_URL_INVALID");
  }
}
