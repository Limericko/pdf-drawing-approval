import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalAnnotation } from "../features/pdf-studio/annotationTypes.ts";
import {
  annotationBounds,
  annotationsForPage,
  createAnnotationFromDrag,
  createCloudAnnotationPath,
  createInkAnnotationFromPoints,
  mergePageAnnotations,
  moveAnnotation,
  resizeAnnotation
  ,shouldRenderHighResolutionPage,
  shouldRenderPdfThumbnail
} from "./PdfAnnotationWorkspace.tsx";

const annotations = [
  annotation({ id: 1, pageNumber: 1, kind: "rect" }),
  annotation({ id: 2, pageNumber: 2, kind: "pin" }),
  annotation({ id: 3, pageNumber: 1, kind: "arrow" })
];

describe("PDF annotation workspace helpers", () => {
  it("loads the legacy pdf.js build for browser compatibility", () => {
    const source = fs.readFileSync(path.resolve("src/client/widgets/PdfAnnotationWorkspace.tsx"), "utf8");

    expect(source).toContain('import("pdfjs-dist/legacy/build/pdf.mjs")');
    expect(source).toContain('import("pdfjs-dist/legacy/build/pdf.worker.mjs?url")');
    expect(source).not.toContain('import("pdfjs-dist")');
    expect(source).not.toContain('import("pdfjs-dist/build/pdf.worker.mjs?url")');
  });

  it("wires shared PDF viewport controls into the annotation preview", () => {
    const source = fs.readFileSync(path.resolve("src/client/widgets/PdfAnnotationWorkspace.tsx"), "utf8");

    expect(source).toContain("PdfViewportToolbar");
    expect(source).toContain("pdfPageWidthStyle");
    expect(source).toContain("createPdfViewportWheelHandler");
    expect(source).toContain("pdfViewportWheelListenerOptions");
    expect(source).toContain('addEventListener("wheel"');
    expect(source).toContain('removeEventListener("wheel"');
    expect(source).toContain("onPointerDownCapture={startPdfPan}");
    expect(source).not.toContain("onWheel={onPdfViewportWheel}");
    expect(source).toContain("className={studioStyles.viewport}");
    expect(source).toContain("data-pan={viewport.panMode}");
  });

  it("offers page navigation without removing viewport wheel and pan wiring", () => {
    const source = fs.readFileSync(path.resolve("src/client/widgets/PdfAnnotationWorkspace.tsx"), "utf8");

    expect(source).toContain("pageRefs");
    expect(source).toContain("jumpToPage");
    expect(source).toContain("scrollIntoView({ block: \"start\"");
    expect(source).toContain('aria-label="上一页"');
    expect(source).toContain('aria-label="下一页"');
    expect(source).toContain("className={studioStyles.rail}");
    expect(source).toContain('aria-label={`跳转到第 ${pageNumber} 页`');
    expect(source).toContain("data-active={pageNumber === currentPage}");
    expect(source).toContain('addEventListener("wheel"');
    expect(source).toContain("onPointerDownCapture={startPdfPan}");
    expect(source).toContain("renderCanvas={shouldRenderHighResolutionPage(pageNumber, currentPage)}");
    expect(source).toContain("PdfPageThumbnail");
  });

  it("limits high-resolution canvases and lazy thumbnails in long documents", () => {
    const pages = Array.from({ length: 200 }, (_, index) => index + 1);
    expect(pages.filter((page) => shouldRenderHighResolutionPage(page, 100))).toEqual([99, 100, 101]);
    expect(pages.filter((page) => shouldRenderPdfThumbnail(page, 100))).toEqual([97, 98, 99, 100, 101, 102, 103]);
  });

  it("filters annotations by PDF page", () => {
    expect(annotationsForPage(annotations, 1).map((item) => item.id)).toEqual([1, 3]);
    expect(annotationsForPage(annotations, 2).map((item) => item.id)).toEqual([2]);
  });

  it("merges edited page annotations without moving annotations on other pages", () => {
    const next = mergePageAnnotations(annotations, 1, [{ ...annotations[0], message: "已改" }]);

    expect(next).toEqual([{ ...annotations[0], message: "已改" }, annotations[1]]);
  });

  it("creates rectangle-style annotations from drag bounds using page ratios", () => {
    expect(
      createAnnotationFromDrag(
        "rect",
        { xRatio: 0.6, yRatio: 0.5 },
        { xRatio: 0.2, yRatio: 0.1 },
        2,
        { message: "尺寸需确认", color: "amber" }
      )
    ).toEqual({
      kind: "rect",
      message: "尺寸需确认",
      pageNumber: 2,
      xRatio: 0.2,
      yRatio: 0.1,
      widthRatio: 0.4,
      heightRatio: 0.4,
      endXRatio: null,
      endYRatio: null,
      color: "amber"
    });
  });

  it("preserves custom color style metadata when creating annotations", () => {
    expect(
      createAnnotationFromDrag(
        "rect",
        { xRatio: 0.1, yRatio: 0.2 },
        { xRatio: 0.3, yRatio: 0.4 },
        1,
        { message: "自定义颜色", color: "custom", styleJson: JSON.stringify({ strokeColor: "#7c3aed" }) }
      )
    ).toEqual(
      expect.objectContaining({
        color: "custom",
        styleJson: JSON.stringify({ strokeColor: "#7c3aed" })
      })
    );
  });

  it("creates pin and arrow annotations with clamped ratios", () => {
    expect(
      createAnnotationFromDrag(
        "pin",
        { xRatio: 1.2, yRatio: -0.1 },
        { xRatio: 1.2, yRatio: -0.1 },
        1,
        { message: "定位", color: "red" }
      )
    ).toEqual(expect.objectContaining({ kind: "pin", xRatio: 1, yRatio: 0, widthRatio: null, heightRatio: null }));

    expect(
      createAnnotationFromDrag(
        "arrow",
        { xRatio: -1, yRatio: 0.25 },
        { xRatio: 0.8, yRatio: 2 },
        1,
        { message: "方向", color: "blue" }
      )
    ).toEqual(expect.objectContaining({ kind: "arrow", xRatio: 0, yRatio: 0.25, endXRatio: 0.8, endYRatio: 1 }));
  });

  it("keeps minimum-size box annotations inside the page", () => {
    const created = createAnnotationFromDrag(
      "text",
      { xRatio: 1, yRatio: 1 },
      { xRatio: 1, yRatio: 1 },
      1,
      { message: "边缘文字", color: "green" }
    );

    expect((created.xRatio + (created.widthRatio ?? 0))).toBeLessThanOrEqual(1);
    expect((created.yRatio + (created.heightRatio ?? 0))).toBeLessThanOrEqual(1);
    expect(created.widthRatio).toBeGreaterThan(0);
    expect(created.heightRatio).toBeGreaterThan(0);
  });

  it("creates readable text annotations from a short drag", () => {
    const created = createAnnotationFromDrag(
      "text",
      { xRatio: 0.42, yRatio: 0.38 },
      { xRatio: 0.421, yRatio: 0.381 },
      1,
      { message: "这里需要改孔距", color: "red" }
    );

    expect(created.widthRatio).toBeGreaterThanOrEqual(0.055);
    expect(created.widthRatio).toBeLessThan(0.08);
    expect(created.heightRatio).toBeGreaterThanOrEqual(0.028);
    expect(created.heightRatio).toBeLessThan(0.04);
    expect((created.xRatio + (created.widthRatio ?? 0))).toBeLessThanOrEqual(1);
    expect((created.yRatio + (created.heightRatio ?? 0))).toBeLessThanOrEqual(1);
  });

  it("creates cloud annotations from drag bounds", () => {
    const created = createAnnotationFromDrag(
      "cloud",
      { xRatio: 0.72, yRatio: 0.5 },
      { xRatio: 0.52, yRatio: 0.35 },
      1,
      { message: "修订范围", color: "amber" }
    );

    expect(created).toEqual(
      expect.objectContaining({
        kind: "cloud",
        xRatio: 0.52,
        yRatio: 0.35,
        widthRatio: 0.2,
        heightRatio: 0.15,
        color: "amber"
      })
    );
  });

  it("creates a curved SVG path for cloud annotation rendering", () => {
    const path = createCloudAnnotationPath(
      annotation({ kind: "cloud", xRatio: 0.2, yRatio: 0.15, widthRatio: 0.3, heightRatio: 0.16 })
    );

    expect(path.startsWith("M ")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    expect(path.match(/\sQ\s/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
    expect(path).toContain("50 ");
  });

  it("creates ink annotations from normalized points", () => {
    const created = createInkAnnotationFromPoints(
      [
        { xRatio: -0.2, yRatio: 0.2 },
        { xRatio: 0.4, yRatio: 1.4 }
      ],
      2,
      { message: "手画标记", color: "green" }
    );

    expect(created).toEqual(
      expect.objectContaining({
        kind: "ink",
        pageNumber: 2,
        xRatio: 0,
        yRatio: 0.2,
        widthRatio: null,
        heightRatio: null,
        color: "green"
      })
    );
    expect(JSON.parse(created.pointsJson ?? "[]")).toEqual([
      { xRatio: 0, yRatio: 0.2 },
      { xRatio: 0.4, yRatio: 1 }
    ]);
  });

  it("moves box annotations while keeping them inside the page", () => {
    const moved = moveAnnotation(
      annotation({ kind: "rect", xRatio: 0.82, yRatio: 0.86, widthRatio: 0.16, heightRatio: 0.12 }),
      { xRatio: 0.2, yRatio: 0.2 }
    );

    expect(moved.xRatio).toBe(0.84);
    expect(moved.yRatio).toBe(0.88);
    expect(annotationBounds(moved)).toEqual({ left: 0.84, top: 0.88, right: 1, bottom: 1 });
  });

  it("resizes box annotations with minimum size and page bounds", () => {
    const resized = resizeAnnotation(
      annotation({ kind: "text", xRatio: 0.2, yRatio: 0.2, widthRatio: 0.3, heightRatio: 0.12 }),
      "se",
      { xRatio: 0.21, yRatio: 0.21 }
    );

    expect(resized.widthRatio).toBeGreaterThanOrEqual(0.055);
    expect(resized.widthRatio).toBeLessThan(0.08);
    expect(resized.heightRatio).toBeGreaterThanOrEqual(0.028);
    expect(resized.heightRatio).toBeLessThan(0.04);
    expect(annotationBounds(resized).right).toBeLessThanOrEqual(1);
    expect(annotationBounds(resized).bottom).toBeLessThanOrEqual(1);
  });
});

function annotation(input: Partial<ApprovalAnnotation>): ApprovalAnnotation {
  return {
    id: input.id ?? 1,
    approvalId: input.approvalId ?? 1,
    authorUserId: input.authorUserId ?? 1,
    authorUsername: input.authorUsername ?? "supervisor",
    authorDisplayName: input.authorDisplayName ?? "主管",
    authorRole: input.authorRole ?? "supervisor",
    kind: input.kind ?? "rect",
    message: input.message ?? "尺寸需确认",
    pageNumber: input.pageNumber ?? 1,
    xRatio: input.xRatio ?? 0.1,
    yRatio: input.yRatio ?? 0.2,
    widthRatio: input.widthRatio ?? 0.2,
    heightRatio: input.heightRatio ?? 0.1,
    endXRatio: input.endXRatio ?? null,
    endYRatio: input.endYRatio ?? null,
    pointsJson: input.pointsJson ?? null,
    styleJson: input.styleJson ?? null,
    color: input.color ?? "red",
    resolved: input.resolved ?? false,
    resolvedByUserId: input.resolvedByUserId ?? null,
    resolvedAt: input.resolvedAt ?? null,
    createdAt: input.createdAt ?? "2026-06-22T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-06-22T00:00:00.000Z"
  };
}
