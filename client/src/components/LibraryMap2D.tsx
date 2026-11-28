import React from "react";
import type { CabinetRow, MapEntrance, RoomDimensions } from "../types.ts";

interface LibraryMap2DProps {
  cabinets: CabinetRow[];
  highlightedCabinetId?: number | null;
  onSelectCabinet?: (cab: CabinetRow) => void;
  entrance?: MapEntrance;
  roomDimensions?: RoomDimensions;
  compact?: boolean;
}

export const MAP_WIDTH = 760;
export const MAP_HEIGHT = 440;
export const MAP_PADDING = 10;
export const MAP_MAX_INNER = 740;
export const DEFAULT_ENTRANCE: MapEntrance = { wall: "bottom", offset: 50 };

export interface RoomCanvasSize {
  canvasW: number;
  canvasH: number;
  innerW: number;
  innerH: number;
  lengthM: number;
  widthM: number;
  pxPerCm: number;
}

export function getRoomCanvasSize(roomDimensions?: RoomDimensions): RoomCanvasSize {
  const rawLen = Number(roomDimensions?.length_m);
  const rawWid = Number(roomDimensions?.width_m);
  if (!(rawLen > 0 && rawWid > 0)) {
    return {
      canvasW: MAP_WIDTH,
      canvasH: MAP_HEIGHT,
      innerW: MAP_WIDTH - MAP_PADDING * 2,
      innerH: MAP_HEIGHT - MAP_PADDING * 2,
      lengthM: 7.4,
      widthM: 4.2,
      pxPerCm: 1,
    };
  }
  const lengthM = Math.max(1, Math.min(60, rawLen));
  const widthM = Math.max(1, Math.min(60, rawWid));
  const maxM = Math.max(lengthM, widthM);
  const pxPerM = MAP_MAX_INNER / maxM;
  const innerW = Math.max(120, Math.round(lengthM * pxPerM));
  const innerH = Math.max(120, Math.round(widthM * pxPerM));
  return {
    canvasW: innerW + MAP_PADDING * 2,
    canvasH: innerH + MAP_PADDING * 2,
    innerW,
    innerH,
    lengthM,
    widthM,
    pxPerCm: pxPerM / 100,
  };
}

export function getSourceCanvasForCabinets(
  roomDimensions: RoomDimensions | undefined,
  cabinets: Array<{ x: number; y: number; width: number; height: number }>
): { w: number; h: number } {
  const savedW = Number(roomDimensions?.canvas_w);
  const savedH = Number(roomDimensions?.canvas_h);
  if (savedW > 0 && savedH > 0) {
    return { w: savedW, h: savedH };
  }
  const hasTallCoords = cabinets.some((c) => c.y + c.height > MAP_HEIGHT + 8);
  if (hasTallCoords) {
    const target = getRoomCanvasSize(roomDimensions);
    return { w: target.canvasW, h: target.canvasH };
  }
  return { w: MAP_WIDTH, h: MAP_HEIGHT };
}

export function adaptCabinetsToCanvas<
  T extends { x: number; y: number; width: number; height: number; rotation?: number }
