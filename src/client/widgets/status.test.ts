import { describe, expect, it } from "vitest";
import { signatureStatusLabel, statusLabel } from "./status.ts";
import { statusChipClassName } from "./StatusChip.tsx";

describe("status labels", () => {
  it("keeps approval pending separate from signature pending", () => {
    expect(statusLabel("pending")).toBe("待审");
    expect(signatureStatusLabel("pending")).toBe("等待自动签名");
  });

  it("maps signature statuses to operational chip tones", () => {
    expect(statusChipClassName("generated", "signature")).toContain("status-chip--approved");
    expect(statusChipClassName("failed", "signature")).toContain("status-chip--invalid");
    expect(statusChipClassName("placement_required", "signature")).toContain("status-chip--pending");
    expect(statusChipClassName("ready", "signature")).toContain("status-chip--pending");
    expect(statusChipClassName("not_required", "signature")).toContain("status-chip--archived");
  });
});
