import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask
} from "pdfjs-dist";
import { Maximize, PanelLeftOpen } from "lucide-react";
import type {
  ApprovalAnnotation,
  ApprovalAnnotationColor,
  ApprovalAnnotationInput,
  ApprovalAnnotationKind
} from "../api.ts";
import { PdfAnnotationLayer, type AnnotationDraftAnchor, type RatioPoint } from "./PdfAnnotationLayer.tsx";
import {
  createPdfViewportWheelHandler,
  createPdfViewportState,
  pdfPageWidthStyle,
  pdfViewportWheelListenerOptions,
  PdfViewportToolbar
} from "./PdfViewportControls.tsx";
import studioStyles from "../features/pdf-studio/PdfCanvasViewport.module.css";
import { IconButton } from "../ui/actions/index.tsx";

export type AnnotationTool = "select" | "pin" | "rect" | "arrow" | "circle" | "text" | "ink" | "cloud";
export type AnnotationResizeHandle = "nw" | "ne" | "sw" | "se";

type AnnotationGeometry = Pick<
  ApprovalAnnotation | ApprovalAnnotationInput,
  | "kind"
  | "message"
  | "pageNumber"
  | "xRatio"
  | "yRatio"
  | "widthRatio"
  | "heightRatio"
  | "endXRatio"
  | "endYRatio"
  | "pointsJson"
  | "styleJson"
  | "color"
>;

type PdfPanState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
};

