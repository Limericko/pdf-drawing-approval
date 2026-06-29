import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type {
  ApprovalAnnotation,
  ApprovalAnnotationColor,
  ApprovalAnnotationInput
} from "../api.ts";
import type { AnnotationResizeHandle, AnnotationTool } from "./PdfAnnotationWorkspace.tsx";
import {
  annotationBounds,
  createAnnotationFromDrag,
  createCloudAnnotationPath,
  createInkAnnotationFromPoints,
  moveAnnotation,
  resizeAnnotation
} from "./PdfAnnotationWorkspace.tsx";

export type RatioPoint = {
  xRatio: number;
  yRatio: number;
};

export type AnnotationDraftAnchor = RatioPoint & {
  pageNumber: number;
  clientX: number;
  clientY: number;
};

type DragState = {
  start: RatioPoint;
  current: RatioPoint;
  points?: RatioPoint[];
};

type EditState = {
  annotation: ApprovalAnnotation;
  mode: "move" | "resize";
  handle?: AnnotationResizeHandle;
  start: RatioPoint;
  preview: ApprovalAnnotationInput;
  changed: boolean;
};

const defaultDraftMessage = "请填写批注内容";
const resizeHandles: AnnotationResizeHandle[] = ["nw", "ne", "sw", "se"];

