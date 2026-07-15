import type { WebDavCredential } from "../../platform/config/types.ts";

const MAX_PROPFIND_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_ITEMS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

export type WebDavRemoteEntry = {
  path: string;
  etag: string | null;
  sizeBytes: number | null;
  modifiedAt: Date | null;
  collection: boolean;
};

export class WebDavClientError extends Error {
  constructor(
    readonly kind: "transient" | "permanent",
    readonly code: "WEBDAV_ENDPOINT_INVALID" | "WEBDAV_PATH_INVALID" | "WEBDAV_REDIRECT_REJECTED" |
      "WEBDAV_AUTH_FAILED" | "WEBDAV_NOT_FOUND" | "WEBDAV_REMOTE_CONFLICT" |
      "WEBDAV_REMOTE_UNAVAILABLE" | "WEBDAV_PROTOCOL_INVALID" | "WEBDAV_RESPONSE_TOO_LARGE" |
      "WEBDAV_RANGE_NOT_HONORED" | "WEBDAV_REQUEST_ABORTED",
    readonly status: number | null = null
  ) {
    super(code);
    this.name = "WebDavClientError";
  }
}

export function createWebDavClient(options: {
  readonly endpointUrl: string;
  readonly credential: WebDavCredential;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly validateTarget?: (url: URL) => Promise<void>;
}) {
  const base = ownEndpoint(options?.endpointUrl);
  const credential = ownCredential(options?.credential);
  const fetchImpl = options.fetch ?? fetch;
  if (typeof fetchImpl !== "function") throw invalid("WEBDAV_ENDPOINT_INVALID");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw invalid("WEBDAV_ENDPOINT_INVALID");
  const authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`;

  async function request(method: string, path: string, init: RequestInit, accepted: readonly number[]) {
    let target = remoteUrl(base, path);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      let response: Response;
      try {
        await options.validateTarget?.(target);
        response = await timedFetch(fetchImpl, target, {
          ...init,
          method,
          redirect: "manual",
          headers: { Authorization: authorization, ...Object.fromEntries(new Headers(init.headers)) }
        }, timeoutMs, options.signal);
      } catch (error) {
        if (error instanceof WebDavClientError) throw error;
        throw new WebDavClientError("transient", "WEBDAV_REMOTE_UNAVAILABLE");
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("Location");
        if (!location || redirects === 3) throw invalid("WEBDAV_REDIRECT_REJECTED", response.status);
        let redirected: URL;
        try { redirected = new URL(location, target); } catch { throw invalid("WEBDAV_REDIRECT_REJECTED", response.status); }
        if (redirected.origin !== base.origin || !redirected.pathname.startsWith(base.pathname) ||
            redirected.username || redirected.password || redirected.search || redirected.hash) {
          throw invalid("WEBDAV_REDIRECT_REJECTED", response.status);
        }
        target = redirected;
        continue;
      }
      if (!accepted.includes(response.status)) throw statusError(response.status);
      return response;
    }
    throw invalid("WEBDAV_REDIRECT_REJECTED");
  }

  return Object.freeze({
    async probe() {
      const response = await request("OPTIONS", "/.__pdf_approval_probe__", {}, [200, 204, 404]);
      const dav = response.headers.get("DAV") ?? "";
      const allow = response.headers.get("Allow") ?? "";
      const ranges = response.headers.get("Accept-Ranges") ?? "";
      return {
        class1: dav.split(",").map((value) => value.trim()).includes("1"),
        move: allow.split(",").some((value) => value.trim().toUpperCase() === "MOVE"),
        rangeDownload: ranges.toLowerCase().split(",").map((value) => value.trim()).includes("bytes")
      };
    },

    async list(path: string): Promise<WebDavRemoteEntry[]> {
      const ownedPath = ownPath(path);
      const response = await request("PROPFIND", ownedPath, {
        headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
        body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop>` +
          `<d:resourcetype/><d:getetag/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`
      }, [207]);
      const xml = await readBoundedText(response, MAX_PROPFIND_BYTES);
      const entries = parseMultiStatus(xml, base);
      if (entries.length > MAX_DIRECTORY_ITEMS) throw invalid("WEBDAV_RESPONSE_TOO_LARGE");
      return entries.filter((entry) => entry.path !== ownedPath && !entry.collection);
    },

    async head(path: string) {
      const response = await request("HEAD", ownPath(path), {}, [200, 204, 404]);
      if (response.status === 404) return null;
      return metadata(response.headers);
    },

    async download(path: string, input: { readonly rangeStart?: number } = {}) {
      const rangeStart = input.rangeStart ?? 0;
      if (!Number.isSafeInteger(rangeStart) || rangeStart < 0) throw invalid("WEBDAV_PATH_INVALID");
      const response = await request("GET", ownPath(path), {
        headers: rangeStart > 0 ? { Range: `bytes=${rangeStart}-` } : {}
      }, rangeStart > 0 ? [200, 206] : [200, 206]);
      if (rangeStart > 0 && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined);
        throw new WebDavClientError("transient", "WEBDAV_RANGE_NOT_HONORED", response.status);
      }
      const contentRange = response.headers.get("Content-Range");
      const parsedRange = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (rangeStart > 0 && (!parsedRange || Number(parsedRange[1]) !== rangeStart)) {
        await response.body?.cancel().catch(() => undefined);
        throw new WebDavClientError("transient", "WEBDAV_RANGE_NOT_HONORED", response.status);
      }
      return {
        status: response.status,
        body: response.body,
        etag: response.headers.get("ETag"),
        contentLength: nonnegativeHeader(response.headers.get("Content-Length")),
        totalSizeBytes: parsedRange ? Number(parsedRange[3]) : nonnegativeHeader(response.headers.get("Content-Length"))
      };
    },

    async put(path: string, body: BodyInit, input: { readonly contentType?: string } = {}) {
      const response = await request("PUT", ownPath(path), {
        body,
        headers: { "Content-Type": input.contentType ?? "application/pdf", "If-None-Match": "*" },
        ...(typeof ReadableStream !== "undefined" && body instanceof ReadableStream ? { duplex: "half" } as RequestInit : {})
      }, [200, 201, 204]);
      return { etag: response.headers.get("ETag") };
    },

    async move(sourcePath: string, destinationPath: string) {
      const destination = remoteUrl(base, ownPath(destinationPath));
      const response = await request("MOVE", ownPath(sourcePath), {
        headers: { Destination: destination.href, Overwrite: "F" }
      }, [200, 201, 204]);
      return { etag: response.headers.get("ETag") };
    },

    async removeTemporary(path: string) {
      const response = await request("DELETE", ownPath(path), {}, [200, 204, 404]);
      return { removed: response.status !== 404 };
    }
  });
}

