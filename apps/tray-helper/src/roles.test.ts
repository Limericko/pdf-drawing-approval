import { describe, expect, it } from "vitest";
import { menuModeForRole } from "./roles.ts";

describe("menuModeForRole", () => {
  it("maps roles to menu modes", () => {
    expect(menuModeForRole("supervisor")).toBe("reviewer");
    expect(menuModeForRole("process")).toBe("reviewer");
    expect(menuModeForRole("designer")).toBe("designer");
    expect(menuModeForRole("admin")).toBe("admin");
  });
});
