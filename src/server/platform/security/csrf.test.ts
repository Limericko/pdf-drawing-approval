import { describe, expect, it, vi } from "vitest";
import { createCsrfMiddleware, createCsrfProtection } from "./csrf.ts";

const sessionA = "01890f1e-9b4a-7cc2-8f00-000000000001";
const sessionB = "01890f1e-9b4a-7cc2-8f00-000000000002";

describe("csrf", () => {
  const keyring = { currentVersion: "v2", keys: new Map([
    ["v1", Buffer.alloc(32, 1)], ["v2", Buffer.alloc(32, 2)]
  ]) };

  it("issues a versioned token bound to the database session ID", () => {
    const csrf = createCsrfProtection({ keyring });
    const token = csrf.issue(sessionA);
    expect(token).toMatch(/^v2\.[A-Za-z0-9_-]+$/);
    expect(csrf.verify(sessionA, token)).toBe(true);
    expect(csrf.verify(sessionB, token)).toBe(false);
    expect(csrf.verify(sessionA, `${token}x`)).toBe(false);
  });

  it("rejects missing and cross-session headers", () => {
    const csrf = createCsrfProtection({ keyring });
    const middleware = createCsrfMiddleware({ csrf });
    for (const header of [undefined, csrf.issue(sessionB), "v9.invalid"]) {
      const next = vi.fn();
      middleware({ get: () => header } as never,
        { locals: { platformAuth: { session: { id: sessionA } } } } as never, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "CSRF_INVALID" }));
    }
  });
});