export function PdfAnnotationWorkspace({
  pdfUrl,
  annotations,
  tool = "select",
  color = "red",
  styleJson = null,
  draftMessage = "请填写批注内容",
  readOnly = false,
  onDraftAnnotation,
  onSelectAnnotation,
  selectedAnnotationId = null,
  annotationScrollRequest = 0,
  onUpdateAnnotationGeometry,
  pageIssueCounts = {}
}: {
  pdfUrl: string;
  annotations: ApprovalAnnotation[];
  tool?: AnnotationTool;
  color?: ApprovalAnnotationColor;
  styleJson?: string | null;
  draftMessage?: string;
  readOnly?: boolean;
  onDraftAnnotation?: (annotation: ApprovalAnnotationInput, anchor: AnnotationDraftAnchor) => void;
  onSelectAnnotation?: (annotation: ApprovalAnnotation) => void;
  selectedAnnotationId?: number | null;
  annotationScrollRequest?: number;
  onUpdateAnnotationGeometry?: (annotation: ApprovalAnnotation, input: ApprovalAnnotationInput) => void;
  pageIssueCounts?: Readonly<Record<number, number>>;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const panRef = useRef<PdfPanState | null>(null);
  const viewportRef = useRef(createPdfViewportState());
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [viewport, setViewport] = useState(createPdfViewportState);
  const [currentPage, setCurrentPage] = useState(1);
  const [panning, setPanning] = useState(false);
  const [thumbnailRailOpen, setThumbnailRailOpen] = useState(false);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    const wheelHandler = createPdfViewportWheelHandler(() => viewportRef.current, setViewport);
    scrollElement.addEventListener("wheel", wheelHandler, pdfViewportWheelListenerOptions);
    return () => {
      scrollElement.removeEventListener("wheel", wheelHandler, pdfViewportWheelListenerOptions);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    async function loadPdf() {
      setStatus("loading");
      setError("");
      setPdf(null);
      setPageCount(0);

      try {
        const [pdfjs, worker] = await Promise.all([
          import("pdfjs-dist/legacy/build/pdf.mjs"),
          import("pdfjs-dist/legacy/build/pdf.worker.mjs?url")
        ]);
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        loadingTask = pdfjs.getDocument({ url: pdfUrl });
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }

        const nextPdf = await loadingTask.promise;

        if (cancelled) {
          void loadingTask.destroy();
          return;
        }

        setPdf(nextPdf);
        setPageCount(nextPdf.numPages);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "PDF 加载失败");
      }
    }

    void loadPdf();

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [pdfUrl]);

  const pageNumbers = useMemo(
    () => Array.from({ length: pageCount }, (_, index) => index + 1),
    [pageCount]
  );
  const selectedAnnotationRenderKey = useMemo(() => {
    const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId);
    return selectedAnnotation
      ? `${selectedAnnotation.id}:${selectedAnnotation.pageNumber}:${selectedAnnotation.updatedAt}:${selectedAnnotation.resolved ? 1 : 0}`
      : "";
  }, [annotations, selectedAnnotationId]);

  useEffect(() => {
    if (status !== "ready") return;
    scrollAnnotationIntoView(scrollRef.current, selectedAnnotationId);
  }, [status, selectedAnnotationId, selectedAnnotationRenderKey, annotationScrollRequest]);

  const pageWidthStyle = pdfPageWidthStyle(viewport);
  function startPdfPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (!viewport.panMode || event.button !== 0 || !scrollRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: scrollRef.current.scrollLeft,
      scrollTop: scrollRef.current.scrollTop
    };
    setPanning(true);
  }

  function movePdfPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (!panRef.current || !scrollRef.current) return;
    event.preventDefault();
    scrollRef.current.scrollLeft = panRef.current.scrollLeft - (event.clientX - panRef.current.startX);
    scrollRef.current.scrollTop = panRef.current.scrollTop - (event.clientY - panRef.current.startY);
  }

  function endPdfPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (!panRef.current) return;
    if (event.currentTarget.hasPointerCapture(panRef.current.pointerId)) {
      event.currentTarget.releasePointerCapture(panRef.current.pointerId);
    }
    panRef.current = null;
    setPanning(false);
  }

  function setPageRef(pageNumber: number, node: HTMLDivElement | null) {
    if (node) pageRefs.current.set(pageNumber, node);
    else pageRefs.current.delete(pageNumber);
  }

  function jumpToPage(pageNumber: number) {
    const nextPage = clampPage(pageNumber, pageCount);
    setCurrentPage(nextPage);
    pageRefs.current.get(nextPage)?.scrollIntoView({ block: "start", inline: "nearest", behavior: "smooth" });
  }

  function syncCurrentPageFromScroll() {
    const scrollElement = scrollRef.current;
    if (!scrollElement || pageRefs.current.size === 0) return;
    const scrollTop = scrollElement.getBoundingClientRect().top;
    let nextPage = currentPage;
    let closestDistance = Number.POSITIVE_INFINITY;
    pageRefs.current.forEach((node, pageNumber) => {
      const distance = Math.abs(node.getBoundingClientRect().top - scrollTop);
      if (distance < closestDistance) {
        closestDistance = distance;
        nextPage = pageNumber;
      }
    });
    if (nextPage !== currentPage) setCurrentPage(nextPage);
  }

  return (
    <div className={studioStyles.workspace} ref={workspaceRef}>
      <div className={studioStyles.topBar}>
        <PdfViewportToolbar state={viewport} onChange={setViewport} />
        <div className={studioStyles.topActions}>
        <IconButton className={studioStyles.railToggle} label="打开页面缩略图" variant="secondary" size="sm"
          onClick={() => setThumbnailRailOpen((current) => !current)}><PanelLeftOpen size={16} /></IconButton>
        <div className={studioStyles.pageNavigator} aria-label="PDF 页码导航">
        <button type="button" aria-label="上一页" onClick={() => jumpToPage(currentPage - 1)} disabled={currentPage <= 1}>
          上一页
        </button>
        <label>
          <span>页码</span>
          <input
            type="number"
            min={1}
            max={Math.max(1, pageCount)}
            value={currentPage}
            onChange={(event) => jumpToPage(Number(event.target.value))}
          />
        </label>
        <span>/ {pageCount || 1}</span>
        <button type="button" aria-label="下一页" onClick={() => jumpToPage(currentPage + 1)} disabled={pageCount === 0 || currentPage >= pageCount}>
          下一页
        </button>
        </div>
        <IconButton label="全屏查看 PDF" variant="ghost" size="sm" onClick={() => void workspaceRef.current?.requestFullscreen?.()}>
          <Maximize size={16} />
        </IconButton>
        </div>
      </div>
      <div className={studioStyles.body}>
      {thumbnailRailOpen ? <button type="button" className={studioStyles.railBackdrop} aria-label="关闭页面缩略图" onClick={() => setThumbnailRailOpen(false)} /> : null}
      {pageNumbers.length > 0 && (
        <nav className={studioStyles.rail} data-open={thumbnailRailOpen} aria-label="PDF 缩略页导航">
          {pageNumbers.map((pageNumber) => (
            <button
              type="button"
              key={pageNumber}
              className={studioStyles.thumbnail}
              data-active={pageNumber === currentPage}
              aria-label={`跳转到第 ${pageNumber} 页`}
              onClick={() => { jumpToPage(pageNumber); setThumbnailRailOpen(false); }}
            >
              <span className={studioStyles.thumbnailPreview} aria-hidden="true">
                <PdfPageThumbnail pdf={pdf} pageNumber={pageNumber} render={shouldRenderPdfThumbnail(pageNumber, currentPage)} />
                {(pageIssueCounts[pageNumber] ?? 0) > 0 ? <span className={studioStyles.issueCount}>{pageIssueCounts[pageNumber]}</span> : null}
              </span>
              <small>第 {pageNumber} 页</small>
            </button>
          ))}
        </nav>
      )}
      <div
        ref={scrollRef}
        className={studioStyles.viewport}
        role="region"
        aria-label="PDF 页面视口"
        tabIndex={0}
        data-pan={viewport.panMode}
        data-panning={panning}
        onScroll={syncCurrentPageFromScroll}
        onPointerDownCapture={startPdfPan}
        onPointerMove={movePdfPan}
        onPointerUp={endPdfPan}
        onPointerCancel={endPdfPan}
      >
        {status === "loading" && (
          <div className={studioStyles.message}>
            <strong>正在加载 PDF 预览...</strong>
            <span>批注会固定在对应页面位置，并随 PDF 一起滚动。</span>
          </div>
        )}
        {status === "error" && (
          <div className={studioStyles.message} data-error="true">
            <strong>PDF 预览加载失败</strong>
            <span>{error || "请刷新后重试，或检查 PDF 文件是否已同步完成。"}</span>
          </div>
        )}
        {status === "ready" &&
          pdf &&
          pageNumbers.map((pageNumber) => (
            <PdfAnnotationPage
              key={pageNumber}
              pageRef={(node) => setPageRef(pageNumber, node)}
              pdf={pdf}
              pageNumber={pageNumber}
              annotations={annotationsForPage(annotations, pageNumber)}
              tool={tool}
              color={color}
              styleJson={styleJson}
              draftMessage={draftMessage}
              readOnly={readOnly || viewport.panMode}
              pageStyle={pageWidthStyle}
              renderZoom={viewport.mode === "manual" ? viewport.zoom : 1}
              renderCanvas={shouldRenderHighResolutionPage(pageNumber, currentPage)}
              onDraftAnnotation={onDraftAnnotation}
              onSelectAnnotation={onSelectAnnotation}
              selectedAnnotationId={selectedAnnotationId}
              onUpdateAnnotationGeometry={onUpdateAnnotationGeometry}
            />
          ))}
      </div>
      </div>
      <footer className={studioStyles.bottomBar} aria-label="PDF 视图状态">
        <span>第 {currentPage} / {pageCount || 1} 页</span>
        <span>{viewport.mode === "manual" ? `${Math.round(viewport.zoom * 100)}%` : viewport.mode === "fit-width" ? "适宽" : "适高"}</span>
        <span>高清渲染：当前页及相邻页</span>
      </footer>
    </div>
  );
}

