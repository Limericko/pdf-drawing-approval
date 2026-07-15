import { describe, expect, it, vi } from "vitest";
import { asyncRoute } from "./asyncRoute.ts";

describe("asyncRoute", () => {
  it("forwards an Express 4 async rejection to next exactly once", async () => {
    const failure = new Error("route rejected");
    const next = vi.fn();
    const handler = asyncRoute(async () => { throw failure; });

    handler({} as never, {} as never, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(failure);
  });

  it("does not call next when an async handler resolves", async () => {
    const next = vi.fn();
    const handler = asyncRoute(async (_request, response) => {
      response.status(204).end();
    });
    const response = { status: vi.fn().mockReturnThis(), end: vi.fn() };

    handler({} as never, response as never, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.status).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
  });
});