export function PdfAnnotationLayer({
  annotations,
  pageNumber,
  tool,
  color,
  styleJson,
  draftMessage,
  readOnly,
  onDraftAnnotation,
  onSelectAnnotation,
  selectedAnnotationId,
  onUpdateAnnotationGeometry
}: {
  annotations: ApprovalAnnotation[];
  pageNumber: number;
  tool: AnnotationTool;
  color: ApprovalAnnotationColor;
  styleJson: string | null;
  draftMessage: string;
  readOnly: boolean;
  onDraftAnnotation?: (annotation: ApprovalAnnotationInput, anchor: AnnotationDraftAnchor) => void;
  onSelectAnnotation?: (annotation: ApprovalAnnotation) => void;
  selectedAnnotationId?: number | null;
  onUpdateAnnotationGeometry?: (annotation: ApprovalAnnotation, input: ApprovalAnnotationInput) => void;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);

  function toRatioPoint(event: { clientX: number; clientY: number }): RatioPoint {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { xRatio: 0, yRatio: 0 };
    return {
      xRatio: (event.clientX - rect.left) / rect.width,
      yRatio: (event.clientY - rect.top) / rect.height
    };
  }

  function anchorFor(point: RatioPoint, event: { clientX: number; clientY: number }): AnnotationDraftAnchor {
    return {
      ...point,
      pageNumber,
      clientX: event.clientX,
      clientY: event.clientY
    };
  }

  function startDraft(event: ReactPointerEvent<HTMLDivElement>) {
    if (readOnly || tool === "select" || !onDraftAnnotation) return;
    const start = toRatioPoint(event);
    if (tool === "pin") {
      onDraftAnnotation(
        createAnnotationFromDrag(tool, start, start, pageNumber, { message: draftMessage || defaultDraftMessage, color, styleJson }),
        anchorFor(start, event)
      );
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ start, current: start, points: tool === "ink" ? [start] : undefined });
  }

  function moveDraft(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag || readOnly || tool === "select" || tool === "pin") return;
    event.preventDefault();
    const nextPoint = toRatioPoint(event);
    setDrag((previous) => {
      if (!previous) return previous;
      if (tool !== "ink") return { ...previous, current: nextPoint };
      const points = previous.points ?? [previous.start];
      const lastPoint = points[points.length - 1];
      const shouldAppend = distanceBetween(lastPoint, nextPoint) >= 0.0025;
      return {
        ...previous,
        current: nextPoint,
        points: shouldAppend ? [...points, nextPoint] : points
      };
    });
  }

  function completeDraft(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag || readOnly || tool === "select" || tool === "pin" || !onDraftAnnotation) {
      setDrag(null);
      return;
    }
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const end = toRatioPoint(event);
    if (tool === "ink") {
      const points = [...(drag.points ?? [drag.start]), end];
      if (points.length >= 2) {
        onDraftAnnotation(
          createInkAnnotationFromPoints(points, pageNumber, { message: draftMessage || defaultDraftMessage, color, styleJson }),
          anchorFor(end, event)
        );
      }
      setDrag(null);
      return;
    }
    onDraftAnnotation(
      createAnnotationFromDrag(tool, drag.start, end, pageNumber, { message: draftMessage || defaultDraftMessage, color, styleJson }),
      anchorFor(end, event)
    );
    setDrag(null);
  }

  function startMove(annotation: ApprovalAnnotation, event: ReactPointerEvent<HTMLElement>) {
    onSelectAnnotation?.(annotation);
    if (readOnly || !onUpdateAnnotationGeometry || selectedAnnotationId !== annotation.id || annotation.resolved) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = toRatioPoint(event);
    setEdit({
      annotation,
      mode: "move",
      start,
      preview: moveAnnotation(annotation, { xRatio: 0, yRatio: 0 }),
      changed: false
    });
  }

  function startResize(annotation: ApprovalAnnotation, handle: AnnotationResizeHandle, event: ReactPointerEvent<HTMLElement>) {
    if (readOnly || !onUpdateAnnotationGeometry || selectedAnnotationId !== annotation.id || annotation.resolved) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = toRatioPoint(event);
    setEdit({
      annotation,
      mode: "resize",
      handle,
      start,
      preview: resizeAnnotation(annotation, handle, start),
      changed: false
    });
  }

  function moveEdit(event: ReactPointerEvent<HTMLElement>) {
    if (!edit) return;
    event.preventDefault();
    const point = toRatioPoint(event);
    const preview =
      edit.mode === "move"
        ? moveAnnotation(edit.annotation, {
            xRatio: point.xRatio - edit.start.xRatio,
            yRatio: point.yRatio - edit.start.yRatio
          })
        : resizeAnnotation(edit.annotation, edit.handle ?? "se", point);
    const changed = distanceBetween(point, edit.start) >= 0.001;
    setEdit((current) => (current ? { ...current, preview, changed: current.changed || changed } : current));
  }

  function completeEdit(event: ReactPointerEvent<HTMLElement>) {
    if (!edit) return;
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!edit.changed) {
      setEdit(null);
      return;
    }
    onUpdateAnnotationGeometry?.(edit.annotation, edit.preview);
    setEdit(null);
  }

  const draftAnnotation = createDraftAnnotation(drag, tool, pageNumber, draftMessage || defaultDraftMessage, color, styleJson);
  const renderedAnnotations = edit
    ? annotations.map((annotation) =>
        annotation.id === edit.annotation.id ? applyInputToAnnotation(annotation, edit.preview) : annotation
      )
    : annotations;

  return (
    <div
      ref={layerRef}
      className={`pdf-annotation-layer ${readOnly || tool === "select" ? "pdf-annotation-layer--readonly" : ""}`}
      onPointerDown={startDraft}
      onPointerMove={moveDraft}
      onPointerUp={completeDraft}
      onPointerCancel={() => setDrag(null)}
    >
      <svg className="pdf-annotation-arrow-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <defs>
          {renderedAnnotations
            .filter((annotation) => annotation.kind === "arrow")
            .map((annotation) => (
              <marker
                key={annotationArrowMarkerId(annotation)}
                id={annotationArrowMarkerId(annotation)}
                className={`pdf-annotation-tone--${annotation.color}`}
                style={annotationToneStyle(annotation)}
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="3.5"
                orient="auto"
              >
                <path d="M0,0 L8,3.5 L0,7 Z" />
              </marker>
            ))}
          {draftAnnotation?.kind === "arrow" && (
            <marker
              id={annotationArrowMarkerId(draftAnnotation)}
              className={`pdf-annotation-tone--${draftAnnotation.color}`}
              style={annotationToneStyle(draftAnnotation)}
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="3.5"
              orient="auto"
            >
              <path d="M0,0 L8,3.5 L0,7 Z" />
            </marker>
          )}
        </defs>
        {renderedAnnotations
          .filter((annotation) => annotation.kind === "arrow")
          .map((annotation) => (
            <line
              key={annotation.id}
              className={`pdf-annotation-arrow pdf-annotation-tone--${annotation.color}`}
              style={annotationToneStyle(annotation)}
              x1={`${annotation.xRatio * 100}%`}
              y1={`${annotation.yRatio * 100}%`}
              x2={`${(annotation.endXRatio ?? annotation.xRatio) * 100}%`}
              y2={`${(annotation.endYRatio ?? annotation.yRatio) * 100}%`}
              markerEnd={`url(#${annotationArrowMarkerId(annotation)})`}
            />
          ))}
        {renderedAnnotations
          .filter((annotation) => annotation.kind === "ink")
          .map((annotation) => (
            <polyline
              key={annotation.id}
              className={`pdf-annotation-ink pdf-annotation-tone--${annotation.color}`}
              style={annotationToneStyle(annotation)}
              points={pointsToPolyline(annotation.pointsJson)}
            />
          ))}
        {renderedAnnotations
          .filter((annotation) => annotation.kind === "cloud")
          .map((annotation) => (
            <path
              key={annotation.id}
              className={`pdf-annotation-cloud pdf-annotation-tone--${annotation.color}`}
              style={annotationToneStyle(annotation)}
              d={createCloudAnnotationPath(annotation)}
            />
          ))}
        {draftAnnotation?.kind === "arrow" && (
          <line
            className={`pdf-annotation-arrow pdf-annotation-draft pdf-annotation-tone--${draftAnnotation.color}`}
            style={annotationToneStyle(draftAnnotation)}
            x1={`${draftAnnotation.xRatio * 100}%`}
            y1={`${draftAnnotation.yRatio * 100}%`}
            x2={`${(draftAnnotation.endXRatio ?? draftAnnotation.xRatio) * 100}%`}
            y2={`${(draftAnnotation.endYRatio ?? draftAnnotation.yRatio) * 100}%`}
            markerEnd={`url(#${annotationArrowMarkerId(draftAnnotation)})`}
          />
        )}
        {draftAnnotation?.kind === "ink" && (
          <polyline
            className={`pdf-annotation-ink pdf-annotation-draft-line pdf-annotation-tone--${draftAnnotation.color}`}
            style={annotationToneStyle(draftAnnotation)}
            points={pointsToPolyline(draftAnnotation.pointsJson)}
          />
        )}
        {draftAnnotation?.kind === "cloud" && (
          <path
            className={`pdf-annotation-cloud pdf-annotation-draft-line pdf-annotation-tone--${draftAnnotation.color}`}
            style={annotationToneStyle(draftAnnotation)}
            d={createCloudAnnotationPath(draftAnnotation)}
          />
        )}
      </svg>
      {renderedAnnotations.map((annotation, index) => (
        <AnnotationMarker
          key={annotation.id}
          annotation={annotation}
          sequence={index + 1}
          selected={selectedAnnotationId === annotation.id}
          readOnly={readOnly || !onUpdateAnnotationGeometry}
          onSelect={onSelectAnnotation}
          onStartMove={startMove}
          onStartResize={startResize}
          onMoveEdit={moveEdit}
          onCompleteEdit={completeEdit}
        />
      ))}
      {draftAnnotation && draftAnnotation.kind !== "arrow" && draftAnnotation.kind !== "ink" && draftAnnotation.kind !== "cloud" && (
        <DraftMarker annotation={draftAnnotation} />
      )}
    </div>
  );
}