export function scrollAnnotationIntoView(workspace: HTMLElement | null, annotationId: number | null) {
  if (!workspace || annotationId === null) return;
  const marker = workspace.querySelector<HTMLElement>(`[data-annotation-id="${annotationId}"]`);
  if (!marker) return;

  const workspaceRect = workspace.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const top = markerRect.top - workspaceRect.top - workspace.clientHeight / 2 + markerRect.height / 2;
  const left = markerRect.left - workspaceRect.left - workspace.clientWidth / 2 + markerRect.width / 2;

  workspace.scrollBy({ top, left, behavior: "smooth" });
}

export function annotationsForPage(annotations: ApprovalAnnotation[], pageNumber: number) {
  return annotations.filter((annotation) => annotation.pageNumber === pageNumber);
}

export function mergePageAnnotations(
  annotations: ApprovalAnnotation[],
  pageNumber: number,
  nextPageAnnotations: ApprovalAnnotation[]
) {
  return [...nextPageAnnotations, ...annotations.filter((annotation) => annotation.pageNumber !== pageNumber)];
}

export function shouldRenderHighResolutionPage(pageNumber: number, currentPage: number) {
  return Math.abs(pageNumber - currentPage) <= 1;
}

export function shouldRenderPdfThumbnail(pageNumber: number, currentPage: number) {
  return Math.abs(pageNumber - currentPage) <= 3;
}

