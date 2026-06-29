import { describe, expect, it } from "vitest";
import viteConfig from "../../vite.config.ts";

describe("vite dev server proxy", () => {
  it("does not proxy frontend modules whose filenames start with api", () => {
    const proxy = viteConfig.server?.proxy ?? {};

    expect(Object.keys(proxy)).not.toContain("/api");
    expect(proxy).toEqual(expect.objectContaining({ "/api/": "http://localhost:8080" }));
    expect(proxy).toEqual(expect.objectContaining({ "/health": "http://localhost:8080" }));
  });
});
