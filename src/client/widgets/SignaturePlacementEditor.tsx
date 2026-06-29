import { useRef, useState } from "react";
import type { SignaturePlacement, SignaturePlacementRole } from "../api.ts";

const labels: Record<SignaturePlacementRole, string> = {
  designer: "设计",
  supervisor: "主管",
  process: "工艺"
};

const tones: Record<SignaturePlacementRole, string> = {
  designer: "signature-box--designer",
  supervisor: "signature-box--supervisor",
  process: "signature-box--process"
};

type DragState = {
  role: SignaturePlacementRole;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  original: SignaturePlacement;
};

const minWidthRatio = 0.015;
const minHeightRatio = 0.012;

export function defaultSignaturePlacements(): SignaturePlacement[] {
  return [
    { role: "designer", pageNumber: 1, xRatio: 0.58, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
    { role: "supervisor", pageNumber: 1, xRatio: 0.72, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
    { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 }
  ];
}

export function SignaturePlacementEditor({
  placements,
  onChange,
  pageCount = 1
}: {
  placements: SignaturePlacement[];
  onChange: (placements: SignaturePlacement[]) => void;
  pageCount?: number;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  function updatePlacement(role: SignaturePlacementRole, next: SignaturePlacement) {
    onChange(placements.map((placement) => (placement.role === role ? next : placement)));
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const dx = (event.clientX - drag.startX) / rect.width;
    const dy = (event.clientY - drag.startY) / rect.height;
    const original = drag.original;

    if (drag.mode === "move") {
      updatePlacement(drag.role, movePlacement(original, dx, dy));
      return;
    }

    updatePlacement(drag.role, resizePlacement(original, dx, dy));
  }

  return (
    <div
      ref={stageRef}
      className="signature-placement-layer"
      onPointerMove={onPointerMove}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
    >
      {placements.map((placement) => (
        <div
          key={placement.role}
          className={`signature-box ${tones[placement.role]}`}
          style={{
            left: `${placement.xRatio * 100}%`,
            top: `${placement.yRatio * 100}%`,
            width: `${placement.widthRatio * 100}%`,
            height: `${placement.heightRatio * 100}%`
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({
              role: placement.role,
              mode: "move",
              startX: event.clientX,
              startY: event.clientY,
              original: placement
            });
          }}
          >
            <span>{labels[placement.role]}</span>
            {pageCount > 1 && (
              <select
                className="signature-box__page-select"
                value={placement.pageNumber}
                aria-label={`${labels[placement.role]}签名页码`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => updatePlacement(placement.role, movePlacementToPage(placement, Number(event.target.value)))}
              >
                {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
                  <option key={pageNumber} value={pageNumber}>
                    第{pageNumber}页
                  </option>
                ))}
              </select>
            )}
          <button
            type="button"
            className="signature-box__handle"
            aria-label={`${labels[placement.role]}签名框缩放`}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag({
                role: placement.role,
                mode: "resize",
                startX: event.clientX,
                startY: event.clientY,
                original: placement
              });
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function movePlacement(placement: SignaturePlacement, dx: number, dy: number): SignaturePlacement {
  return {
    ...placement,
    xRatio: roundRatio(clamp(placement.xRatio + dx, 0, 1 - placement.widthRatio)),
    yRatio: roundRatio(clamp(placement.yRatio + dy, 0, 1 - placement.heightRatio))
  };
}

export function resizePlacement(placement: SignaturePlacement, dx: number, dy: number): SignaturePlacement {
  return {
    ...placement,
    widthRatio: roundRatio(clamp(placement.widthRatio + dx, minWidthRatio, 1 - placement.xRatio)),
    heightRatio: roundRatio(clamp(placement.heightRatio + dy, minHeightRatio, 1 - placement.yRatio))
  };
}

export function movePlacementToPage(placement: SignaturePlacement, pageNumber: number): SignaturePlacement {
  return {
    ...placement,
    pageNumber: Math.max(1, Math.floor(pageNumber))
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundRatio(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
