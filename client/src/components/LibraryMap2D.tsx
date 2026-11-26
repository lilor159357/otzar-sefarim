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
export const DEFAULT_ENTRANCE: MapEntrance = { wall: "bottom", offset: 50 };

export function getEntranceGeometry(entrance?: MapEntrance) {
  const e = entrance || DEFAULT_ENTRANCE;
  const pct = Math.max(10, Math.min(90, Number(e.offset) || 50)) / 100;
  const labelW = 126;
  const labelH = 18;

  if (e.wall === "top") {
    const cx = 10 + pct * (MAP_WIDTH - 20);
    return { cx, cy: 10, w: labelW, h: labelH, vertical: false };
  }
  if (e.wall === "left") {
    const cy = 10 + pct * (MAP_HEIGHT - 20);
    return { cx: 10, cy, w: labelH, h: labelW, vertical: true };
  }
  if (e.wall === "right") {
    const cy = 10 + pct * (MAP_HEIGHT - 20);
    return { cx: MAP_WIDTH - 10, cy, w: labelH, h: labelW, vertical: true };
  }
  const cx = 10 + pct * (MAP_WIDTH - 20);
  return { cx, cy: MAP_HEIGHT - 10, w: labelW, h: labelH, vertical: false };
}

export const EntranceMarker: React.FC<{
  entrance?: MapEntrance;
  draggable?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
}> = ({ entrance, draggable, onPointerDown }) => {
  const g = getEntranceGeometry(entrance);
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

  return (
    <div className="w-full rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] overflow-hidden">
      {roomArea > 0 && !compact && (
        <div className="px-3 py-1.5 border-b border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]/60 flex items-center justify-between text-[11px] text-[var(--otzar-text-muted)] tabular-nums">
          <span>מידות האולם: {roomLengthM}מ׳ × {roomWidthM}מ׳</span>
          <span className="font-semibold text-[var(--otzar-text)]">{roomArea} מ״ר</span>
        </div>
      )}
      <svg
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        className={compact ? "w-full max-h-56 aspect-[760/440] mx-auto block" : "w-full aspect-[760/440] block"}
        role="img"
        aria-label="מפה דו-ממדית של ארונות אוצר הספרים"
      >
        <defs>
          <pattern id="otzar-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="currentColor" strokeOpacity="0.07" strokeWidth="1" />
          </pattern>
        </defs>

        <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#otzar-grid)" />

        <rect
          x="10"
          y="10"
          width={MAP_WIDTH - 20}
          height={MAP_HEIGHT - 20}
          rx="8"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="2"
        />

        <EntranceMarker entrance={entrance} />

        {cabinets.map((cab) => {
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
