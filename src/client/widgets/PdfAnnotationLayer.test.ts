import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { annotationToneStyle } from "./PdfAnnotationLayer.tsx";

const source = fs.readFileSync(path.resolve("src/client/widgets/PdfAnnotationLayer.tsx"), "utf8");

describe("PDF annotation layer rendering", () => {
  it("applies custom annotation colors to SVG tools through currentColor", () => {
    expect(annotationToneStyle({ color: "custom", styleJson: JSON.stringify({ strokeColor: "#7c3aed" }) })).toEqual({
      "--annotation-tone": "#7c3aed",
      color: "var(--annotation-tone)"
    });
  });

  it("uses per-annotation arrow markers so arrow heads inherit the annotation color", () => {
    expect(source).toContain("annotationArrowMarkerId(annotation)");
    expect(source).toContain("annotationArrowMarkerId(draftAnnotation)");
    expect(source).toContain("style={annotationToneStyle(annotation)}");
    expect(source).not.toContain("id={`annotation-arrow-${pageNumber}`}");
  });
});
