import { describe, expect, it } from "vitest";
import { movePlacementToPage, resizePlacement } from "./SignaturePlacementEditor.tsx";
import type { SignaturePlacement } from "../api.ts";

const placement: SignaturePlacement = {
  role: "designer",
  pageNumber: 1,
  xRatio: 0.4,
  yRatio: 0.8,
  widthRatio: 0.08,
  heightRatio: 0.04
};

describe("SignaturePlacementEditor geometry", () => {
  it("allows small signature boxes for compact title blocks", () => {
    const resized = resizePlacement(placement, -0.2, -0.2);

    expect(resized.widthRatio).toBe(0.015);
    expect(resized.heightRatio).toBe(0.012);
  });

  it("keeps resized boxes inside the preview area", () => {
    const resized = resizePlacement({ ...placement, xRatio: 0.96, yRatio: 0.97 }, 0.2, 0.2);

    expect(resized.widthRatio).toBeLessThanOrEqual(0.04);
    expect(resized.heightRatio).toBeLessThanOrEqual(0.03);
  });

  it("moves a signature box to another page without changing its geometry", () => {
    const moved = movePlacementToPage(placement, 3);

    expect(moved).toEqual({ ...placement, pageNumber: 3 });
  });
});