export function createAnnotationFromDrag(
  kind: AnnotationTool,
  start: RatioPoint,
  end: RatioPoint,
  pageNumber: number,
  options: { message: string; color?: ApprovalAnnotationColor; styleJson?: string | null }
): ApprovalAnnotationInput {
  const color = options.color ?? "red";
  const styleJson = "styleJson" in options ? options.styleJson ?? null : undefined;
  const safeStart = clampPoint(start);
  const safeEnd = clampPoint(end);

  if (kind === "pin") {
    return {
      kind,
      message: options.message,
      pageNumber,
      xRatio: safeStart.xRatio,
      yRatio: safeStart.yRatio,
      widthRatio: null,
      heightRatio: null,
      endXRatio: null,
      endYRatio: null,
      color,
      ...(styleJson !== undefined ? { styleJson } : {})
    };
  }

  if (kind === "arrow") {
    return {
      kind,
      message: options.message,
      pageNumber,
      xRatio: safeStart.xRatio,
      yRatio: safeStart.yRatio,
      widthRatio: null,
      heightRatio: null,
      endXRatio: safeEnd.xRatio,
      endYRatio: safeEnd.yRatio,
      color,
      ...(styleJson !== undefined ? { styleJson } : {})
    };
  }

  if (kind !== "rect" && kind !== "circle" && kind !== "text" && kind !== "cloud") {
    throw new Error("INVALID_ANNOTATION_TOOL");
  }

  const left = Math.min(safeStart.xRatio, safeEnd.xRatio);
  const top = Math.min(safeStart.yRatio, safeEnd.yRatio);
  const right = Math.max(safeStart.xRatio, safeEnd.xRatio);
  const bottom = Math.max(safeStart.yRatio, safeEnd.yRatio);
  const minimumSize = minimumBoxSize(kind);
  const widthRatio = roundRatio(Math.max(minimumSize.widthRatio, right - left));
  const heightRatio = roundRatio(Math.max(minimumSize.heightRatio, bottom - top));

  return {
    kind,
    message: options.message,
    pageNumber,
    xRatio: roundRatio(Math.min(left, 1 - widthRatio)),
    yRatio: roundRatio(Math.min(top, 1 - heightRatio)),
    widthRatio,
    heightRatio,
    endXRatio: null,
    endYRatio: null,
    color,
    ...(styleJson !== undefined ? { styleJson } : {})
  };
}

export function createInkAnnotationFromPoints(
  points: RatioPoint[],
  pageNumber: number,
  options: { message: string; color?: ApprovalAnnotationColor; styleJson?: string | null }
): ApprovalAnnotationInput {
  if (points.length < 2) {
    throw new Error("INVALID_ANNOTATION_GEOMETRY");
  }

  const safePoints = points.map(clampPoint);
  const firstPoint = safePoints[0];

  return {
    kind: "ink",
    message: options.message,
    pageNumber,
    xRatio: firstPoint.xRatio,
    yRatio: firstPoint.yRatio,
    widthRatio: null,
    heightRatio: null,
    endXRatio: null,
    endYRatio: null,
    pointsJson: JSON.stringify(safePoints),
    styleJson: options.styleJson ?? null,
    color: options.color ?? "red"
  };
}

