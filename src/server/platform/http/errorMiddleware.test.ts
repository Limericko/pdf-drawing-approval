import { describe, expect, it, vi } from "vitest";
import { AuthenticationServiceError } from "../../modules/identity/authenticationService.ts";
import { createErrorMiddleware } from "./errorMiddleware.ts";
import { HttpProblem } from "./problemResponse.ts";

describe("errorMiddleware", () => {
  it.each([undefined, null, {}, { error: "not-a-function" }])(
    "rejects an invalid primary logger at construction: %j", (logger) => {
      expect(() => createErrorMiddleware({ logger, emergencySink: vi.fn() } as never))
        .toThrow("ERROR_MIDDLEWARE_LOGGER_REQUIRED");
    });

  it.each([undefined, null, {}, "not-a-function"])(
    "rejects an invalid emergency sink at construction: %j", (emergencySink) => {
      expect(() => createErrorMiddleware({ logger: { error: vi.fn() }, emergencySink } as never))
        .toThrow("ERROR_MIDDLEWARE_EMERGENCY_SINK_REQUIRED");
    });

  it("maps domain errors to stable problem+json with the request ID", () => {
    const logger = { error: vi.fn() };
    const emergencySink = vi.fn();
    const middleware = createErrorMiddleware({ logger, emergencySink });
    const response = fakeResponse("request-123");

    middleware(new AuthenticationServiceError("AUTHENTICATION_INVALID_CREDENTIALS"), {} as never,
      response as never, vi.fn());

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.type).toHaveBeenCalledWith("application/problem+json");
    expect(response.json).toHaveBeenCalledWith({ type: "about:blank", title: "Authentication required",
      status: 401, code: "AUTHENTICATION_INVALID_CREDENTIALS", requestId: "request-123" });
    expect(logger.error).not.toHaveBeenCalled();
    expect(emergencySink).not.toHaveBeenCalled();
  });

  it.each([
    [Object.assign(new Error("SELECT password_hash FROM users WHERE password='secret'"), { code: "08006" }),
      503, "DATABASE_UNAVAILABLE"],
    [new Error("https://user:password@example.test/internal secret stack"), 500, "INTERNAL_ERROR"]
  ] as const)("sanitizes database and unknown failures", (failure, status, code) => {
    const logger = { error: vi.fn() };
    const emergencySink = vi.fn();
    const middleware = createErrorMiddleware({ logger, emergencySink });
    const response = fakeResponse("request-safe");

    middleware(failure, {} as never, response as never, vi.fn());

    const serialized = JSON.stringify(response.json.mock.calls[0]?.[0]);
    expect(serialized).not.toMatch(/SELECT|password|example\.test|secret|stack/i);
    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ status, code }));
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-safe" }));
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).not.toHaveProperty("error");
    expect(emergencySink).not.toHaveBeenCalled();
  });

  it("reports a primary logger failure once through the sanitized emergency sink and still responds", () => {
    const logger = { error: vi.fn(() => { throw new Error("logger secret credential"); }) };
    const emergencySink = vi.fn();
    const middleware = createErrorMiddleware({ logger, emergencySink });
    const response = fakeResponse("logger-failure-request");

    middleware(new Error("service secret password"), {} as never, response as never, vi.fn());

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(emergencySink).toHaveBeenCalledTimes(1);
    expect(emergencySink).toHaveBeenCalledWith({ requestId: "logger-failure-request", code: "LOGGER_FAILURE" });
    expect(response.json).toHaveBeenCalledWith({ type: "about:blank", title: "Internal server error",
      status: 500, code: "INTERNAL_ERROR", requestId: "logger-failure-request" });
    expect(JSON.stringify([emergencySink.mock.calls, response.json.mock.calls])).not.toMatch(/secret|credential|password/i);
  });

  it("delegates after headers were sent", () => {
    const next = vi.fn();
    const logger = { error: vi.fn() };
    const emergencySink = vi.fn();
    const middleware = createErrorMiddleware({ logger, emergencySink });
    const response = { ...fakeResponse("request-sent"), headersSent: true };
    const failure = new HttpProblem(403, "ORIGIN_FORBIDDEN", "Forbidden");

    middleware(failure, {} as never, response as never, next);

    expect(next).toHaveBeenCalledWith(failure);
    expect(next).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(emergencySink).not.toHaveBeenCalled();
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it("maps malformed JSON from the upper body parser without echoing its body", () => {
    const logger = { error: vi.fn() };
    const emergencySink = vi.fn();
    const middleware = createErrorMiddleware({ logger, emergencySink });
    const response = fakeResponse("malformed-json-request");
    const failure = Object.assign(new SyntaxError("Unexpected token secret"), {
      type: "entity.parse.failed", status: 400, body: "{\"password\":\"secret\"}"
    });

    middleware(failure, {} as never, response as never, vi.fn());

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ type: "about:blank", title: "Invalid request body",
      status: 400, code: "REQUEST_BODY_INVALID", requestId: "malformed-json-request" });
    expect(JSON.stringify(response.json.mock.calls[0]?.[0])).not.toContain("secret");
    expect(logger.error).not.toHaveBeenCalled();
    expect(emergencySink).not.toHaveBeenCalled();
  });

  it("creates and returns a safe request ID when request context is unavailable", () => {
    const middleware = createErrorMiddleware({ logger: { error: vi.fn() }, emergencySink: vi.fn() });
    const response = fakeResponse(undefined);

    middleware(new Error("unknown"), {} as never, response as never, vi.fn());

    const body = response.json.mock.calls[0]?.[0] as { requestId: string };
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.requestId).not.toBe("unavailable");
    expect(response.setHeader).toHaveBeenCalledWith("X-Request-ID", body.requestId);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });
});

function fakeResponse(requestId: string | undefined) {
  return { locals: requestId ? { requestId } : {}, headersSent: false, setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(), type: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
}
