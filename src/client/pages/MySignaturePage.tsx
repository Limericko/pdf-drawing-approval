import { useEffect, useRef, useState } from "react";
import {
  getMySignature,
  getMySignatureFileUrl,
  saveDrawnSignature,
  uploadMySignature,
  type MySignature
} from "../api.ts";

export function MySignaturePage({ onSignatureUpdated }: { onSignatureUpdated?: (signature: MySignature) => void } = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [signature, setSignature] = useState<MySignature | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [previewVersion, setPreviewVersion] = useState(0);

  useEffect(() => {
    getMySignature().then(setSignature).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) prepareSignatureCanvas(canvas);
  }, []);

  async function upload(file: File | null) {
    if (!file) return;
    setBusy("upload");
    setError("");
    setMessage("");
    try {
      const next = await uploadMySignature(file);
      setSignature(next);
      onSignatureUpdated?.(next);
      setPreviewVersion((value) => value + 1);
      setMessage("签名已上传。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setBusy("");
    }
  }

  async function saveCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setBusy("draw");
    setError("");
    setMessage("");
    try {
      const next = await saveDrawnSignature(canvas.toDataURL("image/png"));
      setSignature(next);
      onSignatureUpdated?.(next);
      setPreviewVersion((value) => value + 1);
      setMessage("手写签名已保存。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy("");
    }
  }

  function clearCanvas() {
    if (canvasRef.current) clearSignatureCanvas(canvasRef.current);
  }

  function pointerPosition(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height
    };
  }

  function drawTo(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return;
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const point = pointerPosition(event);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SIGNATURE</span>
          <h1>签名素材</h1>
          <p>上传或手写透明背景 PNG，审批通过后用于自动盖章。</p>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <div className="signature-page-grid">
        <section className="management-panel">
          <div className="panel-heading">
            <div>
              <h2>当前签名</h2>
              <span>{signature?.configured ? "已配置" : "尚未配置"}</span>
            </div>
          </div>
          <div className="signature-preview">
            {signature?.configured ? (
              <img src={`${getMySignatureFileUrl()}&v=${previewVersion}`} alt="当前签名" />
            ) : (
              <span>暂无签名</span>
            )}
          </div>
          {signature?.asset && (
            <dl className="compact-dl">
              <dt>来源</dt>
              <dd>{signature.asset.kind === "uploaded_png" ? "PNG 上传" : "网页手写"}</dd>
              <dt>更新时间</dt>
              <dd>{new Date(signature.asset.updatedAt).toLocaleString()}</dd>
            </dl>
          )}
        </section>

        <section className="management-panel">
          <div className="panel-heading">
            <div>
              <h2>上传 PNG</h2>
              <span>建议使用透明背景、深色笔迹图片</span>
            </div>
          </div>
          <input type="file" accept="image/png,.png" onChange={(event) => void upload(event.target.files?.[0] ?? null)} />
          {busy === "upload" && <p className="hint">上传中...</p>}
        </section>

        <section className="management-panel signature-draw-panel">
          <div className="panel-heading">
            <div>
              <h2>在线手写</h2>
              <span>鼠标、触控笔或触控板书写后保存</span>
            </div>
            <div className="actions">
              <button type="button" className="secondary-button" onClick={clearCanvas}>清除</button>
              <button type="button" onClick={saveCanvas} disabled={busy === "draw"}>
                {busy === "draw" ? "保存中" : "保存签名"}
              </button>
            </div>
          </div>
          <canvas
            ref={canvasRef}
            width={640}
            height={220}
            className="signature-canvas"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const context = event.currentTarget.getContext("2d");
              const point = pointerPosition(event);
              context?.beginPath();
              context?.moveTo(point.x, point.y);
              setDrawing(true);
            }}
            onPointerMove={drawTo}
            onPointerUp={() => setDrawing(false)}
            onPointerCancel={() => setDrawing(false)}
          />
        </section>
      </div>
    </section>
  );
}

export function prepareSignatureCanvas(canvas: HTMLCanvasElement) {
  clearSignatureCanvas(canvas);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.strokeStyle = "#111827";
  context.lineWidth = 3;
  context.lineCap = "round";
  context.lineJoin = "round";
}

export function clearSignatureCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
}
