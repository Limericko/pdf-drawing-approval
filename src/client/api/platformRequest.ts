import type { z } from "zod";
import { problemDetailsSchema, requestIdSchema } from "../../shared/contracts/problem.ts";

const PLATFORM_RESPONSE_BODY_MAX_BYTES = 64 * 1024;
const utf8Encoder = new TextEncoder();

class ResponseBodyTooLargeError {}

export class PlatformRequestError {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly title: string;

  constructor(status: number, code: string, requestId: string, title: string) {
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.title = title;
  }
}

export class PlatformRequestAbortError extends PlatformRequestError {
  constructor() {
    super(0, "REQUEST_ABORTED", "", "Request cancelled");
  }
}

export type PlatformRequestOptions<T> = {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly json?: unknown;
  readonly csrfToken?: string;
  readonly responseSchema?: z.ZodType<T>;
  readonly signal?: AbortSignal;
};

export async function platformRequest<T = undefined>(target: string, options: PlatformRequestOptions<T> = {}): Promise<T> {
  validateTarget(target);
  if (options.signal?.aborted) throw new PlatformRequestAbortError();
  const headers = new Headers({ Accept: "application/json" });
  if (options.json !== undefined) headers.set("Content-Type", "application/json");
  if (options.csrfToken) headers.set("X-CSRF-Token", options.csrfToken);

  let response: Response;
  try {
    response = await fetch(target, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      headers: Object.fromEntries(headers.entries()),
      ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
      ...(options.signal ? { signal: options.signal } : {})
    });
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw new PlatformRequestAbortError();
    throw new PlatformRequestError(0, "NETWORK_ERROR", "", "Request failed");
  }
  if (options.signal?.aborted) throw new PlatformRequestAbortError();

  if (!response.ok) throw await readProblem(response, options.signal);
  if (response.status === 204) {
    if (options.responseSchema) {
      throw new PlatformRequestError(204, "RESPONSE_BODY_REQUIRED", responseRequestId(response),
        "Response body required");
    }
    return undefined as T;
  }
  if (!options.responseSchema) {
    throw new PlatformRequestError(response.status, "RESPONSE_BODY_UNEXPECTED", responseRequestId(response),
      "Unexpected response body");
  }
  if (!isContentType(response, "application/json")) {
    throw new PlatformRequestError(response.status, "RESPONSE_INVALID", responseRequestId(response),
      "Invalid server response");
  }
  const body = await readJson(response, options.signal);
  const parsed = options.responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new PlatformRequestError(response.status, "RESPONSE_INVALID", responseRequestId(response),
      "Invalid server response");
  }
  throwIfAborted(options.signal);
  return parsed.data;
}

function validateTarget(target: string) {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//") || target.includes("\\")) {
    throw new PlatformRequestError(0, "REQUEST_TARGET_INVALID", "", "Invalid request target");
  }
  let parsed: URL;
  try {
    parsed = new URL(target, "https://same-origin.invalid");
  } catch {
    throw new PlatformRequestError(0, "REQUEST_TARGET_INVALID", "", "Invalid request target");
  }
  const secretInUrl = Array.from(parsed.searchParams.keys()).some((key) => /token|secret|password|code/i.test(key));
  const apiPath = parsed.pathname === "/api/v2" || parsed.pathname.startsWith("/api/v2/");
  if (parsed.origin !== "https://same-origin.invalid" || !apiPath || parsed.hash || secretInUrl) {
    throw new PlatformRequestError(0, "REQUEST_TARGET_INVALID", "", "Invalid request target");
  }
}

async function readProblem(response: Response, signal?: AbortSignal) {
  if (isContentType(response, "application/problem+json")) {
    const parsed = problemDetailsSchema.safeParse(await readJson(response, signal));
    if (parsed.success && parsed.data.status === response.status) {
      return new PlatformRequestError(parsed.data.status, parsed.data.code, parsed.data.requestId, "Request failed");
    }
  }
  return new PlatformRequestError(response.status, "PROBLEM_RESPONSE_INVALID", responseRequestId(response),
    "Invalid server response");
}

async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  try {
    throwIfAborted(signal);
    const text = await readBoundedBody(response, signal);
    throwIfAborted(signal);
    const parsed = JSON.parse(text) as unknown;
    throwIfAborted(signal);
    return parsed;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw new PlatformRequestAbortError();
    if (error instanceof ResponseBodyTooLargeError) {
      throw new PlatformRequestError(response.status, "RESPONSE_BODY_TOO_LARGE", responseRequestId(response),
        "Response body too large");
    }
    return undefined;
  }
}

async function readBoundedBody(response: Response, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (trustedContentLength(response) > PLATFORM_RESPONSE_BODY_MAX_BYTES) {
    await discardBody(response.body);
    throw new ResponseBodyTooLargeError();
  }
  if (!response.body) {
    const text = await response.text();
    throwIfAborted(signal);
    if (utf8Encoder.encode(text).byteLength > PLATFORM_RESPONSE_BODY_MAX_BYTES) {
      throw new ResponseBodyTooLargeError();
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let cancellation: Promise<boolean> | undefined;
  const cancelOnce = () => cancellation ??= cancelReader(reader);
  const abortReader = () => { void cancelOnce(); };
  signal?.addEventListener("abort", abortReader, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      throwIfAborted(signal);
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > PLATFORM_RESPONSE_BODY_MAX_BYTES) {
        throw new ResponseBodyTooLargeError();
      }
      chunks.push(chunk.value);
    }
    throwIfAborted(signal);
    const body = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  } catch (error) {
    await cancelOnce();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortReader);
    releaseReader(reader);
  }
}

function trustedContentLength(response: Response) {
  const value = response.headers.get("content-length");
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

async function discardBody(body: ReadableStream<Uint8Array> | null) {
  if (!body) return;
  const reader = body.getReader();
  try {
    await cancelReader(reader);
  } finally {
    releaseReader(reader);
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    await reader.cancel();
    return true;
  } catch {
    return false;
  }
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    reader.releaseLock();
    return true;
  } catch {
    return false;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PlatformRequestAbortError();
}

function isContentType(response: Response, expected: string) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

function responseRequestId(response: Response) {
  const value = response.headers.get("x-request-id") ?? "";
  return requestIdSchema.safeParse(value).success ? value : "";
}

function isAbortError(error: unknown) {
  return error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";
}