>(
  cabinets: T[],
  fromW: number,
  fromH: number,
  toW: number,
  toH: number,
  round = true
): T[] {
  if (Math.abs(fromW - toW) < 1 && Math.abs(fromH - toH) < 1) {
    return cabinets;
  }
  const fromInnerW = Math.max(100, fromW - MAP_PADDING * 2);
  const fromInnerH = Math.max(100, fromH - MAP_PADDING * 2);
  const toInnerW = Math.max(100, toW - MAP_PADDING * 2);
  const toInnerH = Math.max(100, toH - MAP_PADDING * 2);
  const sizeScale = Math.min(toInnerW / fromInnerW, toInnerH / fromInnerH);

  return cabinets.map((c) => {
    const oldCx = c.x + c.width / 2;
    const oldCy = c.y + c.height / 2;
    let newCx = MAP_PADDING + ((oldCx - MAP_PADDING) / fromInnerW) * toInnerW;
    let newCy = MAP_PADDING + ((oldCy - MAP_PADDING) / fromInnerH) * toInnerH;
    const newW = Math.max(20, c.width * sizeScale);
    const newH = Math.max(20, c.height * sizeScale);

    const rad = ((c.rotation || 0) * Math.PI) / 180;
    const halfW = (Math.abs(newW * Math.cos(rad)) + Math.abs(newH * Math.sin(rad))) / 2;
    const halfH = (Math.abs(newW * Math.sin(rad)) + Math.abs(newH * Math.cos(rad))) / 2;
    const minCx = 15 + halfW;
    const maxCx = Math.max(minCx, toW - 15 - halfW);
    const minCy = 15 + halfH;
    const maxCy = Math.max(minCy, toH - 20 - halfH);
    newCx = Math.max(minCx, Math.min(maxCx, newCx));
    newCy = Math.max(minCy, Math.min(maxCy, newCy));

    const nx = newCx - newW / 2;
    const ny = newCy - newH / 2;
    return {
      ...c,
      x: round ? Math.round(nx) : nx,
      y: round ? Math.round(ny) : ny,
      width: round ? Math.round(newW) : newW,
      height: round ? Math.round(newH) : newH,
    };
  });
}

export function getEntranceGeometry(entrance?: MapEntrance, canvasW = MAP_WIDTH, canvasH = MAP_HEIGHT) {
  const e = entrance || DEFAULT_ENTRANCE;
  const pct = Math.max(10, Math.min(90, Number(e.offset) || 50)) / 100;
  const labelW = 126;
  const labelH = 18;

  if (e.wall === "top") {
    const cx = 10 + pct * (canvasW - 20);
    return { cx, cy: 10, w: labelW, h: labelH, vertical: false };
  }
  if (e.wall === "left") {
    const cy = 10 + pct * (canvasH - 20);
    return { cx: 10, cy, w: labelH, h: labelW, vertical: true };
  }
  if (e.wall === "right") {
    const cy = 10 + pct * (canvasH - 20);
    return { cx: canvasW - 10, cy, w: labelH, h: labelW, vertical: true };
  }
  const cx = 10 + pct * (canvasW - 20);
  return { cx, cy: canvasH - 10, w: labelW, h: labelH, vertical: false };
}

export const EntranceMarker: React.FC<{
  entrance?: MapEntrance;
  canvasW?: number;
  canvasH?: number;
  draggable?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
}> = ({ entrance, canvasW = MAP_WIDTH, canvasH = MAP_HEIGHT, draggable, onPointerDown }) => {
  const g = getEntranceGeometry(entrance, canvasW, canvasH);
  return (
    <g
      transform={`translate(${g.cx}, ${g.cy})`}
      onPointerDown={onPointerDown}
      className={draggable ? "cursor-grab active:cursor-grabbing" : undefined}
    >
      <rect
        x={-g.w / 2}
        y={-g.h / 2}
        width={g.w}
        height={g.h}
        rx="4"
        fill="var(--otzar-bg)"
        stroke="var(--otzar-accent)"
        strokeWidth="1.75"
      />
      <text
        x="0"
        y="3.5"
        textAnchor="middle"
        fontSize="10"
        fontWeight="700"
        fill="var(--otzar-accent)"
        transform={g.vertical ? "rotate(-90)" : undefined}
      >
        כניסה לאוצר הספרים
      </text>
    </g>
  );
};