export function createCloudAnnotationPath(annotation: AnnotationGeometry) {
  const bounds = annotationBounds(annotation);
  const left = roundRatio(bounds.left * 100);
  const top = roundRatio(bounds.top * 100);
  const right = roundRatio(bounds.right * 100);
  const bottom = roundRatio(bounds.bottom * 100);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const amplitude = roundRatio(clamp(Math.min(width, height) * 0.18, 1.5, 4));
  const horizontalSegments = Math.max(3, Math.ceil(width / 8));
  const verticalSegments = Math.max(2, Math.ceil(height / 7));
  const commands: string[] = [`M ${left} ${top}`];

  appendCloudSide(commands, { x: left, y: top }, { x: right, y: top }, horizontalSegments, 0, -amplitude);
  appendCloudSide(commands, { x: right, y: top }, { x: right, y: bottom }, verticalSegments, amplitude, 0);
  appendCloudSide(commands, { x: right, y: bottom }, { x: left, y: bottom }, horizontalSegments, 0, amplitude);
  appendCloudSide(commands, { x: left, y: bottom }, { x: left, y: top }, verticalSegments, -amplitude, 0);

  return `${commands.join(" ")} Z`;
}

export function annotationBounds(annotation: AnnotationGeometry) {
  if (annotation.kind === "arrow") {
    const endXRatio = annotation.endXRatio ?? annotation.xRatio;
    const endYRatio = annotation.endYRatio ?? annotation.yRatio;
    return {
      left: roundRatio(Math.min(annotation.xRatio, endXRatio)),
      top: roundRatio(Math.min(annotation.yRatio, endYRatio)),
      right: roundRatio(Math.max(annotation.xRatio, endXRatio)),
      bottom: roundRatio(Math.max(annotation.yRatio, endYRatio))
    };
  }

  if (annotation.kind === "ink") {
    const points = parseAnnotationPoints(annotation.pointsJson);
    if (points.length > 0) {
      return {
        left: roundRatio(Math.min(...points.map((point) => point.xRatio))),
        top: roundRatio(Math.min(...points.map((point) => point.yRatio))),
        right: roundRatio(Math.max(...points.map((point) => point.xRatio))),
        bottom: roundRatio(Math.max(...points.map((point) => point.yRatio)))
      };
    }
  }

  return {
    left: roundRatio(annotation.xRatio),
    top: roundRatio(annotation.yRatio),
    right: roundRatio(annotation.xRatio + (annotation.widthRatio ?? 0)),
    bottom: roundRatio(annotation.yRatio + (annotation.heightRatio ?? 0))
  };
}

export function moveAnnotation(annotation: AnnotationGeometry, delta: RatioPoint): ApprovalAnnotationInput {
  const bounds = annotationBounds(annotation);
  const clampedDelta = {
    xRatio: roundRatio(clamp(delta.xRatio, -bounds.left, 1 - bounds.right)),
    yRatio: roundRatio(clamp(delta.yRatio, -bounds.top, 1 - bounds.bottom))
  };

  const points = parseAnnotationPoints(annotation.pointsJson);

  return {
    kind: annotation.kind,
    message: annotation.message,
    pageNumber: annotation.pageNumber,
    xRatio: roundRatio(clamp(annotation.xRatio + clampedDelta.xRatio, 0, 1)),
    yRatio: roundRatio(clamp(annotation.yRatio + clampedDelta.yRatio, 0, 1)),
    widthRatio: annotation.widthRatio ?? null,
    heightRatio: annotation.heightRatio ?? null,
    endXRatio:
      annotation.endXRatio === null || annotation.endXRatio === undefined
        ? null
        : roundRatio(clamp(annotation.endXRatio + clampedDelta.xRatio, 0, 1)),
    endYRatio:
      annotation.endYRatio === null || annotation.endYRatio === undefined
        ? null
        : roundRatio(clamp(annotation.endYRatio + clampedDelta.yRatio, 0, 1)),
    pointsJson:
      points.length === 0
        ? annotation.pointsJson ?? null
        : JSON.stringify(
            points.map((point) => ({
              xRatio: roundRatio(clamp(point.xRatio + clampedDelta.xRatio, 0, 1)),
              yRatio: roundRatio(clamp(point.yRatio + clampedDelta.yRatio, 0, 1))
            }))
          ),
    styleJson: annotation.styleJson ?? null,
    color: annotation.color ?? "red"
  };
}

