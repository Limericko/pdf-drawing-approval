import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import styles from "./ResizableInspectorPane.module.css";

export const pdfInspectorWidthStorageKey = "pdf-studio.inspector-width";
export const pdfInspectorMinimumWidth = 280;
export const pdfInspectorMaximumWidth = 480;
const compactDesktopMaximum = 1280;
const compactDesktopDefault = 280;
const wideDesktopDefault = 320;
const keyboardStep = 16;

export function defaultPdfInspectorWidth(viewportWidth: number) {
  return viewportWidth <= compactDesktopMaximum ? compactDesktopDefault : wideDesktopDefault;
}

export function clampPdfInspectorWidth(width: number, viewportWidth: number) {
  const viewportMaximum = Math.max(pdfInspectorMinimumWidth, Math.floor(viewportWidth * 0.4));
  return Math.min(pdfInspectorMaximumWidth, viewportMaximum, Math.max(pdfInspectorMinimumWidth, Math.round(width)));
}

export function readPdfInspectorWidth(storage: Pick<Storage, "getItem">, viewportWidth: number) {
  const saved = Number(storage.getItem(pdfInspectorWidthStorageKey));
  return clampPdfInspectorWidth(Number.isFinite(saved) && saved > 0 ? saved : defaultPdfInspectorWidth(viewportWidth), viewportWidth);
}

export function usePersistentPdfInspectorWidth() {
  const customized = useRef(
    typeof window !== "undefined" && Number(window.localStorage.getItem(pdfInspectorWidthStorageKey)) > 0
  );
  const [width, setWidthState] = useState(() => {
    if (typeof window === "undefined") return wideDesktopDefault;
    return readPdfInspectorWidth(window.localStorage, window.innerWidth);
  });

  useEffect(() => {
    const onResize = () => setWidthState((current) =>
      customized.current
        ? clampPdfInspectorWidth(current, window.innerWidth)
        : defaultPdfInspectorWidth(window.innerWidth)
    );
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function setWidth(nextWidth: number) {
    const next = clampPdfInspectorWidth(nextWidth, window.innerWidth);
    customized.current = true;
    setWidthState(next);
    window.localStorage.setItem(pdfInspectorWidthStorageKey, String(next));
  }

  return { width, setWidth };
}

export function ResizableInspectorHandle({ width, onWidthChange }: { width: number; onWidthChange: (width: number) => void }) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    setDragging(true);
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    event.preventDefault();
    onWidthChange(drag.current.startWidth - (event.clientX - drag.current.startX));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    if (event.currentTarget.hasPointerCapture(drag.current.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.current.pointerId);
    }
    drag.current = null;
    setDragging(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const direction = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    if (direction !== 0) {
      event.preventDefault();
      onWidthChange(width + direction * keyboardStep);
    } else if (event.key === "Home") {
      event.preventDefault();
      onWidthChange(pdfInspectorMinimumWidth);
    } else if (event.key === "End") {
      event.preventDefault();
      onWidthChange(pdfInspectorMaximumWidth);
    }
  }

  return (
    <div
      className={styles.handle}
      role="separator"
      aria-label="调整审阅检查器宽度"
      aria-orientation="vertical"
      aria-valuemin={pdfInspectorMinimumWidth}
      aria-valuemax={pdfInspectorMaximumWidth}
      aria-valuenow={width}
      tabIndex={0}
      data-dragging={dragging}
      onKeyDown={onKeyDown}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
