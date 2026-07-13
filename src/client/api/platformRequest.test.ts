import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PlatformRequestAbortError, PlatformRequestError, platformRequest } from "./platformRequest.ts";

const okSchema = z.object({ ok: z.literal(true) }).strict();
const largeValueSchema = z.object({ value: z.string() }).strict();
const RESPONSE_BODY_LIMIT = 64 * 1024;
const encoder = new TextEncoder();

describe("platformRequest", () => {
  it("uses only same-origin credentials and adds JSON, CSRF and Accept headers", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await platformRequest("/api/v2/projects", {
      method: "POST",
      json: { name: "项目 A" },
      csrfToken: "csrf-memory-only",
      responseSchema: okSchema
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/v2/projects", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ name: "项目 A" }),
      headers: expect.anything()
    }));
    const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-csrf-token")).toBe("csrf-memory-only");
  });

  it("rejects absolute, protocol-relative and credential-bearing request targets before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const target of [
      "https://evil.example/api/v2/session",
      "//evil.example/api/v2/session",
      "/api/v2/session?token=url-secret",
      "/api/v2/../../health",
      "/api/v2/%2e%2e/%2e%2e/health",
      "/api/v20/session"
    ]) {
      await expect(platformRequest(target, { responseSchema: okSchema })).rejects.toMatchObject({
        status: 0,
        code: "REQUEST_TARGET_INVALID"
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows the normalized /api/v2 root without permitting path escape", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(platformRequest("/api/v2", { responseSchema: okSchema })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/v2", expect.anything());
  });

  it("accepts an empty 204 only when no response schema is expected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    await expect(platformRequest("/api/v2/session", { method: "DELETE" })).resolves.toBeUndefined();
    await expect(platformRequest("/api/v2/session", {
      method: "DELETE",
      responseSchema: okSchema
    })).rejects.toMatchObject({ code: "RESPONSE_BODY_REQUIRED", status: 204 });
  });

  it("strictly parses successful JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, secret: "unexpected" })));

    await expect(platformRequest("/api/v2/session", { responseSchema: okSchema })).rejects.toMatchObject({
      status: 200,
      code: "RESPONSE_INVALID"
    });
  });

  it("rejects a streamed success body that exceeds the byte limit despite a small Content-Length", async () => {
    const secret = "token=oversized-success-secret";
    const body = `${JSON.stringify({ ok: true })}${secret.repeat(RESPONSE_BODY_LIMIT)}`;
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false as const, value: encoder.encode(body.slice(0, 32)) })
      .mockResolvedValueOnce({ done: false as const, value: encoder.encode(body.slice(32)) });
    const response = responseWithReader({ read, cancel, releaseLock },
      { "Content-Type": "application/json", "Content-Length": "16" }, async () => body);
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const error = await platformRequest("/api/v2/session", { responseSchema: okSchema }).catch((caught) => caught);
    expect(error).toEqual({ status: 200, code: "RESPONSE_BODY_TOO_LARGE", requestId: "",
      title: "Response body too large" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("rejects a trusted oversized Content-Length before reading body bytes", async () => {
    const read = vi.fn(async () => ({ done: true as const, value: undefined }));
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseWithReader({ read, cancel, releaseLock }, {
      "Content-Type": "application/json",
      "Content-Length": String(RESPONSE_BODY_LIMIT + 1)
    }, async () => JSON.stringify({ ok: true }));
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(platformRequest("/api/v2/session", { responseSchema: okSchema }))
      .rejects.toMatchObject({ status: 200, code: "RESPONSE_BODY_TOO_LARGE" });
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized streamed problem body without relying on Content-Length", async () => {
    const secret = "password=oversized-problem-secret";
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      encoder.encode(secret.repeat(RESPONSE_BODY_LIMIT))
    ], { "Content-Type": "application/problem+json", "X-Request-ID": "safe-request-id" }, 413)));

    const error = await platformRequest("/api/v2/session", { responseSchema: okSchema }).catch((caught) => caught);
    expect(error).toEqual({ status: 413, code: "RESPONSE_BODY_TOO_LARGE", requestId: "safe-request-id",
      title: "Response body too large" });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("enforces the response limit in UTF-8 bytes at the multibyte boundary", async () => {
    const envelopeBytes = encoder.encode(JSON.stringify({ value: "" })).byteLength;
    const exactBody = JSON.stringify({ value: `${"a".repeat(RESPONSE_BODY_LIMIT - envelopeBytes - 3)}界` });
    const oversizedBody = JSON.stringify({ value: `${"a".repeat(RESPONSE_BODY_LIMIT - envelopeBytes - 2)}界` });
    expect(encoder.encode(exactBody)).toHaveLength(RESPONSE_BODY_LIMIT);
    expect(encoder.encode(oversizedBody)).toHaveLength(RESPONSE_BODY_LIMIT + 1);

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(streamResponse([encoder.encode(exactBody)], { "Content-Type": "application/json" }))
      .mockResolvedValueOnce(streamResponse([encoder.encode(oversizedBody)], { "Content-Type": "application/json" })));

    await expect(platformRequest("/api/v2/session", { responseSchema: largeValueSchema }))
      .resolves.toEqual(JSON.parse(exactBody));
    await expect(platformRequest("/api/v2/session", { responseSchema: largeValueSchema }))
      .rejects.toMatchObject({ code: "RESPONSE_BODY_TOO_LARGE", status: 200 });
  });

  it("returns the stable abort error when abort happens while read still resolves", async () => {
    const secret = "token=resolved-read-abort-secret";
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const body = JSON.stringify({ ok: true });
    const read = vi.fn(async () => {
      controller.abort(new Error(secret));
      return { done: false as const, value: encoder.encode(body) };
    });
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseWithReader({ read, cancel, releaseLock },
      { "Content-Type": "application/json" }, async () => {
        controller.abort(new Error(secret));
        return body;
      });
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const error = await platformRequest("/api/v2/session", {
      responseSchema: okSchema,
      signal: controller.signal
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PlatformRequestAbortError);
    expect(error).toEqual({ status: 0, code: "REQUEST_ABORTED", requestId: "", title: "Request cancelled" });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener.mock.calls[0]![0]).toBe(addEventListener.mock.calls[0]![0]);
  });

  it("contains reader and cancel failures without unhandled or secret-bearing errors", async () => {
    const secret = "password=reader-lifecycle-secret";
    const cancel = vi.fn(async () => { throw new Error(secret); });
    const oversizedRelease = vi.fn();
    const oversizedResponse = responseWithReader({
      read: vi.fn(async () => ({ done: false as const, value: new Uint8Array(RESPONSE_BODY_LIMIT + 1) })),
      cancel,
      releaseLock: oversizedRelease
    }, { "Content-Type": "application/json" }, async () => JSON.stringify({ ok: true }));
    const failedReadRelease = vi.fn();
    const failedReadResponse = responseWithReader({
      read: vi.fn(async () => { throw new Error(secret); }),
      cancel: vi.fn(async () => undefined),
      releaseLock: failedReadRelease
    }, { "Content-Type": "application/json" }, async () => JSON.stringify({ ok: true }));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(oversizedResponse)
      .mockResolvedValueOnce(failedReadResponse));

    const oversized = await platformRequest("/api/v2/session", { responseSchema: okSchema }).catch((caught) => caught);
    expect(oversized).toMatchObject({ code: "RESPONSE_BODY_TOO_LARGE", status: 200 });
    expect(JSON.stringify(oversized)).not.toContain(secret);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(oversizedRelease).toHaveBeenCalledTimes(1);
    const failedRead = await platformRequest("/api/v2/session", { responseSchema: okSchema }).catch((caught) => caught);
    expect(failedRead).toMatchObject({ code: "RESPONSE_INVALID", status: 200 });
    expect(JSON.stringify(failedRead)).not.toContain(secret);
    expect(failedReadRelease).toHaveBeenCalledTimes(1);
  });

  it("checks byte length and abort state for the body-less text fallback", async () => {
    const oversizedResponse = new Response(null, { headers: { "Content-Type": "application/json" } });
    Object.defineProperty(oversizedResponse, "text", {
      value: async () => JSON.stringify({ value: "界".repeat(RESPONSE_BODY_LIMIT) })
    });
    const controller = new AbortController();
    const abortedResponse = new Response(null, { headers: { "Content-Type": "application/json" } });
    Object.defineProperty(abortedResponse, "text", {
      value: async () => {
        controller.abort(new Error("token=fallback-abort-secret"));
        return JSON.stringify({ ok: true });
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(oversizedResponse).mockResolvedValueOnce(abortedResponse));

    await expect(platformRequest("/api/v2/session", { responseSchema: largeValueSchema }))
      .rejects.toMatchObject({ code: "RESPONSE_BODY_TOO_LARGE", status: 200 });
    await expect(platformRequest("/api/v2/session", { responseSchema: okSchema, signal: controller.signal }))
      .rejects.toEqual({ status: 0, code: "REQUEST_ABORTED", requestId: "", title: "Request cancelled" });
  });

  it("replaces an untrusted problem title with a local stable title", async () => {
    const bodySecret = "password=hunter2 token=url-secret https://admin:password@example.test/private";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      type: "about:blank",
      status: 401,
      code: "SESSION_INVALID",
      requestId: "request-123",
      title: bodySecret
    }), {
      status: 401,
      headers: { "Content-Type": "application/problem+json", "X-Debug-Secret": bodySecret }
    })));

    const error = await platformRequest("/api/v2/session", { responseSchema: okSchema }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PlatformRequestError);
    expect(Object.keys(error).sort()).toEqual(["code", "requestId", "status", "title"]);
    expect(error).toEqual({
      status: 401,
      code: "SESSION_INVALID",
      requestId: "request-123",
      title: "Request failed"
    });
    expect(JSON.stringify(error)).not.toContain(bodySecret);
    expect(String(error)).not.toContain(bodySecret);
    expect(error).not.toHaveProperty("stack");
  });

  it("uses the same local title for an unknown stable problem code", async () => {
    const secret = "password=unknown-secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      type: "about:blank", status: 418, code: "UNKNOWN_SERVER_PROBLEM", requestId: "unknown-request", title: secret
    }), { status: 418, headers: { "Content-Type": "application/problem+json" } })));

    const error = await platformRequest("/api/v2/session", { responseSchema: okSchema }).catch((caught) => caught);
    expect(error).toEqual({ status: 418, code: "UNKNOWN_SERVER_PROBLEM", requestId: "unknown-request",
      title: "Request failed" });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
  });

  it.each([
    ["text/html", "<h1>proxy secret</h1>"],
    ["application/problem+json", "{"],
    ["application/problem+json", JSON.stringify({ status: 500, code: "BAD", title: "oops" })]
  ])("sanitizes non-2xx malformed %s responses", async (contentType, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 500,
      headers: { "Content-Type": contentType, "X-Request-ID": "safe-request-id" }
    })));

    const error = await platformRequest("/api/v2/session", { responseSchema: okSchema }).catch((caught) => caught);
    expect(error).toEqual({
      status: 500,
      code: "PROBLEM_RESPONSE_INVALID",
      requestId: "safe-request-id",
      title: "Invalid server response"
    });
    expect(JSON.stringify(error)).not.toMatch(/proxy secret|oops/);
  });

  it("sanitizes network failures without logging or persisting their secrets", async () => {
    const secret = "https://admin:password@example.test/?token=network-secret";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    vi.stubGlobal("sessionStorage", { setItem });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(secret); }));

    const error = await platformRequest("/api/v2/session", { responseSchema: okSchema }).catch((caught) => caught);
    expect(error).toEqual({ status: 0, code: "NETWORK_ERROR", requestId: "", title: "Request failed" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("returns a stable abort error for a pre-aborted signal without reading its secret reason", async () => {
    const secret = "password=abort-reason-secret";
    const controller = new AbortController();
    controller.abort(new Error(secret));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await platformRequest("/api/v2/session", {
      responseSchema: okSchema,
      signal: controller.signal
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PlatformRequestAbortError);
    expect(error).toEqual({ status: 0, code: "REQUEST_ABORTED", requestId: "", title: "Request cancelled" });
    expect(Object.keys(error).sort()).toEqual(["code", "requestId", "status", "title"]);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
    expect(error).not.toHaveProperty("reason");
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("stack");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recognizes a fetch AbortError without retaining its message", async () => {
    const secret = "token=fetch-abort-secret";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException(secret, "AbortError"); }));

    const error = await platformRequest("/api/v2/session", { responseSchema: okSchema }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PlatformRequestAbortError);
    expect(error).toEqual({ status: 0, code: "REQUEST_ABORTED", requestId: "", title: "Request cancelled" });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
  });

  it("recognizes cancellation after response headers but before body parsing", async () => {
    const secret = "password=response-stage-abort";
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      controller.abort(new Error(secret));
      return jsonResponse({ ok: true });
    }));

    const error = await platformRequest("/api/v2/session", {
      responseSchema: okSchema,
      signal: controller.signal
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PlatformRequestAbortError);
    expect(error).toEqual({ status: 0, code: "REQUEST_ABORTED", requestId: "", title: "Request cancelled" });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
  });

  it("recognizes an AbortError while reading a response body", async () => {
    const secret = "token=response-body-abort";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: async () => { throw new DOMException(secret, "AbortError"); }
    })));

    const error = await platformRequest("/api/v2/session", { responseSchema: okSchema }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PlatformRequestAbortError);
    expect(error).toEqual({ status: 0, code: "REQUEST_ABORTED", requestId: "", title: "Request cancelled" });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function streamResponse(
  chunks: readonly Uint8Array[],
  headers: HeadersInit,
  status = 200,
  onCancel?: () => void,
  beforeFirstChunk?: () => void
) {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === 0) beforeFirstChunk?.();
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    }
  }), { status, headers });
}

function responseWithReader(
  reader: {
    read(): Promise<ReadableStreamReadResult<Uint8Array>>;
    cancel(): Promise<void>;
    releaseLock(): void;
  },
  headers: HeadersInit,
  text: () => Promise<string>
) {
  const response = new Response(null, { headers });
  Object.defineProperty(response, "body", { value: { getReader: () => reader } });
  Object.defineProperty(response, "text", { value: text });
  return response;
}
