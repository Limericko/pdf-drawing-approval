import { describe, expect, it } from "vitest";
import {
  createPdfViewportWheelHandler,
  createPdfViewportState,
  pdfViewportWheelListenerOptions,
  pdfPageWidthStyle,
  pdfViewportZoomLabel,
  updatePdfViewportZoom,
  zoomPdfViewportFromWheel
} from "./PdfViewportControls.tsx";

describe("PDF viewport controls", () => {
  it("starts in fit-width mode with a readable zoom label", () => {
    const state = createPdfViewportState();

    expect(state).toEqual({ mode: "fit-width", zoom: 1, panMode: false });
    expect(pdfViewportZoomLabel(state)).toBe("适宽");
    expect(pdfPageWidthStyle(state)).toBeUndefined();
  });

  it("updates manual zoom with clamped limits", () => {
    expect(updatePdfViewportZoom(createPdfViewportState(), "in").zoom).toBe(1.1);
    expect(updatePdfViewportZoom({ mode: "manual", zoom: 3, panMode: false }, "in").zoom).toBe(3);
    expect(updatePdfViewportZoom({ mode: "manual", zoom: 0.5, panMode: false }, "out").zoom).toBe(0.5);
  });

  it("returns to 100 percent and fit-width modes explicitly", () => {
    const zoomed = updatePdfViewportZoom(createPdfViewportState(), "in");

    expect(updatePdfViewportZoom(zoomed, "reset")).toEqual({ mode: "manual", zoom: 1, panMode: false });
    expect(updatePdfViewportZoom(zoomed, "fit")).toEqual({ mode: "fit-width", zoom: 1, panMode: false });
    expect(updatePdfViewportZoom(zoomed, "fit-height")).toEqual({ mode: "fit-height", zoom: 1, panMode: false });
    expect(pdfViewportZoomLabel({ mode: "fit-height", zoom: 1, panMode: false })).toBe("适高");
  });

  it("calculates manual page width without changing ratio-based overlays", () => {
    const state = { mode: "manual" as const, zoom: 1.25, panMode: false };

    expect(pdfViewportZoomLabel(state)).toBe("125%");
    expect(pdfPageWidthStyle(state)).toEqual({ "--pdf-page-width": "1200px" });
  });

  it("zooms only when the wheel event includes Ctrl", () => {
    const state = createPdfViewportState();

    expect(zoomPdfViewportFromWheel(state, { ctrlKey: false, deltaY: -100 })).toBe(state);
    expect(zoomPdfViewportFromWheel(state, { ctrlKey: true, deltaY: -100 })).toEqual({
      mode: "manual",
      zoom: 1.1,
      panMode: false
    });
    expect(zoomPdfViewportFromWheel({ mode: "manual", zoom: 1.1, panMode: false }, { ctrlKey: true, deltaY: 100 })).toEqual({
      mode: "manual",
      zoom: 1,
      panMode: false
    });
  });

  it("uses a native non-passive capture wheel listener so browser page zoom is blocked first", () => {
    expect(pdfViewportWheelListenerOptions).toEqual({ capture: true, passive: false });

    let state = createPdfViewportState();
    const preventDefaultCalls: string[] = [];
    const handler = createPdfViewportWheelHandler(
      () => state,
      (next) => {
        state = next;
      }
    );

    handler({
      ctrlKey: true,
      deltaY: -100,
      preventDefault: () => preventDefaultCalls.push("prevented")
    });

    expect(preventDefaultCalls).toEqual(["prevented"]);
    expect(state).toEqual({ mode: "manual", zoom: 1.1, panMode: false });
  });

  it("does not block ordinary wheel scrolling in the PDF viewer", () => {
    let state = createPdfViewportState();
    const preventDefaultCalls: string[] = [];
    const handler = createPdfViewportWheelHandler(
      () => state,
      (next) => {
        state = next;
      }
    );

    handler({
      ctrlKey: false,
      deltaY: -100,
      preventDefault: () => preventDefaultCalls.push("prevented")
    });

    expect(preventDefaultCalls).toEqual([]);
    expect(state).toEqual(createPdfViewportState());
  });
});
