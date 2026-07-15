import type { CSSProperties } from "react";
import { Hand, Maximize2, Minus, Plus, RotateCcw, StretchVertical } from "lucide-react";
import styles from "../features/pdf-studio/PdfViewportControls.module.css";

export type PdfViewportMode = "fit-width" | "fit-height" | "manual";

export type PdfViewportState = {
  mode: PdfViewportMode;
  zoom: number;
  panMode: boolean;
};

export type PdfViewportZoomAction = "in" | "out" | "reset" | "fit" | "fit-height";
export type PdfViewportWheelEvent = Pick<WheelEvent, "ctrlKey" | "deltaY" | "preventDefault">;

export const pdfViewportWheelListenerOptions = { capture: true, passive: false } as const;

const basePageWidthPx = 960;
const minimumZoom = 0.5;
const maximumZoom = 3;
const zoomStep = 0.1;

type PageWidthStyle = CSSProperties & {
  "--pdf-page-width"?: string;
};

export function createPdfViewportState(): PdfViewportState {
  return { mode: "fit-width", zoom: 1, panMode: false };
}

export function updatePdfViewportZoom(state: PdfViewportState, action: PdfViewportZoomAction): PdfViewportState {
  if (action === "fit") return { ...state, mode: "fit-width", zoom: 1 };
  if (action === "fit-height") return { ...state, mode: "fit-height", zoom: 1 };
  if (action === "reset") return { ...state, mode: "manual", zoom: 1 };

  const direction = action === "in" ? 1 : -1;
  return {
    ...state,
    mode: "manual",
    zoom: normalizeZoom(state.zoom + direction * zoomStep)
  };
}

export function setPdfViewportPanMode(state: PdfViewportState, panMode: boolean): PdfViewportState {
  return { ...state, panMode };
}

export function zoomPdfViewportFromWheel(
  state: PdfViewportState,
  event: Pick<WheelEvent, "ctrlKey" | "deltaY">
): PdfViewportState {
  if (!event.ctrlKey) return state;
  return updatePdfViewportZoom(state, event.deltaY < 0 ? "in" : "out");
}

export function createPdfViewportWheelHandler(
  getState: () => PdfViewportState,
  onChange: (state: PdfViewportState) => void
) {
  return (event: PdfViewportWheelEvent) => {
    if (!event.ctrlKey) return;

    event.preventDefault();
    const current = getState();
    const next = zoomPdfViewportFromWheel(current, event);
    if (next !== current) onChange(next);
  };
}

export function pdfViewportZoomLabel(state: PdfViewportState) {
  if (state.mode === "fit-width") return "适宽";
  if (state.mode === "fit-height") return "适高";
  return `${Math.round(state.zoom * 100)}%`;
}

export function pdfPageWidthStyle(state: PdfViewportState): PageWidthStyle | undefined {
  if (state.mode === "fit-width") return undefined;
  if (state.mode === "fit-height") {
    return {
      width: "auto",
      maxWidth: "100%",
      height: "calc(100% - 28px)"
    };
  }
  return { "--pdf-page-width": `${Math.round(basePageWidthPx * state.zoom)}px` };
}

export function PdfViewportToolbar({
  state,
  onChange
}: {
  state: PdfViewportState;
  onChange: (state: PdfViewportState) => void;
}) {
  return (
    <div className={styles.toolbar} aria-label="PDF 视图控制">
      <button type="button" title="缩小" aria-label="缩小 PDF" onClick={() => onChange(updatePdfViewportZoom(state, "out"))}>
        <Minus size={16} aria-hidden="true" />
      </button>
      <strong className={styles.zoom}>{pdfViewportZoomLabel(state)}</strong>
      <button type="button" title="放大" aria-label="放大 PDF" onClick={() => onChange(updatePdfViewportZoom(state, "in"))}>
        <Plus size={16} aria-hidden="true" />
      </button>
      <button type="button" title="100%" aria-label="按 100% 显示 PDF" onClick={() => onChange(updatePdfViewportZoom(state, "reset"))}>
        <RotateCcw size={16} aria-hidden="true" />
      </button>
      <button type="button" title="适配宽度" aria-label="适配宽度显示 PDF" onClick={() => onChange(updatePdfViewportZoom(state, "fit"))}>
        <Maximize2 size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        title="适配高度"
        aria-label="适配高度显示 PDF"
        onClick={() => onChange(updatePdfViewportZoom(state, "fit-height"))}
      >
        <StretchVertical size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        title="拖动浏览"
        aria-label="拖动浏览 PDF"
        aria-pressed={state.panMode}
        data-active={state.panMode}
        onClick={() => onChange(setPdfViewportPanMode(state, !state.panMode))}
      >
        <Hand size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function normalizeZoom(value: number) {
  return Math.round(Math.min(maximumZoom, Math.max(minimumZoom, value)) * 10) / 10;
}
