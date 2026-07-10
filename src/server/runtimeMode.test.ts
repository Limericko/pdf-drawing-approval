import { describe, expect, it } from "vitest";
import { resolveRuntimeMode } from "./runtimeMode.ts";

describe("resolveRuntimeMode", () => {
  it("defaults to legacy when the runtime mode is not configured", () => {
    expect(resolveRuntimeMode({})).toBe("legacy");
  });

  it.each(["legacy", "platform"] as const)("accepts the %s runtime mode", (runtimeMode) => {
    expect(resolveRuntimeMode({ PDF_APPROVAL_RUNTIME_MODE: runtimeMode })).toBe(runtimeMode);
  });

  it("rejects unknown runtime modes", () => {
    expect(() => resolveRuntimeMode({ PDF_APPROVAL_RUNTIME_MODE: "hybrid" })).toThrow("INVALID_RUNTIME_MODE");
  });
});