export const LibraryMap2D: React.FC<LibraryMap2DProps> = ({
  cabinets,
  highlightedCabinetId,
  onSelectCabinet,
  entrance,
  roomDimensions,
  compact = false,
}) => {
  const roomWidthM = Number(roomDimensions?.width_m) || 0;
  const roomLengthM = Number(roomDimensions?.length_m) || 0;
  const roomArea = roomWidthM > 0 && roomLengthM > 0 ? Math.round(roomWidthM * roomLengthM * 10) / 10 : 0;
  const { canvasW, canvasH } = getRoomCanvasSize(roomDimensions);
  const sourceCanvas = getSourceCanvasForCabinets(roomDimensions, cabinets);
  const displayCabinets = adaptCabinetsToCanvas(cabinets, sourceCanvas.w, sourceCanvas.h, canvasW, canvasH, true);

  return (
    <div className="w-full rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] overflow-hidden">
      {roomArea > 0 && !compact && (
        <div className="px-3 py-1.5 border-b border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]/60 flex items-center justify-between text-[11px] text-[var(--otzar-text-muted)] tabular-nums">
          <span>מידות האולם: {roomLengthM}מ׳ × {roomWidthM}מ׳</span>
          <span className="font-semibold text-[var(--otzar-text)]">{roomArea} מ״ר</span>
        </div>
      )}
      <svg
        viewBox={`0 0 ${canvasW} ${canvasH}`}
        width={canvasW * 2}
        height={canvasH * 2}
        className={
          compact
            ? "w-auto max-w-full h-auto max-h-56 mx-auto block"
            : "w-auto max-w-full h-auto max-h-[500px] mx-auto block"
        }
        role="img"
        aria-label="מפה דו-ממדית של ארונות אוצר הספרים"
      >
        <defs>
          <pattern id="otzar-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="currentColor" strokeOpacity="0.07" strokeWidth="1" />
          </pattern>
        </defs>

        <rect width={canvasW} height={canvasH} fill="url(#otzar-grid)" />

        <rect
          x="10"
          y="10"
          width={canvasW - 20}
          height={canvasH - 20}
          rx="8"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="2"
        />

        <EntranceMarker entrance={entrance} canvasW={canvasW} canvasH={canvasH} />

        {displayCabinets.map((cab) => {
          const isHighlighted = highlightedCabinetId === cab.id;
          const cx = cab.x + cab.width / 2;
          const cy = cab.y + cab.height / 2;
          const rectTransform = cab.rotation ? `rotate(${cab.rotation} ${cx} ${cy})` : undefined;

          return (
            <g
              key={cab.id}
              onClick={() => onSelectCabinet?.(cab)}
              className={onSelectCabinet ? "cursor-pointer" : undefined}
            >
              <rect
                x={cab.x}
                y={cab.y}
                width={cab.width}
                height={cab.height}
                rx="6"
                transform={rectTransform}
                fill={isHighlighted ? "var(--otzar-accent)" : "var(--otzar-bg)"}
                stroke={isHighlighted ? "var(--otzar-accent-hover)" : "var(--otzar-text-muted)"}
                strokeWidth={isHighlighted ? "3" : "1.5"}
              />
              <text
                x={cx}
                y={cy - (cab.main_subject && cab.height >= 54 ? 4 : -4)}
                textAnchor="middle"
                fontSize="14"
                fontWeight="700"
                fill={isHighlighted ? "#ffffff" : "var(--otzar-text)"}
              >
                {cab.code}
              </text>
              {cab.main_subject && cab.height >= 54 && (
                <text
                  x={cx}
                  y={cy + 13}
                  textAnchor="middle"
                  fontSize="10"
                  fill={isHighlighted ? "#ffedd5" : "var(--otzar-text-muted)"}
                >
                  {cab.main_subject.length > 22 ? cab.main_subject.slice(0, 21) + "…" : cab.main_subject}
                </text>
              )}
              {cab.width_cm && cab.depth_cm && cab.height >= 64 && (
                <text
                  x={cx}
                  y={cy + 25}
                  textAnchor="middle"
                  fontSize="8.5"
                  fill={isHighlighted ? "#fed7aa" : "var(--otzar-text-muted)"}
                  opacity="0.85"
                >
                  {cab.width_cm}×{cab.depth_cm} ס״מ
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
};
