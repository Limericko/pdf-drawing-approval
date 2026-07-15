import { describe, expect, it } from "vitest";
import {
  clampPdfInspectorWidth,
  defaultPdfInspectorWidth,
  pdfInspectorWidthStorageKey,
  readPdfInspectorWidth
} from "./ResizableInspectorPane.tsx";

describe("PDF Studio resizable inspector", () => {
  it("uses the compact and wide desktop defaults", () => {
    expect(defaultPdfInspectorWidth(1100)).toBe(280);
    expect(defaultPdfInspectorWidth(1440)).toBe(320);
  });

  it("clamps persisted widths to product and viewport bounds", () => {
    expect(clampPdfInspectorWidth(120, 1440)).toBe(280);
    expect(clampPdfInspectorWidth(600, 1440)).toBe(480);
    expect(clampPdfInspectorWidth(480, 1000)).toBe(400);
    expect(readPdfInspectorWidth({ getItem: () => "420" }, 1440)).toBe(420);
    expect(readPdfInspectorWidth({ getItem: () => "invalid" }, 1100)).toBe(280);
    expect(pdfInspectorWidthStorageKey).toBe("pdf-studio.inspector-width");
  });
});
