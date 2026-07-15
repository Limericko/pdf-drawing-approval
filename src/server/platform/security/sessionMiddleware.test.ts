import { describe, expect, it, vi } from "vitest";
import { createSessionMiddleware, requirePlatformAuth } from "./sessionMiddleware.ts";

describe("sessionMiddleware", () => {
  it("leaves a request anonymous when the session cookie is absent", async () => {
    const authenticate = vi.fn();
    const next = vi.fn();
    createSessionMiddleware({ cookieName: "platform_session", sessions: { authenticate } })
      ({ headers: {} } as never, { locals: {} } as never, next);
    await new Promise((resolve) => setImmediate(resolve));
    expect(authenticate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("writes only res.locals.platformAuth and never legacy req.user", async () => {
    const auth = { user: { id: "user-id" }, session: { id: "session-id" } };
    const authenticate = vi.fn().mockResolvedValue(auth);
    const request = { headers: { cookie: "platform_session=opaque%20token" } };
    const response = { locals: {} as Record<string, unknown> };
    const next = vi.fn();

    createSessionMiddleware({ cookieName: "platform_session", sessions: { authenticate } })
      (request as never, response as never, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(authenticate).toHaveBeenCalledWith({ sessionToken: "opaque token" });
    expect(response.locals.platformAuth).toEqual(auth);
    expect(request).not.toHaveProperty("user");
    expect(next).toHaveBeenCalledWith();
  });

  it("forwards a bad-cookie authentication failure", async () => {
    const failure = Object.assign(new Error("invalid"), { code: "SESSION_INVALID" });
    const next = vi.fn();
    createSessionMiddleware({ cookieName: "platform_session",
      sessions: { authenticate: vi.fn().mockRejectedValue(failure) } })
      ({ headers: { cookie: "platform_session=bad" } } as never, { locals: {} } as never, next);
    await new Promise((resolve) => setImmediate(resolve));
    expect(next).toHaveBeenCalledWith(failure);
  });

  it("requires platform authentication without consulting legacy request state", () => {
    const next = vi.fn();
    requirePlatformAuth({ user: { id: 7 } } as never, { locals: {} } as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "AUTHENTICATION_REQUIRED" }));
  });
});