function ownEndpoint(value: unknown) {
  if (typeof value !== "string" || value !== value.trim() || value.length > 2048) throw invalid("WEBDAV_ENDPOINT_INVALID");
  let url: URL;
  try { url = new URL(value); } catch { throw invalid("WEBDAV_ENDPOINT_INVALID"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw invalid("WEBDAV_ENDPOINT_INVALID");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function ownCredential(value: unknown): WebDavCredential {
  if (!value || typeof value !== "object" || typeof (value as WebDavCredential).username !== "string" ||
      typeof (value as WebDavCredential).password !== "string") throw invalid("WEBDAV_ENDPOINT_INVALID");
  const { username, password } = value as WebDavCredential;
  if (!username || username !== username.trim() || username.length > 254 || username.includes(":") ||
      !password || password !== password.trim() || password.length > 1024 || /[\u0000-\u001f\u007f]/.test(`${username}${password}`)) {
    throw invalid("WEBDAV_ENDPOINT_INVALID");
  }
  return { username, password };
}

function ownPath(value: unknown) {
  if (typeof value !== "string" || value !== value.trim() || value.length < 2 || value.length > 1024 ||
      !value.startsWith("/") || value === "/" || value.endsWith("/") || value.includes("\\") || value.includes("//") ||
      /[\u0000-\u001f\u007f]/.test(value) || value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw invalid("WEBDAV_PATH_INVALID");
  }
  return value.normalize("NFC");
}

function remoteUrl(base: URL, path: string) {
  const owned = ownPath(path);
  const encoded = owned.slice(1).split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return new URL(encoded, base);
}

async function timedFetch(fetchImpl: typeof fetch, target: URL, init: RequestInit, timeoutMs: number,
  outerSignal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (outerSignal?.aborted) controller.abort();
  else outerSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await fetchImpl(target, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new WebDavClientError("transient", "WEBDAV_REQUEST_ABORTED");
    throw error;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", abort);
  }
}

function statusError(status: number) {
  if (status === 401 || status === 403) return new WebDavClientError("permanent", "WEBDAV_AUTH_FAILED", status);
  if (status === 404) return new WebDavClientError("permanent", "WEBDAV_NOT_FOUND", status);
  if (status === 409 || status === 412) return new WebDavClientError("permanent", "WEBDAV_REMOTE_CONFLICT", status);
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new WebDavClientError("transient", "WEBDAV_REMOTE_UNAVAILABLE", status);
  }
  return new WebDavClientError("permanent", "WEBDAV_PROTOCOL_INVALID", status);
}

function parseMultiStatus(xml: string, base: URL): WebDavRemoteEntry[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalid("WEBDAV_PROTOCOL_INVALID");
  const responses = xml.match(/<(?:[A-Za-z_][\w.-]*:)?response\b[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?response>/gi) ?? [];
  const result: WebDavRemoteEntry[] = [];
  for (const response of responses) {
    const href = tagValue(response, "href");
    if (!href) continue;
    const path = remotePathFromHref(href, base);
    const etag = tagValue(response, "getetag");
    const length = tagValue(response, "getcontentlength");
    const modified = tagValue(response, "getlastmodified");
    const sizeBytes = length === null ? null : nonnegativeHeader(length);
    const modifiedDate = modified === null ? null : new Date(modified);
    if (modifiedDate && !Number.isFinite(modifiedDate.getTime())) throw invalid("WEBDAV_PROTOCOL_INVALID");
    result.push({ path, etag, sizeBytes, modifiedAt: modifiedDate,
      collection: /<(?:[A-Za-z_][\w.-]*:)?collection\b/i.test(response) });
  }
  return result;
}

function tagValue(source: string, localName: string) {
  const match = source.match(new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}>`, "i"));
  return match ? decodeXml(match[1].trim()) : null;
}

function remotePathFromHref(href: string, base: URL) {
  let url: URL;
  try { url = new URL(href, base); } catch { throw invalid("WEBDAV_PROTOCOL_INVALID"); }
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw invalid("WEBDAV_PROTOCOL_INVALID");
  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname.slice(base.pathname.length - 1)).replace(/\/+$/, ""); }
  catch { throw invalid("WEBDAV_PROTOCOL_INVALID"); }
  return ownPath(decoded);
}

function decodeXml(value: string) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function readBoundedText(response: Response, maximum: number) {
  const declared = nonnegativeHeader(response.headers.get("Content-Length"));
  if (declared !== null && declared > maximum) throw invalid("WEBDAV_RESPONSE_TOO_LARGE", response.status);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw invalid("WEBDAV_RESPONSE_TOO_LARGE", response.status);
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

function metadata(headers: Headers) {
  const modified = headers.get("Last-Modified");
  const modifiedAt = modified ? new Date(modified) : null;
  if (modifiedAt && !Number.isFinite(modifiedAt.getTime())) throw invalid("WEBDAV_PROTOCOL_INVALID");
  return { etag: headers.get("ETag"), sizeBytes: nonnegativeHeader(headers.get("Content-Length")), modifiedAt };
}

function nonnegativeHeader(value: string | null) {
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw invalid("WEBDAV_PROTOCOL_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalid("WEBDAV_PROTOCOL_INVALID");
  return parsed;
}

function invalid(code: WebDavClientError["code"], status: number | null = null) {
  return new WebDavClientError("permanent", code, status);
}
