import type { RequestHandler } from "express";
import { HttpProblem } from "../http/problemResponse.ts";

export function createOriginGuard(options: { readonly publicBaseUrl: string }): RequestHandler {
  const trustedOrigin = trustedPublicOrigin(options?.publicBaseUrl);
  return (request, _response, next) => {
    const contentType = request.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      next(new HttpProblem(415, "JSON_CONTENT_TYPE_REQUIRED", "JSON content type required"));
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
