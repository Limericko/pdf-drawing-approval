import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SignaturePlacement } from "../api.ts";
import { mergePagePlacements, placementsForPage } from "./PdfSignaturePlacementWorkspace.tsx";

const placements: SignaturePlacement[] = [
  { role: "designer", pageNumber: 1, xRatio: 0.1, yRatio: 0.2, widthRatio: 0.1, heightRatio: 0.05 },
  { role: "supervisor", pageNumber: 2, xRatio: 0.3, yRatio: 0.4, widthRatio: 0.1, heightRatio: 0.05 },
  { role: "process", pageNumber: 1, xRatio: 0.5, yRatio: 0.6, widthRatio: 0.1, heightRatio: 0.05 }
];

describe("PDF signature placement workspace page mapping", () => {
  it("loads the legacy pdf.js build for browsers without Uint8Array toHex", () => {
    const source = fs.readFileSync(path.resolve("src/client/widgets/PdfSignaturePlacementWorkspace.tsx"), "utf8");

    expect(source).toContain('import("pdfjs-dist/legacy/build/pdf.mjs")');
    expect(source).toContain('import("pdfjs-dist/legacy/build/pdf.worker.mjs?url")');
    expect(source).not.toContain('import("pdfjs-dist")');
    expect(source).not.toContain('import("pdfjs-dist/build/pdf.worker.mjs?url")');
  });

  it("wires shared PDF viewport controls into the signature placement preview", () => {
    const source = fs.readFileSync(path.resolve("src/client/widgets/PdfSignaturePlacementWorkspace.tsx"), "utf8");

    expect(source).toContain("PdfViewportToolbar");
    expect(source).toContain("pdfPageWidthStyle");
    expect(source).toContain("createPdfViewportWheelHandler");
    expect(source).toContain("pdfViewportWheelListenerOptions");
    expect(source).toContain('addEventListener("wheel"');
    expect(source).toContain('removeEventListener("wheel"');
    expect(source).toContain("onPointerDownCapture={startPdfPan}");
    expect(source).not.toContain("onWheel={onPdfViewportWheel}");
    expect(source).toContain("className={pdfViewportScrollClassName");
  });

  it("offers page navigation without removing viewport wheel and pan wiring", () => {
    const source = fs.readFileSync(path.resolve("src/client/widgets/PdfSignaturePlacementWorkspace.tsx"), "utf8");

    expect(source).toContain("pageRefs");
    expect(source).toContain("jumpToPage");
    expect(source).toContain("scrollIntoView({ block: \"start\"");
    expect(source).toContain('aria-label="上一页"');
    expect(source).toContain('aria-label="下一页"');
    expect(source).toContain('className="pdf-page-thumbnails"');
    expect(source).toContain('aria-label={`跳转到第 ${pageNumber} 页`');
    expect(source).toContain("pdf-page-thumbnail--active");
    expect(source).toContain('addEventListener("wheel"');
    expect(source).toContain("onPointerDownCapture={startPdfPan}");
  });

  it("filters signature placements by PDF page", () => {
    expect(placementsForPage(placements, 1).map((placement) => placement.role)).toEqual(["designer", "process"]);
    expect(placementsForPage(placements, 2).map((placement) => placement.role)).toEqual(["supervisor"]);
  });

  it("merges edited placements back into their page without moving other pages", () => {
    const next = mergePagePlacements(placements, 1, [
      { ...placements[0], xRatio: 0.7 },
      { ...placements[2], yRatio: 0.8 }
    ]);

    expect(next).toEqual([
      { ...placements[0], xRatio: 0.7 },
      placements[1],
      { ...placements[2], yRatio: 0.8 }
    ]);
  });
});