export function resizeAnnotation(
  annotation: AnnotationGeometry,
  handle: AnnotationResizeHandle,
  point: RatioPoint
): ApprovalAnnotationInput {
  if (!isBoxAnnotation(annotation.kind)) {
    return moveAnnotation(annotation, { xRatio: 0, yRatio: 0 });
  }

  const safePoint = clampPoint(point);
  const bounds = annotationBounds(annotation);
  const minimumSize = minimumBoxSize(annotation.kind);

  let left = bounds.left;
  let top = bounds.top;
  let right = bounds.right;
  let bottom = bounds.bottom;

  if (handle.includes("w")) left = Math.min(safePoint.xRatio, right - minimumSize.widthRatio);
  if (handle.includes("e")) right = Math.max(safePoint.xRatio, left + minimumSize.widthRatio);
  if (handle.includes("n")) top = Math.min(safePoint.yRatio, bottom - minimumSize.heightRatio);
  if (handle.includes("s")) bottom = Math.max(safePoint.yRatio, top + minimumSize.heightRatio);

  left = clamp(left, 0, 1 - minimumSize.widthRatio);
  top = clamp(top, 0, 1 - minimumSize.heightRatio);
  right = clamp(right, left + minimumSize.widthRatio, 1);
  bottom = clamp(bottom, top + minimumSize.heightRatio, 1);

  return {
    kind: annotation.kind,
    message: annotation.message,
    pageNumber: annotation.pageNumber,
    xRatio: roundRatio(left),
    yRatio: roundRatio(top),
    widthRatio: roundRatio(right - left),
    heightRatio: roundRatio(bottom - top),
    endXRatio: null,
    endYRatio: null,
    pointsJson: annotation.pointsJson ?? null,
    styleJson: annotation.styleJson ?? null,
    color: annotation.color ?? "red"
  };
}

function PdfAnnotationPage({
  pageRef,
  pdf,
  pageNumber,
  annotations,
  tool,
  color,
  styleJson,
  draftMessage,
  readOnly,
  pageStyle,
  renderZoom,
  renderCanvas,
  onDraftAnnotation,
  onSelectAnnotation,
  selectedAnnotationId,
  onUpdateAnnotationGeometry
}: {
  pageRef: (node: HTMLDivElement | null) => void;
  pdf: PDFDocumentProxy;
  pageNumber: number;
  annotations: ApprovalAnnotation[];
  tool: AnnotationTool;
  color: ApprovalAnnotationColor;
  styleJson: string | null;
  draftMessage: string;
  readOnly: boolean;
  pageStyle?: CSSProperties;
  renderZoom: number;
  renderCanvas: boolean;
  onDraftAnnotation?: (annotation: ApprovalAnnotationInput, anchor: AnnotationDraftAnchor) => void;
  onSelectAnnotation?: (annotation: ApprovalAnnotation) => void;
  selectedAnnotationId: number | null;
  onUpdateAnnotationGeometry?: (annotation: ApprovalAnnotation, input: ApprovalAnnotationInput) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [aspectRatio, setAspectRatio] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let renderTask: RenderTask | null = null;

    async function renderPage() {
      setError("");
      try {
        page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: 1 });
        setAspectRatio(`${viewport.width} / ${viewport.height}`);

        if (!renderCanvas) {
          page.cleanup?.();
          return;
        }

        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) throw new Error("浏览器无法创建 PDF 画布");

        const renderScale = clamp((1800 * Math.max(1, renderZoom)) / viewport.width, 0.65, 3.5);
        const renderViewport = page.getViewport({ scale: renderScale });
        canvas.width = Math.floor(renderViewport.width);
        canvas.height = Math.floor(renderViewport.height);

        renderTask = page.render({ canvas, canvasContext: context, viewport: renderViewport });
        await renderTask.promise;
        page.cleanup?.();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "页面渲染失败");
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
      renderTask?.cancel?.();
      page?.cleanup?.();
    };
  }, [pdf, pageNumber, renderZoom, renderCanvas]);

  return (
    <div ref={pageRef} className={studioStyles.page} style={{ ...(pageStyle ?? {}), ...(aspectRatio ? { aspectRatio } : {}) }}>
      {renderCanvas ? <canvas ref={canvasRef} className={studioStyles.canvas} aria-label={`PDF 第 ${pageNumber} 页`} />
        : <div className={studioStyles.pagePlaceholder}>滚动到附近时渲染第 {pageNumber} 页</div>}
      <span className={studioStyles.pageNumber}>第 {pageNumber} 页</span>
      {error && (
        <div className={studioStyles.pageError}>
          <strong>第 {pageNumber} 页渲染失败</strong>
          <span>{error}</span>
        </div>
      )}
      <PdfAnnotationLayer
        annotations={annotations}
        pageNumber={pageNumber}
        tool={tool}
        color={color}
        styleJson={styleJson}
        draftMessage={draftMessage}
        readOnly={readOnly}
        onDraftAnnotation={onDraftAnnotation}
        onSelectAnnotation={onSelectAnnotation}
        selectedAnnotationId={selectedAnnotationId}
        onUpdateAnnotationGeometry={onUpdateAnnotationGeometry}
      />
    </div>
  );
}