function DraftMarker({ annotation }: { annotation: ApprovalAnnotationInput }) {
  return (
    <span
      className={[
        "pdf-annotation-draft",
        `pdf-annotation-draft--${annotation.kind}`,
        `pdf-annotation-tone--${annotation.color ?? "red"}`
      ].join(" ")}
      style={{
        ...annotationToneStyle(annotation),
        left: `${annotation.xRatio * 100}%`,
        top: `${annotation.yRatio * 100}%`,
        width: `${(annotation.widthRatio ?? 0) * 100}%`,
        height: `${(annotation.heightRatio ?? 0) * 100}%`
      }}
    >
      {annotation.kind === "text" ? annotation.message : ""}
    </span>
  );
}

function AnnotationMarker({
  annotation,
  sequence,
  selected,
  readOnly,
  onSelect,
  onStartMove,
  onStartResize,
  onMoveEdit,
  onCompleteEdit
}: {
  annotation: ApprovalAnnotation;
  sequence: number;
  selected: boolean;
  readOnly: boolean;
  onSelect?: (annotation: ApprovalAnnotation) => void;
  onStartMove: (annotation: ApprovalAnnotation, event: ReactPointerEvent<HTMLElement>) => void;
  onStartResize: (annotation: ApprovalAnnotation, handle: AnnotationResizeHandle, event: ReactPointerEvent<HTMLElement>) => void;
  onMoveEdit: (event: ReactPointerEvent<HTMLElement>) => void;
  onCompleteEdit: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const className = [
    "pdf-annotation-marker",
    `pdf-annotation-marker--${annotation.kind}`,
    `pdf-annotation-tone--${annotation.color}`,
    selected ? "pdf-annotation-marker--selected" : "",
    annotation.resolved ? "pdf-annotation-marker--resolved" : ""
  ]
    .filter(Boolean)
    .join(" ");
  const isBox = isBoxAnnotation(annotation);

  if (annotation.kind === "pin" || annotation.kind === "arrow") {
    return (
      <button
        type="button"
        data-annotation-id={annotation.id}
        className={className}
        style={{ ...annotationToneStyle(annotation), left: `${annotation.xRatio * 100}%`, top: `${annotation.yRatio * 100}%` }}
        title={annotation.message}
        onPointerDown={(event) => {
          event.stopPropagation();
          onStartMove(annotation, event);
        }}
        onPointerMove={onMoveEdit}
        onPointerUp={onCompleteEdit}
        onPointerCancel={onCompleteEdit}
        onClick={() => onSelect?.(annotation)}
      >
        {sequence}
        {selected && <strong className="pdf-annotation-callout">{annotation.message}</strong>}
      </button>
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      data-annotation-id={annotation.id}
      className={className}
      style={{
        ...annotationToneStyle(annotation),
        left: `${annotation.xRatio * 100}%`,
        top: `${annotation.yRatio * 100}%`,
        width: `${(annotation.widthRatio ?? 0) * 100}%`,
        height: `${(annotation.heightRatio ?? 0) * 100}%`
      }}
      title={annotation.message}
      onPointerDown={(event) => {
        event.stopPropagation();
        onStartMove(annotation, event);
      }}
      onPointerMove={onMoveEdit}
      onPointerUp={onCompleteEdit}
      onPointerCancel={onCompleteEdit}
      onClick={() => onSelect?.(annotation)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect?.(annotation);
      }}
    >
      <span>{sequence}</span>
      {annotation.kind === "text" && <em>{annotation.message}</em>}
      {selected && <strong className="pdf-annotation-callout">{annotation.message}</strong>}
      {selected &&
        !readOnly &&
        isBox &&
        resizeHandles.map((handle) => (
          <i
            key={handle}
            className={`pdf-annotation-resize-handle pdf-annotation-resize-handle--${handle}`}
            role="button"
            tabIndex={0}
            aria-label={`调整 ${handle}`}
            onPointerDown={(event) => onStartResize(annotation, handle, event)}
            onPointerMove={onMoveEdit}
            onPointerUp={onCompleteEdit}
            onPointerCancel={onCompleteEdit}
          />
        ))}
    </span>
  );
}

function createDraftAnnotation(
  drag: DragState | null,
  tool: AnnotationTool,
  pageNumber: number,
  message: string,
  color: ApprovalAnnotationColor,
  styleJson: string | null
) {
  if (!drag || tool === "select" || tool === "pin") return null;
  if (tool === "ink") {
    const points = drag.points && drag.points.length >= 2 ? drag.points : [drag.start, drag.current];
    return createInkAnnotationFromPoints(points, pageNumber, { message, color, styleJson });
  }
  return createAnnotationFromDrag(tool, drag.start, drag.current, pageNumber, { message, color, styleJson });
}

function applyInputToAnnotation(annotation: ApprovalAnnotation, input: ApprovalAnnotationInput): ApprovalAnnotation {
  return {
    ...annotation,
    kind: input.kind,
    message: input.message,
    pageNumber: input.pageNumber,
    xRatio: input.xRatio,
    yRatio: input.yRatio,
    widthRatio: input.widthRatio ?? null,
    heightRatio: input.heightRatio ?? null,
    endXRatio: input.endXRatio ?? null,
    endYRatio: input.endYRatio ?? null,
    pointsJson: input.pointsJson ?? null,
    styleJson: input.styleJson ?? null,
    color: input.color ?? annotation.color
  };
}

function isBoxAnnotation(annotation: ApprovalAnnotation) {
  const bounds = annotationBounds(annotation);
  return (
    (annotation.kind === "rect" || annotation.kind === "circle" || annotation.kind === "text" || annotation.kind === "cloud") &&
    bounds.right > bounds.left &&
    bounds.bottom > bounds.top
  );
}

function pointsToPolyline(pointsJson: string | null | undefined) {
  return parseAnnotationPoints(pointsJson)
    .map((point) => `${point.xRatio * 100},${point.yRatio * 100}`)
    .join(" ");
}

function annotationArrowMarkerId(annotation: Pick<ApprovalAnnotation, "id" | "pageNumber"> | Pick<ApprovalAnnotationInput, "pageNumber">) {
  return `annotation-arrow-${annotation.pageNumber}-${"id" in annotation ? annotation.id : "draft"}`;
}

export function annotationToneStyle(annotation: Pick<ApprovalAnnotation | ApprovalAnnotationInput, "color" | "styleJson">): CSSProperties {
  const strokeColor = annotation.color === "custom" ? parseStrokeColor(annotation.styleJson) : null;
  return strokeColor ? ({ "--annotation-tone": strokeColor, color: "var(--annotation-tone)" } as CSSProperties) : {};
}

function parseStrokeColor(styleJson: string | null | undefined) {
  if (!styleJson) return null;
  try {
    const parsed = JSON.parse(styleJson) as { strokeColor?: unknown };
    return typeof parsed.strokeColor === "string" && /^#[0-9a-fA-F]{6}$/.test(parsed.strokeColor) ? parsed.strokeColor : null;
  } catch {
    return null;
  }
}

function parseAnnotationPoints(pointsJson: string | null | undefined): RatioPoint[] {
  if (!pointsJson) return [];
  try {
    const parsed = JSON.parse(pointsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((point): point is Partial<RatioPoint> => Boolean(point) && typeof point === "object")
      .filter((point) => typeof point.xRatio === "number" && typeof point.yRatio === "number")
      .map((point) => ({
        xRatio: clamp(point.xRatio!, 0, 1),
        yRatio: clamp(point.yRatio!, 0, 1)
      }));
  } catch {
    return [];
  }
}

function distanceBetween(a: RatioPoint, b: RatioPoint) {
  return Math.hypot(a.xRatio - b.xRatio, a.yRatio - b.yRatio);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
