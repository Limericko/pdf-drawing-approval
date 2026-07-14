import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { SignaturePlacement, SignaturePlacementRole } from "../api.ts";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask
} from "pdfjs-dist";
import { SignaturePlacementEditor } from "./SignaturePlacementEditor.tsx";
import {
  createPdfViewportWheelHandler,
  createPdfViewportState,
  pdfPageWidthStyle,
  pdfViewportWheelListenerOptions,
  PdfViewportToolbar
} from "./PdfViewportControls.tsx";
import styles from "./PdfSignaturePlacementWorkspace.module.css";

type PdfPanState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
};

export function PdfSignaturePlacementWorkspace({
  pdfUrl,
  placements,
  onChange
}: {
  pdfUrl: string;
  placements: SignaturePlacement[];
  onChange: (placements: SignaturePlacement[]) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
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
    <div className={styles.workspace}>
      <PdfViewportToolbar state={viewport} onChange={setViewport} />
      <div className={styles.navigator} aria-label="PDF 页码导航">
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
      {pageNumbers.length > 1 && (
        <div className={styles.thumbnails} aria-label="PDF 缩略页导航">
          {pageNumbers.map((pageNumber) => (
            <button
              type="button"
              key={pageNumber}
              className={styles.thumbnail}
              data-active={pageNumber === currentPage}
              aria-label={`跳转到第 ${pageNumber} 页`}
              onClick={() => jumpToPage(pageNumber)}
            >
              <span className={styles.thumbnailPreview} aria-hidden="true">
                <span>{pageNumber}</span>
              </span>
              <small>第 {pageNumber} 页</small>
            </button>
          ))}
        </div>
      )}
      <div
        ref={scrollRef}
        className={styles.viewport}
        role="region"
        aria-label="签名位置 PDF 页面视口"
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
          <div className={styles.message}>
            <strong>正在加载 PDF 预览...</strong>
            <span>签名框会随页面一起滚动。</span>
          </div>
        )}
        {status === "error" && (
          <div className={styles.message} data-error="true">
            <strong>PDF 预览加载失败</strong>
            <span>{error || "请刷新后重试，或检查 PDF 文件是否已同步完成。"}</span>
          </div>
        )}
        {status === "ready" &&
          pdf &&
          pageNumbers.map((pageNumber) => (
            <PdfPlacementPage
              key={pageNumber}
              pageRef={(node) => setPageRef(pageNumber, node)}
              pdf={pdf}
              pageNumber={pageNumber}
              pageCount={pageCount}
              placements={placementsForPage(placements, pageNumber)}
              pageStyle={pageWidthStyle}
              renderZoom={viewport.mode === "manual" ? viewport.zoom : 1}
              onChange={(nextPagePlacements) => onChange(mergePagePlacements(placements, pageNumber, nextPagePlacements))}
            />
          ))}
      </div>
    </div>
  );
}

export function placementsForPage(placements: SignaturePlacement[], pageNumber: number) {
  return placements.filter((placement) => placement.pageNumber === pageNumber);
}

export function mergePagePlacements(
  placements: SignaturePlacement[],
  pageNumber: number,
  nextPagePlacements: SignaturePlacement[]
) {
  const nextByRole = new Map<SignaturePlacementRole, SignaturePlacement>(
    nextPagePlacements.map((placement) => [placement.role, placement])
  );

  return placements.map((placement) => {
    if (placement.pageNumber !== pageNumber) return placement;
    return nextByRole.get(placement.role) ?? placement;
  });
}

function PdfPlacementPage({
  pageRef,
  pdf,
  pageNumber,
  pageCount,
  placements,
  pageStyle,
  renderZoom,
  onChange
}: {
  pageRef: (node: HTMLDivElement | null) => void;
  pdf: PDFDocumentProxy;
  pageNumber: number;
  pageCount: number;
  placements: SignaturePlacement[];
  pageStyle?: CSSProperties;
  renderZoom: number;
  onChange: (placements: SignaturePlacement[]) => void;
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
  }, [pdf, pageNumber, renderZoom]);

  return (
    <div ref={pageRef} className={styles.page} style={{ ...(pageStyle ?? {}), ...(aspectRatio ? { aspectRatio } : {}) }}>
      <canvas ref={canvasRef} className={styles.canvas} aria-label={`PDF 第 ${pageNumber} 页`} />
      <span className={styles.pageNumber}>第 {pageNumber} 页</span>
      {error && (
        <div className={styles.pageError}>
          <strong>第 {pageNumber} 页渲染失败</strong>
          <span>{error}</span>
        </div>
      )}
      <SignaturePlacementEditor placements={placements} onChange={onChange} pageCount={pageCount} />
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampPage(pageNumber: number, pageCount: number) {
  const safePageCount = Math.max(1, pageCount);
  const safePageNumber = Number.isFinite(pageNumber) ? pageNumber : 1;
  return Math.min(safePageCount, Math.max(1, Math.trunc(safePageNumber)));
}