function PdfPageThumbnail({ pdf, pageNumber, render }: { pdf: PDFDocumentProxy | null; pageNumber: number; render: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!pdf || !render || !canvasRef.current) return;
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let task: RenderTask | null = null;
    void pdf.getPage(pageNumber).then((nextPage) => {
      page = nextPage;
      if (cancelled || !canvasRef.current) return;
      const base = nextPage.getViewport({ scale: 1 });
      const viewport = nextPage.getViewport({ scale: 140 / base.width });
      const context = canvasRef.current.getContext("2d");
      if (!context) return;
      canvasRef.current.width = Math.max(1, Math.floor(viewport.width));
      canvasRef.current.height = Math.max(1, Math.floor(viewport.height));
      task = nextPage.render({ canvas: canvasRef.current, canvasContext: context, viewport });
      return task.promise;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel?.();
      page?.cleanup?.();
    };
  }, [pdf, pageNumber, render]);
  return render ? <canvas ref={canvasRef} /> : <span>{pageNumber}</span>;
}

function clampPoint(point: RatioPoint) {
  return {
    xRatio: roundRatio(clamp(point.xRatio, 0, 1)),
    yRatio: roundRatio(clamp(point.yRatio, 0, 1))
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampPage(pageNumber: number, pageCount: number) {
  const safePageCount = Math.max(1, pageCount);
  const safePageNumber = Number.isFinite(pageNumber) ? pageNumber : 1;
  return Math.min(safePageCount, Math.max(1, Math.trunc(safePageNumber)));
}

function minimumBoxSize(kind: "rect" | "circle" | "text" | "cloud") {
  if (kind === "text") {
    return { widthRatio: 0.055, heightRatio: 0.028 };
  }
  if (kind === "cloud") {
    return { widthRatio: 0.04, heightRatio: 0.04 };
  }
  return { widthRatio: 0.01, heightRatio: 0.01 };
}

function roundRatio(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isBoxAnnotation(kind: ApprovalAnnotationKind) {
  return kind === "rect" || kind === "circle" || kind === "text" || kind === "cloud";
}

function parseAnnotationPoints(pointsJson: string | null | undefined): RatioPoint[] {
  if (!pointsJson) return [];
  try {
    const parsed = JSON.parse(pointsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((point): point is Partial<RatioPoint> => Boolean(point) && typeof point === "object")
      .filter((point) => typeof point.xRatio === "number" && typeof point.yRatio === "number")
      .map((point) => clampPoint({ xRatio: point.xRatio!, yRatio: point.yRatio! }));
  } catch {
    return [];
  }
}

function appendCloudSide(
  commands: string[],
  start: { x: number; y: number },
  end: { x: number; y: number },
  segments: number,
  controlOffsetX: number,
  controlOffsetY: number
) {
  for (let index = 1; index <= segments; index += 1) {
    const previousRatio = (index - 1) / segments;
    const nextRatio = index / segments;
    const middleRatio = (previousRatio + nextRatio) / 2;
    const control = {
      x: roundRatio(start.x + (end.x - start.x) * middleRatio + controlOffsetX),
      y: roundRatio(start.y + (end.y - start.y) * middleRatio + controlOffsetY)
    };
    const next = {
      x: roundRatio(start.x + (end.x - start.x) * nextRatio),
      y: roundRatio(start.y + (end.y - start.y) * nextRatio)
    };
    commands.push(`Q ${control.x} ${control.y} ${next.x} ${next.y}`);
  }
}
