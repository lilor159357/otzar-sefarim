import React, { useEffect, useRef, useState } from "react";
import { Plus, Save, RotateCw, Trash2, CheckCircle2, BarChart3, X, RefreshCw, Copy, Sparkles, ArrowLeftRight, Ruler, Magnet, AlertTriangle } from "lucide-react";
import type { CabinetRow, MapEntrance, RoomDimensions, ShelvingReport } from "../types.ts";
import { adaptCabinetsToCanvas, DEFAULT_ENTRANCE, EntranceMarker, getRoomCanvasSize, getSourceCanvasForCabinets, MAP_HEIGHT, MAP_WIDTH } from "./LibraryMap2D.tsx";
import { SmartShelfOrganizerModal } from "./SmartShelfOrganizerModal.tsx";
import { useStrings } from "../lib/stringsContext.tsx";

interface MapEditorModuleProps {
  cabinets: CabinetRow[];
  entrance?: MapEntrance;
  roomDimensions?: RoomDimensions;
  onReload: () => Promise<void>;
}

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const SNAP = 10;
const MAGNET_THRESHOLD = 10;
const OVERLAP_EPS = 0.6;

interface RoomBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function getRoomBounds(canvasW: number, canvasH: number): RoomBounds {
  return { minX: 15, maxX: canvasW - 15, minY: 15, maxY: canvasH - 20 };
}

const snapVal = (v: number) => Math.round(v / SNAP) * SNAP;

interface CabBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  cx: number;
  cy: number;
  effW: number;
  effH: number;
}

function getCabBounds(c: { x: number; y: number; width: number; height: number; rotation?: number }): CabBounds {
  const rad = ((c.rotation || 0) * Math.PI) / 180;
  const effW = Math.abs(c.width * Math.cos(rad)) + Math.abs(c.height * Math.sin(rad));
  const effH = Math.abs(c.width * Math.sin(rad)) + Math.abs(c.height * Math.cos(rad));
  const cx = c.x + c.width / 2;
  const cy = c.y + c.height / 2;
  return {
    left: cx - effW / 2,
    right: cx + effW / 2,
    top: cy - effH / 2,
    bottom: cy + effH / 2,
    cx,
    cy,
    effW,
    effH,
  };
}

function getOverlapArea(a: CabBounds, b: CabBounds): number {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (ox <= OVERLAP_EPS || oy <= OVERLAP_EPS) return 0;
  return ox * oy;
}

function totalOverlapWithOthers(
  cab: { x: number; y: number; width: number; height: number; rotation?: number },
  others: CabinetRow[]
): number {
  const bA = getCabBounds(cab);
  let sum = 0;
  for (const o of others) {
    sum += getOverlapArea(bA, getCabBounds(o));
  }
  return sum;
}

function clampRotatedCabinet(c: { width: number; height: number; rotation?: number }, targetX: number, targetY: number, bounds: RoomBounds) {
  const rad = ((c.rotation || 0) * Math.PI) / 180;
  const halfW = (Math.abs(c.width * Math.cos(rad)) + Math.abs(c.height * Math.sin(rad))) / 2;
  const halfH = (Math.abs(c.width * Math.sin(rad)) + Math.abs(c.height * Math.cos(rad))) / 2;
  const minCx = bounds.minX + halfW;
  const maxCx = Math.max(minCx, bounds.maxX - halfW);
  const minCy = bounds.minY + halfH;
  const maxCy = Math.max(minCy, bounds.maxY - halfH);
  const targetCx = targetX + c.width / 2;
  const targetCy = targetY + c.height / 2;
  const clampedCx = Math.max(minCx, Math.min(maxCx, targetCx));
  const clampedCy = Math.max(minCy, Math.min(maxCy, targetCy));
  return {
    x: Math.round(clampedCx - c.width / 2),
    y: Math.round(clampedCy - c.height / 2),
  };
}

function applyMagneticSnap(
  cab: { x: number; y: number; width: number; height: number; rotation?: number },
  others: CabinetRow[],
  bounds: RoomBounds
): { x: number; y: number } {
  const bA = getCabBounds(cab);
  let bestDx: { delta: number; abs: number } | null = null;
  let bestDy: { delta: number; abs: number } | null = null;

  const tryX = (delta: number) => {
    const abs = Math.abs(delta);
    if (abs <= MAGNET_THRESHOLD && (!bestDx || abs < bestDx.abs)) {
      bestDx = { delta, abs };
    }
  };
  const tryY = (delta: number) => {
    const abs = Math.abs(delta);
    if (abs <= MAGNET_THRESHOLD && (!bestDy || abs < bestDy.abs)) {
      bestDy = { delta, abs };
    }
  };

  // Snap to room walls
  tryX(bounds.minX - bA.left);
  tryX(bounds.maxX - bA.right);
  tryY(bounds.minY - bA.top);
  tryY(bounds.maxY - bA.bottom);

  // Snap to other cabinets (flush edge-to-edge & aligned edges/centers)
  for (const o of others) {
    const bO = getCabBounds(o);
    tryX(bO.right - bA.left);
    tryX(bO.left - bA.right);
    tryX(bO.left - bA.left);
    tryX(bO.right - bA.right);
    tryX(bO.cx - bA.cx);

    tryY(bO.bottom - bA.top);
    tryY(bO.top - bA.bottom);
    tryY(bO.top - bA.top);
    tryY(bO.bottom - bA.bottom);
    tryY(bO.cy - bA.cy);
  }

  return {
    x: bestDx ? Math.round(cab.x + (bestDx as { delta: number }).delta) : snapVal(cab.x),
    y: bestDy ? Math.round(cab.y + (bestDy as { delta: number }).delta) : snapVal(cab.y),
  };
}

function pushOutOfOverlaps(
  cab: CabinetRow,
  others: CabinetRow[],
  bounds: RoomBounds
): { x: number; y: number; hasOverlap: boolean } {
  let cur = { ...cab };
  const c0 = clampRotatedCabinet(cur, cur.x, cur.y, bounds);
  cur.x = c0.x;
  cur.y = c0.y;

  for (let iter = 0; iter < 8; iter++) {
    const bA = getCabBounds(cur);
    let worstOther: CabBounds | null = null;
    let worstArea = 0;
    for (const o of others) {
      const bO = getCabBounds(o);
      const area = getOverlapArea(bA, bO);
      if (area > worstArea) {
        worstArea = area;
        worstOther = bO;
      }
    }
    if (!worstOther) {
      return { x: cur.x, y: cur.y, hasOverlap: false };
    }

    const pushes = [
      { dx: worstOther.left - bA.right, dy: 0 },
      { dx: worstOther.right - bA.left, dy: 0 },
      { dx: 0, dy: worstOther.top - bA.bottom },
      { dx: 0, dy: worstOther.bottom - bA.top },
    ].map((m) => {
      const nextX = Math.round(cur.x + m.dx);
      const nextY = Math.round(cur.y + m.dy);
      const cl = clampRotatedCabinet(cur, nextX, nextY, bounds);
      const wallBlocked = Math.abs(cl.x - nextX) > 1 || Math.abs(cl.y - nextY) > 1;
      const dist = Math.hypot(m.dx, m.dy);
      const overlapAfter = totalOverlapWithOthers({ ...cur, x: cl.x, y: cl.y }, others);
      return { x: cl.x, y: cl.y, score: dist + (wallBlocked ? 10000 : 0) + overlapAfter * 0.1 };
    });
    pushes.sort((a, b) => a.score - b.score);
    if (pushes[0].x === cur.x && pushes[0].y === cur.y) break;
    cur = { ...cur, x: pushes[0].x, y: pushes[0].y };
  }

  return {
    x: cur.x,
    y: cur.y,
    hasOverlap: totalOverlapWithOthers(cur, others) > 0,
  };
}

function findFreeSpotInRoom(
  cab: { width: number; height: number; rotation?: number },
  others: CabinetRow[],
  bounds: RoomBounds,
  startX = 40,
  startY = 40
): { x: number; y: number } {
  const b = getCabBounds({ ...cab, x: 0, y: 0 });
  const step = 20;
  for (let y = bounds.minY + 5; y + b.effH <= bounds.maxY; y += step) {
    for (let x = bounds.minX + 5; x + b.effW <= bounds.maxX; x += step) {
      const candX = Math.round(x + b.effW / 2 - cab.width / 2);
      const candY = Math.round(y + b.effH / 2 - cab.height / 2);
      const cl = clampRotatedCabinet(cab, candX, candY, bounds);
      if (totalOverlapWithOthers({ ...cab, x: cl.x, y: cl.y }, others) <= 0.5) {
        return cl;
      }
    }
  }
  return clampRotatedCabinet(cab, startX, startY, bounds);
}

function resolveNonOverlappingMove(
  candidate: CabinetRow,
  prevCab: CabinetRow,
  others: CabinetRow[],
  bounds: RoomBounds
): { x: number; y: number } {
  const clamped = clampRotatedCabinet(candidate, candidate.x, candidate.y, bounds);
  const candClamped = { ...candidate, x: clamped.x, y: clamped.y };
  if (totalOverlapWithOthers(candClamped, others) <= 0) {
    return clamped;
  }

  const prevOverlap = totalOverlapWithOthers(prevCab, others);
  const pushed = pushOutOfOverlaps(candClamped, others, bounds);
  if (!pushed.hasOverlap) {
    return { x: pushed.x, y: pushed.y };
  }

  if (prevOverlap <= 0) {
    const slideX = pushOutOfOverlaps({ ...candClamped, y: prevCab.y }, others, bounds);
    if (!slideX.hasOverlap) return { x: slideX.x, y: slideX.y };
    const slideY = pushOutOfOverlaps({ ...candClamped, x: prevCab.x }, others, bounds);
    if (!slideY.hasOverlap) return { x: slideY.x, y: slideY.y };
    return { x: prevCab.x, y: prevCab.y };
  }

  // If prevCab already overlapped from an older layout, allow freeing or reducing overlap
  const rawArea = totalOverlapWithOthers(candClamped, others);
  const pushedArea = totalOverlapWithOthers({ ...candClamped, x: pushed.x, y: pushed.y }, others);
  if (pushedArea < rawArea && pushedArea <= prevOverlap) {
    return { x: pushed.x, y: pushed.y };
  }
  return clamped;
}

function collectSnapGuides(
  cab: { x: number; y: number; width: number; height: number; rotation?: number },
  others: CabinetRow[],
  bounds: RoomBounds
): { x: number[]; y: number[] } {
  const bA = getCabBounds(cab);
  const xSet = new Set<number>();
  const ySet = new Set<number>();
  const TOL = 0.8;

  if (Math.abs(bA.left - bounds.minX) <= TOL) xSet.add(bounds.minX);
  if (Math.abs(bA.right - bounds.maxX) <= TOL) xSet.add(bounds.maxX);
  if (Math.abs(bA.top - bounds.minY) <= TOL) ySet.add(bounds.minY);
  if (Math.abs(bA.bottom - bounds.maxY) <= TOL) ySet.add(bounds.maxY);

  for (const o of others) {
    const bO = getCabBounds(o);
    if (Math.abs(bA.left - bO.right) <= TOL || Math.abs(bA.right - bO.right) <= TOL) xSet.add(bO.right);
    if (Math.abs(bA.right - bO.left) <= TOL || Math.abs(bA.left - bO.left) <= TOL) xSet.add(bO.left);
    if (Math.abs(bA.cx - bO.cx) <= TOL) xSet.add(bO.cx);

    if (Math.abs(bA.top - bO.bottom) <= TOL || Math.abs(bA.bottom - bO.bottom) <= TOL) ySet.add(bO.bottom);
    if (Math.abs(bA.bottom - bO.top) <= TOL || Math.abs(bA.top - bO.top) <= TOL) ySet.add(bO.top);
    if (Math.abs(bA.cy - bO.cy) <= TOL) ySet.add(bO.cy);
  }
  return { x: Array.from(xSet), y: Array.from(ySet) };
}

function getHandleCursor(dir: ResizeDir, rotation: number): string {
  const baseAngles: Record<ResizeDir, number> = {
    e: 0,
    w: 0,
    n: 90,
    s: 90,
    nw: 135,
    se: 135,
    ne: 45,
    sw: 45,
  };
  const deg = (((baseAngles[dir] + rotation) % 180) + 180) % 180;
  if (deg < 22.5 || deg >= 157.5) return "ew-resize";
  if (deg < 67.5) return "nesw-resize";
  if (deg < 112.5) return "ns-resize";
  return "nwse-resize";
}

export const MapEditorModule: React.FC<MapEditorModuleProps> = ({ cabinets, entrance, roomDimensions, onReload }) => {
  const { t } = useStrings();
  const initialRoom: RoomDimensions = {
    width_m: Number(roomDimensions?.width_m) > 0 ? Number(roomDimensions?.width_m) : 8,
    length_m: Number(roomDimensions?.length_m) > 0 ? Number(roomDimensions?.length_m) : 6,
  };
  const initialTargetCanvas = getRoomCanvasSize(initialRoom);
  const initialSrcCanvas = getSourceCanvasForCabinets(roomDimensions, cabinets);
  const [draftCabinets, setDraftCabinets] = useState<CabinetRow[]>(() =>
    adaptCabinetsToCanvas(cabinets, initialSrcCanvas.w, initialSrcCanvas.h, initialTargetCanvas.canvasW, initialTargetCanvas.canvasH, true)
  );
  const [draftEntrance, setDraftEntrance] = useState<MapEntrance>(entrance || DEFAULT_ENTRANCE);
  const [draftRoom, setDraftRoom] = useState<RoomDimensions>(initialRoom);
  const [lengthInput, setLengthInput] = useState<string>(String(initialRoom.length_m));
  const [widthInput, setWidthInput] = useState<string>(String(initialRoom.width_m));
  const cabinetFrameRef = useRef<{ w: number; h: number }>({ w: initialTargetCanvas.canvasW, h: initialTargetCanvas.canvasH });
  const [selectedId, setSelectedId] = useState<number | null>(cabinets[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newCode, setNewCode] = useState("");
  const [newSubject, setNewSubject] = useState("");
  const [newShelves, setNewShelves] = useState("5");
  const [newWidthCm, setNewWidthCm] = useState("120");
  const [newDepthCm, setNewDepthCm] = useState("40");

  const [dupCopyBooks, setDupCopyBooks] = useState(false);
  const [duplicatingCab, setDuplicatingCab] = useState(false);

  const [shelfActionMode, setShelfActionMode] = useState<"move_books" | "copy_books">("move_books");
  const [sourceShelfNum, setSourceShelfNum] = useState(1);
  const [targetCabId, setTargetCabId] = useState<number>(cabinets[0]?.id ?? 0);
  const [targetShelfNum, setTargetShelfNum] = useState(1);
  const [runningShelfAction, setRunningShelfAction] = useState(false);

  const [reportOpen, setReportOpen] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [shelvingReport, setShelvingReport] = useState<ShelvingReport | null>(null);
  const [smartOpen, setSmartOpen] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapGuides, setSnapGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });

  const loadShelvingReport = async () => {
    setReportLoading(true);
    setReportError(null);
    try {
      const res = await fetch("/api/reports/shelving");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בטעינת דוח מידוף");
      setShelvingReport(data);
    } catch (err: any) {
      setReportError(err?.message || "שגיאה בטעינת דוח מידוף");
    } finally {
      setReportLoading(false);
    }
  };

  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<
    | { type: "cabinet"; id: number; offsetX: number; offsetY: number; lastValidCab: CabinetRow }
    | { type: "entrance"; startClientX: number; startClientY: number; moved: boolean }
    | { type: "resize"; id: number; dir: ResizeDir; startPt: { x: number; y: number }; startCab: CabinetRow; lastValidCab: CabinetRow }
    | null
  >(null);

  useEffect(() => {
    const nextRoom: RoomDimensions = {
      width_m: Number(roomDimensions?.width_m) > 0 ? Number(roomDimensions?.width_m) : 8,
      length_m: Number(roomDimensions?.length_m) > 0 ? Number(roomDimensions?.length_m) : 6,
    };
    const target = getRoomCanvasSize(nextRoom);
    const src = getSourceCanvasForCabinets(roomDimensions, cabinets);
    setDraftRoom(nextRoom);
    setLengthInput(String(nextRoom.length_m));
    setWidthInput(String(nextRoom.width_m));
    setDraftCabinets(adaptCabinetsToCanvas(cabinets, src.w, src.h, target.canvasW, target.canvasH, true));
    cabinetFrameRef.current = { w: target.canvasW, h: target.canvasH };
    if (selectedId && !cabinets.some((c) => c.id === selectedId)) {
      setSelectedId(cabinets[0]?.id ?? null);
    } else if (!selectedId && cabinets[0]) {
      setSelectedId(cabinets[0].id);
    }
  }, [cabinets, roomDimensions?.width_m, roomDimensions?.length_m, roomDimensions?.canvas_w, roomDimensions?.canvas_h]);

  useEffect(() => {
    if (entrance) setDraftEntrance(entrance);
  }, [entrance?.wall, entrance?.offset]);

  useEffect(() => {
    fetch("/api/reports/shelving")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setShelvingReport(d); })
      .catch(() => {});
  }, [cabinets.length]);

  const selectedCab = draftCabinets.find((c) => c.id === selectedId) || null;
  const { canvasW, canvasH, pxPerCm } = getRoomCanvasSize(draftRoom);
  const roomBounds = getRoomBounds(canvasW, canvasH);

  const applyDraftRoomDimensions = (nextRoom: RoomDimensions) => {
    const nextCanvas = getRoomCanvasSize(nextRoom);
    const curFrame = cabinetFrameRef.current;
    setDraftRoom(nextRoom);
    if (Math.abs(curFrame.w - nextCanvas.canvasW) >= 1 || Math.abs(curFrame.h - nextCanvas.canvasH) >= 1) {
      setDraftCabinets((prev) => adaptCabinetsToCanvas(prev, curFrame.w, curFrame.h, nextCanvas.canvasW, nextCanvas.canvasH, false));
      cabinetFrameRef.current = { w: nextCanvas.canvasW, h: nextCanvas.canvasH };
    }
  };

  const getSvgCoords = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (ctm) {
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const transformed = pt.matrixTransform(ctm.inverse());
      return { x: transformed.x, y: transformed.y };
    }
    const rect = svg.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * canvasW,
      y: ((clientY - rect.top) / rect.height) * canvasH,
    };
  };

  const handlePointerDown = (e: React.PointerEvent, cab: CabinetRow) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const pt = getSvgCoords(e.clientX, e.clientY);
    dragRef.current = {
      type: "cabinet",
      id: cab.id,
      offsetX: pt.x - cab.x,
      offsetY: pt.y - cab.y,
      lastValidCab: { ...cab },
    };
    setSelectedId(cab.id);
  };

  const handleResizePointerDown = (e: React.PointerEvent, cab: CabinetRow, dir: ResizeDir) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const pt = getSvgCoords(e.clientX, e.clientY);
    dragRef.current = {
      type: "resize",
      id: cab.id,
      dir,
      startPt: pt,
      startCab: { ...cab },
      lastValidCab: { ...cab },
    };
    setSelectedId(cab.id);
  };

  const handleEntrancePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      type: "entrance",
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const pt = getSvgCoords(e.clientX, e.clientY);

    if (dragRef.current.type === "entrance") {
      if (!dragRef.current.moved) {
        const distPx = Math.hypot(e.clientX - dragRef.current.startClientX, e.clientY - dragRef.current.startClientY);
        if (distPx < 4) return;
        dragRef.current.moved = true;
      }
      const distTop = Math.abs(pt.y - 10);
      const distBottom = Math.abs(canvasH - 10 - pt.y);
      const distLeft = Math.abs(pt.x - 10);
      const distRight = Math.abs(canvasW - 10 - pt.x);
      const minD = Math.min(distTop, distBottom, distLeft, distRight);

      let wall: MapEntrance["wall"] = "bottom";
      let offset = 50;
      if (minD === distTop) {
        wall = "top";
        offset = ((pt.x - 10) / (canvasW - 20)) * 100;
      } else if (minD === distBottom) {
        wall = "bottom";
        offset = ((pt.x - 10) / (canvasW - 20)) * 100;
      } else if (minD === distLeft) {
        wall = "left";
        offset = ((pt.y - 10) / (canvasH - 20)) * 100;
      } else {
        wall = "right";
        offset = ((pt.y - 10) / (canvasH - 20)) * 100;
      }
      setDraftEntrance({
        wall,
        offset: Math.round(Math.max(10, Math.min(90, offset))),
      });
      return;
    }

    if (dragRef.current.type === "resize") {
      const { id, dir, startPt, startCab } = dragRef.current;
      const dxWorld = pt.x - startPt.x;
      const dyWorld = pt.y - startPt.y;
      const rad = ((startCab.rotation || 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);

      // Transform delta into cabinet local axis
      const dxLocal = dxWorld * cos + dyWorld * sin;
      const dyLocal = -dxWorld * sin + dyWorld * cos;

      let newWidth = startCab.width;
      let newHeight = startCab.height;
      let shiftLocalX = 0;
      let shiftLocalY = 0;

      if (dir.includes("e")) {
        newWidth = Math.max(20, Math.min(480, snapVal(startCab.width + dxLocal)));
        shiftLocalX = (newWidth - startCab.width) / 2;
      } else if (dir.includes("w")) {
        newWidth = Math.max(20, Math.min(480, snapVal(startCab.width - dxLocal)));
        shiftLocalX = -(newWidth - startCab.width) / 2;
      }

      if (dir.includes("s")) {
        newHeight = Math.max(20, Math.min(360, snapVal(startCab.height + dyLocal)));
        shiftLocalY = (newHeight - startCab.height) / 2;
      } else if (dir.includes("n")) {
        newHeight = Math.max(20, Math.min(360, snapVal(startCab.height - dyLocal)));
        shiftLocalY = -(newHeight - startCab.height) / 2;
      }

      const startCx = startCab.x + startCab.width / 2;
      const startCy = startCab.y + startCab.height / 2;
      const newCx = startCx + (shiftLocalX * cos - shiftLocalY * sin);
      const newCy = startCy + (shiftLocalX * sin + shiftLocalY * cos);

      const candidate: CabinetRow = {
        ...startCab,
        width: newWidth,
        height: newHeight,
        width_cm: Math.max(20, Math.round(newWidth / pxPerCm)),
        depth_cm: Math.max(20, Math.round(newHeight / pxPerCm)),
        x: newCx - newWidth / 2,
        y: newCy - newHeight / 2,
      };
      const clamped = clampRotatedCabinet(candidate, candidate.x, candidate.y, roomBounds);
      const nextCand: CabinetRow = { ...candidate, x: clamped.x, y: clamped.y };
      const others = draftCabinets.filter((c) => c.id !== id);
      const startOverlap = totalOverlapWithOthers(startCab, others);
      const nextOverlap = totalOverlapWithOthers(nextCand, others);

      if (snapEnabled && startOverlap <= 0 && nextOverlap > 0) {
        setSnapGuides(collectSnapGuides(dragRef.current.lastValidCab, others, roomBounds));
        return;
      }

      dragRef.current.lastValidCab = nextCand;
      setSnapGuides(snapEnabled ? collectSnapGuides(nextCand, others, roomBounds) : { x: [], y: [] });
      setDraftCabinets((prev) =>
        prev.map((c) => (c.id === id ? nextCand : c))
      );
      return;
    }

    const dragInfo = dragRef.current;
    const { id, offsetX, offsetY, lastValidCab } = dragInfo;
    const others = draftCabinets.filter((c) => c.id !== id);
    const currentCab = draftCabinets.find((c) => c.id === id);
    if (!currentCab) return;

    const rawCandidate: CabinetRow = {
      ...currentCab,
      x: pt.x - offsetX,
      y: pt.y - offsetY,
    };

    let finalPos: { x: number; y: number };
    if (snapEnabled) {
      const snapped = applyMagneticSnap(rawCandidate, others, roomBounds);
      finalPos = resolveNonOverlappingMove(
        { ...currentCab, x: snapped.x, y: snapped.y },
        lastValidCab,
        others,
        roomBounds
      );
      const finalCab = { ...currentCab, x: finalPos.x, y: finalPos.y };
      setSnapGuides(collectSnapGuides(finalCab, others, roomBounds));
      dragInfo.lastValidCab = finalCab;
    } else {
      finalPos = clampRotatedCabinet(currentCab, snapVal(rawCandidate.x), snapVal(rawCandidate.y), roomBounds);
      setSnapGuides({ x: [], y: [] });
      dragInfo.lastValidCab = { ...currentCab, x: finalPos.x, y: finalPos.y };
    }

    setDraftCabinets((prev) =>
      prev.map((c) => (c.id === id ? { ...c, x: finalPos.x, y: finalPos.y } : c))
    );
  };

  const handlePointerUp = () => {
    dragRef.current = null;
    setSnapGuides({ x: [], y: [] });
  };

  const updateSelectedField = (patch: Partial<CabinetRow>) => {
    if (!selectedCab) return;
    setDraftCabinets((prev) => {
      const others = prev.filter((c) => c.id !== selectedCab.id);
      return prev.map((c) => {
        if (c.id !== selectedCab.id) return c;
        const merged = { ...c, ...patch };
        const clamped = clampRotatedCabinet(merged, merged.x, merged.y, roomBounds);
        if (
          snapEnabled &&
          ("rotation" in patch || "width" in patch || "height" in patch || "width_cm" in patch || "depth_cm" in patch)
        ) {
          const resolved = resolveNonOverlappingMove({ ...merged, x: clamped.x, y: clamped.y }, c, others, roomBounds);
          return { ...merged, x: resolved.x, y: resolved.y };
        }
        return { ...merged, x: clamped.x, y: clamped.y };
      });
    });
  };

  const handleResolveAllOverlaps = () => {
    setDraftCabinets((prev) => {
      const placed: CabinetRow[] = [];
      for (const c of prev) {
        const cl = clampRotatedCabinet(c, c.x, c.y, roomBounds);
        const cand = { ...c, x: cl.x, y: cl.y };
        if (totalOverlapWithOthers(cand, placed) <= 0.5) {
          placed.push(cand);
          continue;
        }
        const pushed = pushOutOfOverlaps(cand, placed, roomBounds);
        if (!pushed.hasOverlap) {
          placed.push({ ...cand, x: pushed.x, y: pushed.y });
        } else {
          const free = findFreeSpotInRoom(cand, placed, roomBounds, cand.x, cand.y);
          placed.push({ ...cand, x: free.x, y: free.y });
        }
      }
      return placed;
    });
    setNotice("הארונות סודרו מחדש ללא חפיפה — לחץ 'שמור סידור מפה' לשמירה.");
  };

  const handleSaveLayout = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const roundedCabinets = draftCabinets.map((c) => {
        const cl = clampRotatedCabinet(c, c.x, c.y, roomBounds);
        return {
          ...c,
          x: cl.x,
          y: cl.y,
          width: Math.max(20, Math.round(c.width)),
          height: Math.max(20, Math.round(c.height)),
        };
      });
      const payloadRoom: RoomDimensions = {
        ...draftRoom,
        canvas_w: canvasW,
        canvas_h: canvasH,
      };
      const [cabRes, setRes] = await Promise.all([
        fetch("/api/cabinets/layout/batch", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cabinets: roundedCabinets }),
        }),
        fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ map_entrance: draftEntrance, room_dimensions: payloadRoom }),
        }),
      ]);
      if (!cabRes.ok || !setRes.ok) {
        throw new Error("שגיאה בשמירת המפה (" + cabRes.status + ")");
      }
      setNotice(t("map.saveMapSuccess"));
      await onReload();
    } catch (err: any) {
      setError(err?.message || "שגיאה בשמירה");
    } finally {
      setSaving(false);
    }
  };

  const handleAddCabinet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCode.trim()) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/cabinets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: newCode.trim(),
          main_subject: newSubject.trim(),
          shelves_count: Number(newShelves) || 5,
          ...(() => {
            const rawW = Math.max(20, Math.min(480, Math.round((Number(newWidthCm) || 120) * pxPerCm)));
            const rawH = Math.max(20, Math.min(360, Math.round((Number(newDepthCm) || 40) * pxPerCm)));
            const freeSpot = findFreeSpotInRoom(
              { width: rawW, height: rawH, rotation: 0 },
              draftCabinets,
              roomBounds,
              60 + ((draftCabinets.length * 30) % Math.max(120, canvasW - 140)),
              Math.round(canvasH / 2)
            );
            return { x: freeSpot.x, y: freeSpot.y };
          })(),
          width: Math.max(20, Math.min(480, Math.round((Number(newWidthCm) || 120) * pxPerCm))),
          height: Math.max(20, Math.min(360, Math.round((Number(newDepthCm) || 40) * pxPerCm))),
          width_cm: Number(newWidthCm) || 120,
          depth_cm: Number(newDepthCm) || 40,
          rotation: 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בהוספת ארון");
      setNewCode("");
      setNewSubject("");
      setNewShelves("5");
      setSelectedId(data.id);
      setNotice("הארון נוסף למפה — גרור אותו למיקום הרצוי ולחץ שמירה.");
      await onReload();
    } catch (err: any) {
      setError(err?.message || "שגיאה בהוספת ארון");
    }
  };

  const handleDeleteCabinet = async (id: number) => {
    setError(null);
    const res = await fetch("/api/cabinets/" + id, { method: "DELETE" });
    if (res.ok) {
      setNotice("הארון הוסר מהמפה.");
      await onReload();
    }
  };

  const handleScaleMapFromCm = () => {
    setDraftCabinets((prev) => {
      const placed: CabinetRow[] = [];
      for (const c of prev) {
        const wCm = Number(c.width_cm) > 0 ? Number(c.width_cm) : Math.round(c.width / pxPerCm);
        const dCm = Number(c.depth_cm) > 0 ? Number(c.depth_cm) : Math.round(c.height / pxPerCm);
        const wPx = Math.max(20, Math.min(480, Math.round(wCm * pxPerCm)));
        const hPx = Math.max(20, Math.min(360, Math.round(dCm * pxPerCm)));
        const merged = { ...c, width_cm: wCm, depth_cm: dCm, width: wPx, height: hPx };
        const clamped = clampRotatedCabinet(merged, merged.x, merged.y, roomBounds);
        const cand = { ...merged, x: clamped.x, y: clamped.y };
        if (snapEnabled && totalOverlapWithOthers(cand, placed) > 0.5) {
          const pushed = pushOutOfOverlaps(cand, placed, roomBounds);
          if (!pushed.hasOverlap) {
            placed.push({ ...cand, x: pushed.x, y: pushed.y });
          } else {
            const free = findFreeSpotInRoom(cand, placed, roomBounds, cand.x, cand.y);
            placed.push({ ...cand, x: free.x, y: free.y });
          }
        } else {
          placed.push(cand);
        }
      }
      return placed;
    });
    setNotice("מידות הארונות במפה הותאמו לקנה המידה האחיד של החדר.");
  };

  const handleDuplicateCabinet = async () => {
    if (!selectedCab) return;
    setDuplicatingCab(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/cabinets/${selectedCab.id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ copyBooks: dupCopyBooks }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בשכפול ארון");
      setSelectedId(data.cabinet?.id ?? null);
      setNotice(
        dupCopyBooks
          ? `הארון שוכפל בהצלחה (${data.cabinet?.code}) יחד עם ${data.copiedBooksCount || 0} ספרים.`
          : `הארון שוכפל בהצלחה (${data.cabinet?.code}).`
      );
      await onReload();
      loadShelvingReport();
    } catch (err: any) {
      setError(err?.message || "שגיאה בשכפול ארון");
    } finally {
      setDuplicatingCab(false);
    }
  };

  const handleAddShelfToSelected = async () => {
    if (!selectedCab) return;
    setRunningShelfAction(true);
    setError(null);
    try {
      const res = await fetch(`/api/cabinets/${selectedCab.id}/shelves/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_shelf" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בהוספת מדף");
      setNotice(`נוסף מדף לארון ${selectedCab.code} (סה״כ ${data.shelves_count} מדפים).`);
      await onReload();
      loadShelvingReport();
    } catch (err: any) {
      setError(err?.message || "שגיאה בהוספת מדף");
    } finally {
      setRunningShelfAction(false);
    }
  };

  const handleRunShelfAction = async () => {
    if (!selectedCab) return;
    setRunningShelfAction(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/cabinets/${selectedCab.id}/shelves/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: shelfActionMode,
          sourceShelf: sourceShelfNum,
          targetCabinetId: targetCabId || selectedCab.id,
          targetShelf: targetShelfNum,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בפעולת המדף");
      setNotice(
        shelfActionMode === "copy_books"
          ? `שוכפלו ${data.copiedCount || 0} ספרים למדף היעד עם ברקודים חדשים.`
          : `הועברו ${data.movedCount || 0} ספרים למדף היעד.`
      );
      await onReload();
      loadShelvingReport();
    } catch (err: any) {
      setError(err?.message || "שגיאה בפעולת מדף");
    } finally {
      setRunningShelfAction(false);
    }
  };

  const roomWidthM = Math.max(1, Number(draftRoom.width_m) || 8);
  const roomLengthM = Math.max(1, Number(draftRoom.length_m) || 6);
  const roomAreaSqm = Math.round(roomWidthM * roomLengthM * 100) / 100;
  const cabFootprintSqm = Math.round(
    draftCabinets.reduce((sum, c) => {
      const wCm = Number(c.width_cm) > 0 ? Number(c.width_cm) : Math.round(c.width / pxPerCm);
      const dCm = Number(c.depth_cm) > 0 ? Number(c.depth_cm) : Math.round(c.height / pxPerCm);
      return sum + (wCm / 100) * (dCm / 100);
    }, 0) * 100
  ) / 100;
  const aisleFreePct = roomAreaSqm > 0 ? Math.max(0, Math.round(((roomAreaSqm - cabFootprintSqm) / roomAreaSqm) * 100)) : 0;
  const overlappingIds = new Set<number>();
  for (let i = 0; i < draftCabinets.length; i++) {
    for (let j = i + 1; j < draftCabinets.length; j++) {
      if (getOverlapArea(getCabBounds(draftCabinets[i]), getCabBounds(draftCabinets[j])) > 0) {
        overlappingIds.add(draftCabinets[i].id);
        overlappingIds.add(draftCabinets[j].id);
      }
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">{t("map.editMapTitle")}</h2>
          <p className="text-sm text-[var(--otzar-text-muted)]">
            {t("map.pageSubtitle")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => setSmartOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border border-[var(--otzar-accent)] bg-[var(--otzar-surface)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-soft)] cursor-pointer whitespace-nowrap"
          >
            <Sparkles className="w-4 h-4" />
            {t("map.smartOrganizerButton")}
          </button>
          <button
            type="button"
            onClick={() => {
              setReportOpen(true);
              loadShelvingReport();
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border border-[var(--otzar-border)] bg-[var(--otzar-surface)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer whitespace-nowrap"
          >
            <BarChart3 className="w-4 h-4 text-[var(--otzar-accent)]" />
            דוח מידוף ותפוסה
          </button>
          <button
            type="button"
            onClick={handleSaveLayout}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <Save className="w-4 h-4" />
            {saving ? t("common.saving") : "שמור סידור מפה"}
          </button>
        </div>
      </div>

      {notice && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-sm">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>
      )}

      {/* Room Dimensions & m² Scale Bar */}
      <div className="p-4 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex flex-wrap items-end justify-between gap-4 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">אורך חדר (מ׳)</label>
            <input
              type="number"
              min={1}
              max={60}
              step="0.5"
              value={lengthInput}
              onChange={(e) => {
                const raw = e.target.value;
                setLengthInput(raw);
                const parsed = Number(raw);
                if (raw.trim() !== "" && Number.isFinite(parsed) && parsed >= 1 && parsed <= 60) {
                  applyDraftRoomDimensions({ ...draftRoom, length_m: parsed });
                }
              }}
              onBlur={() => {
                const parsed = Number(lengthInput);
                const safe = Number.isFinite(parsed) && parsed >= 1 ? Math.min(60, parsed) : draftRoom.length_m;
                setLengthInput(String(safe));
                if (safe !== draftRoom.length_m) applyDraftRoomDimensions({ ...draftRoom, length_m: safe });
              }}
              className="w-24 px-2.5 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">רוחב חדר (מ׳)</label>
            <input
              type="number"
              min={1}
              max={60}
              step="0.5"
              value={widthInput}
              onChange={(e) => {
                const raw = e.target.value;
                setWidthInput(raw);
                const parsed = Number(raw);
                if (raw.trim() !== "" && Number.isFinite(parsed) && parsed >= 1 && parsed <= 60) {
                  applyDraftRoomDimensions({ ...draftRoom, width_m: parsed });
                }
              }}
              onBlur={() => {
                const parsed = Number(widthInput);
                const safe = Number.isFinite(parsed) && parsed >= 1 ? Math.min(60, parsed) : draftRoom.width_m;
                setWidthInput(String(safe));
                if (safe !== draftRoom.width_m) applyDraftRoomDimensions({ ...draftRoom, width_m: safe });
              }}
              className="w-24 px-2.5 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
            />
          </div>
          <div className="text-xs text-[var(--otzar-text-muted)] tabular-nums pb-1.5 flex flex-wrap items-center gap-2">
            <span>שטח אולם: <strong className="text-[var(--otzar-text)]">{roomAreaSqm} מ״ר</strong></span>
            <span aria-hidden="true">·</span>
            <span>שטח ארונות: <strong className="text-[var(--otzar-text)]">{cabFootprintSqm} מ״ר</strong></span>
            <span aria-hidden="true">·</span>
            <span>מעברים פנויים: <strong className="text-[var(--otzar-accent)]">{aisleFreePct}%</strong></span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <label
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer select-none ${
              snapEnabled
                ? "border-[var(--otzar-accent)] bg-[var(--otzar-accent)]/10 text-[var(--otzar-accent)]"
                : "border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-[var(--otzar-text-muted)]"
            }`}
          >
            <input
              type="checkbox"
              checked={snapEnabled}
              onChange={(e) => setSnapEnabled(e.target.checked)}
              className="rounded accent-[var(--otzar-accent)]"
            />
            <Magnet className="w-3.5 h-3.5" />
            <span>מגנט והפרדת ארונות (SNAP)</span>
          </label>
          <button
            type="button"
            onClick={handleScaleMapFromCm}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] hover:bg-[var(--otzar-surface)] cursor-pointer"
          >
            <Ruler className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />
            סנכרן מידות ארונות (ס״מ) לקנה מידה
          </button>
        </div>
      </div>

      {/* Add new cabinet bar */}
      <form
        onSubmit={handleAddCabinet}
        className="p-4 rounded-xl border border-[var(--otzar-border)] bg-[var(--otzar-surface)] grid grid-cols-1 md:grid-cols-7 gap-3 items-end"
      >
        <div>
          <label className="block text-xs font-medium mb-1">קוד ארון חדש</label>
          <input
            type="text"
            required
            value={newCode}
            onChange={(e) => setNewCode(e.target.value)}
            placeholder="למשל: ה-1"
            className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium mb-1">נושא עיקרי</label>
          <input
            type="text"
            value={newSubject}
            onChange={(e) => setNewSubject(e.target.value)}
            placeholder="למשל: שו״ת ומפרשי הש״ס"
            className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">מדפים</label>
          <input
            type="number"
            min={1}
            max={20}
            value={newShelves}
            onChange={(e) => setNewShelves(e.target.value)}
            className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">רוחב (ס״מ)</label>
          <input
            type="number"
            min={30}
            max={500}
            value={newWidthCm}
            onChange={(e) => setNewWidthCm(e.target.value)}
            className="w-full px-2.5 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">עומק (ס״מ)</label>
          <input
            type="number"
            min={20}
            max={200}
            value={newDepthCm}
            onChange={(e) => setNewDepthCm(e.target.value)}
            className="w-full px-2.5 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
          />
        </div>
        <div>
          <button
            type="submit"
            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            הוסף ארון
          </button>
        </div>
      </form>

      {overlappingIds.size > 0 && (
        <div className="p-3 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-xs flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
            <span>זוהתה חפיפה בין {overlappingIds.size} ארונות במפה הקיימת. גרור ארון להפרדה או לחץ לסידור אוטומטי:</span>
          </div>
          <button
            type="button"
            onClick={handleResolveAllOverlaps}
            className="px-3 py-1 rounded-md text-xs font-bold bg-amber-600 text-white hover:bg-amber-700 cursor-pointer"
          >
            הפרד חפיפות אוטומטית
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        {/* Interactive Drag & Resize Canvas */}
        <div className="lg:col-span-2 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] overflow-hidden select-none">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${canvasW} ${canvasH}`}
            width={canvasW * 2}
            height={canvasH * 2}
            className="w-auto max-w-full h-auto max-h-[560px] mx-auto block touch-none"
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
          >
            <defs>
              <pattern id="editor-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="currentColor" strokeOpacity="0.09" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width={canvasW} height={canvasH} fill="url(#editor-grid)" />
            <rect x="10" y="10" width={canvasW - 20} height={canvasH - 20} rx="8" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />

            <EntranceMarker entrance={draftEntrance} canvasW={canvasW} canvasH={canvasH} draggable onPointerDown={handleEntrancePointerDown} />

            {draftCabinets.map((cab) => {
              const isSel = cab.id === selectedId;
              const isOverlapping = overlappingIds.has(cab.id);
              const cx = cab.x + cab.width / 2;
              const cy = cab.y + cab.height / 2;
              const transform = cab.rotation ? `rotate(${cab.rotation} ${cx} ${cy})` : undefined;

              return (
                <g key={cab.id}>
                  {/* Cabinet body */}
                  <g onPointerDown={(e) => handlePointerDown(e, cab)} className="cursor-move">
                    <rect
                      transform={transform}
                      x={cab.x}
                      y={cab.y}
                      width={cab.width}
                      height={cab.height}
                      rx="6"
                      fill={isSel ? "var(--otzar-accent)" : isOverlapping ? "#fef2f2" : "var(--otzar-bg)"}
                      stroke={isOverlapping ? "#dc2626" : isSel ? "var(--otzar-accent-hover)" : "var(--otzar-text-muted)"}
                      strokeWidth={isOverlapping || isSel ? "2.5" : "1.5"}
                    />
                    <text
                      x={cx}
                      y={cy - 4}
                      textAnchor="middle"
                      fontSize="14"
                      fontWeight="700"
                      fill={isSel ? "#ffffff" : "var(--otzar-text)"}
                      className="pointer-events-none"
                    >
                      {cab.code}
                    </text>
                    <text
                      x={cx}
                      y={cy + 13}
                      textAnchor="middle"
                      fontSize="10"
                      fill={isSel ? "#ffedd5" : "var(--otzar-text-muted)"}
                      className="pointer-events-none"
                    >
                      {cab.shelves_count} מדפים
                    </text>
                  </g>

                  {/* Edge & Corner Resize Handles when selected */}
                  {isSel && (
                    <g transform={transform}>
                      {/* 4 Edge hit strips */}
                      <rect
                        x={cab.x + 8}
                        y={cab.y - 5}
                        width={Math.max(10, cab.width - 16)}
                        height={10}
                        fill="transparent"
                        style={{ cursor: getHandleCursor("n", cab.rotation) }}
                        onPointerDown={(e) => handleResizePointerDown(e, cab, "n")}
                      />
                      <rect
                        x={cab.x + 8}
                        y={cab.y + cab.height - 5}
                        width={Math.max(10, cab.width - 16)}
                        height={10}
                        fill="transparent"
                        style={{ cursor: getHandleCursor("s", cab.rotation) }}
                        onPointerDown={(e) => handleResizePointerDown(e, cab, "s")}
                      />
                      <rect
                        x={cab.x - 5}
                        y={cab.y + 8}
                        width={10}
                        height={Math.max(10, cab.height - 16)}
                        fill="transparent"
                        style={{ cursor: getHandleCursor("w", cab.rotation) }}
                        onPointerDown={(e) => handleResizePointerDown(e, cab, "w")}
                      />
                      <rect
                        x={cab.x + cab.width - 5}
                        y={cab.y + 8}
                        width={10}
                        height={Math.max(10, cab.height - 16)}
                        fill="transparent"
                        style={{ cursor: getHandleCursor("e", cab.rotation) }}
                        onPointerDown={(e) => handleResizePointerDown(e, cab, "e")}
                      />

                      {/* Subtle edge midpoint grips */}
                      <rect x={cx - 10} y={cab.y - 3} width={20} height={6} rx="3" fill="#ffffff" stroke="var(--otzar-accent-hover)" strokeWidth="1.5" style={{ cursor: getHandleCursor("n", cab.rotation) }} onPointerDown={(e) => handleResizePointerDown(e, cab, "n")} />
                      <rect x={cx - 10} y={cab.y + cab.height - 3} width={20} height={6} rx="3" fill="#ffffff" stroke="var(--otzar-accent-hover)" strokeWidth="1.5" style={{ cursor: getHandleCursor("s", cab.rotation) }} onPointerDown={(e) => handleResizePointerDown(e, cab, "s")} />
                      <rect x={cab.x - 3} y={cy - 10} width={6} height={20} rx="3" fill="#ffffff" stroke="var(--otzar-accent-hover)" strokeWidth="1.5" style={{ cursor: getHandleCursor("w", cab.rotation) }} onPointerDown={(e) => handleResizePointerDown(e, cab, "w")} />
                      <rect x={cab.x + cab.width - 3} y={cy - 10} width={6} height={20} rx="3" fill="#ffffff" stroke="var(--otzar-accent-hover)" strokeWidth="1.5" style={{ cursor: getHandleCursor("e", cab.rotation) }} onPointerDown={(e) => handleResizePointerDown(e, cab, "e")} />

                      {/* 4 Corner handles */}
                      {(
                        [
                          { dir: "nw" as ResizeDir, hx: cab.x, hy: cab.y },
                          { dir: "ne" as ResizeDir, hx: cab.x + cab.width, hy: cab.y },
                          { dir: "sw" as ResizeDir, hx: cab.x, hy: cab.y + cab.height },
                          { dir: "se" as ResizeDir, hx: cab.x + cab.width, hy: cab.y + cab.height },
                        ]
                      ).map((h) => (
                        <rect
                          key={h.dir}
                          x={h.hx - 4.5}
                          y={h.hy - 4.5}
                          width={9}
                          height={9}
                          rx="2"
                          fill="#ffffff"
                          stroke="var(--otzar-accent-hover)"
                          strokeWidth="1.8"
                          style={{ cursor: getHandleCursor(h.dir, cab.rotation) }}
                          onPointerDown={(e) => handleResizePointerDown(e, cab, h.dir)}
                        />
                      ))}
                    </g>
                  )}
                </g>
              );
            })}

            {/* Magnetic SNAP alignment guide lines */}
            {snapGuides.x.map((gx) => (
              <line
                key={`gx-${gx}`}
                x1={gx}
                y1={roomBounds.minY}
                x2={gx}
                y2={roomBounds.maxY}
                stroke="var(--otzar-accent)"
                strokeWidth="1.2"
                strokeDasharray="4 3"
                strokeOpacity="0.85"
                className="pointer-events-none"
              />
            ))}
            {snapGuides.y.map((gy) => (
              <line
                key={`gy-${gy}`}
                x1={roomBounds.minX}
                y1={gy}
                x2={roomBounds.maxX}
                y2={gy}
                stroke="var(--otzar-accent)"
                strokeWidth="1.2"
                strokeDasharray="4 3"
                strokeOpacity="0.85"
                className="pointer-events-none"
              />
            ))}
          </svg>
        </div>

        {/* Right Side Inspector: Selected Cabinet */}
        <div className="space-y-4">
          <div className="p-4 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] space-y-4">
            <h3 className="font-bold text-base border-b border-[var(--otzar-border-muted)] pb-2">
              מאפייני הארון הנבחר
            </h3>

            {!selectedCab ? (
              <p className="text-sm text-[var(--otzar-text-muted)]">לחץ על ארון במפה כדי לערוך אותו.</p>
            ) : (
              <div className="space-y-3 text-sm">
                <div>
                  <label className="block text-xs font-medium mb-1">קוד ארון</label>
                  <input
                    type="text"
                    value={selectedCab.code}
                    onChange={(e) => updateSelectedField({ code: e.target.value })}
                    className="w-full px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">נושא / תיאור</label>
                  <input
                    type="text"
                    value={selectedCab.main_subject}
                    onChange={(e) => updateSelectedField({ main_subject: e.target.value })}
                    className="w-full px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">מדפים</label>
                    <input
                      type="number"
                      min={1}
                      max={25}
                      value={selectedCab.shelves_count}
                      onChange={(e) => updateSelectedField({ shelves_count: Math.max(1, Number(e.target.value) || 1) })}
                      className="w-full px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">סיבוב (מעלות)</label>
                    <button
                      type="button"
                      onClick={() => updateSelectedField({ rotation: (selectedCab.rotation + 90) % 360 })}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer tabular-nums"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                      {selectedCab.rotation}°
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">רוחב ארון (ס״מ)</label>
                    <input
                      type="number"
                      min={30}
                      max={600}
                      step={5}
                      value={selectedCab.width_cm ?? Math.round(selectedCab.width / pxPerCm)}
                      onChange={(e) => {
                        const cm = Math.max(20, Number(e.target.value) || 120);
                        updateSelectedField({
                          width_cm: cm,
                          width: Math.max(20, Math.min(480, Math.round(cm * pxPerCm))),
                        });
                      }}
                      className="w-full px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">עומק ארון (ס״מ)</label>
                    <input
                      type="number"
                      min={20}
                      max={300}
                      step={5}
                      value={selectedCab.depth_cm ?? Math.round(selectedCab.height / pxPerCm)}
                      onChange={(e) => {
                        const cm = Math.max(20, Number(e.target.value) || 40);
                        updateSelectedField({
                          depth_cm: cm,
                          height: Math.max(20, Math.min(360, Math.round(cm * pxPerCm))),
                        });
                      }}
                      className="w-full px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                    />
                  </div>
                </div>

                {/* Duplicate Cabinet */}
                <div className="pt-2.5 border-t border-[var(--otzar-border-muted)] space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={dupCopyBooks}
                        onChange={(e) => setDupCopyBooks(e.target.checked)}
                        className="rounded accent-[var(--otzar-accent)]"
                      />
                      <span>שכפל גם ספרים וברקודים</span>
                    </label>
                    <button
                      type="button"
                      disabled={duplicatingCab}
                      onClick={handleDuplicateCabinet}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-[var(--otzar-accent)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-soft)] cursor-pointer disabled:opacity-50"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      {duplicatingCab ? "משכפל..." : t("map.duplicateCabinet")}
                    </button>
                  </div>
                </div>

                {/* Shelf Actions & Capacity */}
                <div className="pt-2.5 border-t border-[var(--otzar-border-muted)] space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">מדפים וקיבולת</span>
                    <button
                      type="button"
                      disabled={runningShelfAction}
                      onClick={handleAddShelfToSelected}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      הוסף מדף
                    </button>
                  </div>
                  {(() => {
                    const cabRep = shelvingReport?.cabinets.find((c) => c.id === selectedCab.id);
                    if (!cabRep) return null;
                    return (
                      <div className="space-y-1 max-h-28 overflow-y-auto pl-1">
                        {cabRep.shelves.filter((s) => s.shelfNumber > 0).map((sh) => {
                          const pct = Math.min(130, Number(sh.fillPercent) || 0);
                          return (
                            <div key={sh.shelfNumber} className="flex items-center gap-2 tabular-nums">
                              <span className="w-12 shrink-0 text-[var(--otzar-text-muted)]">מדף {sh.shelfNumber}</span>
                              <div className="flex-1 h-1.5 rounded-full bg-[var(--otzar-surface-alt)] overflow-hidden">
                                <div
                                  className={`h-full ${sh.isOverloaded ? "bg-red-500" : pct > 85 ? "bg-amber-500" : "bg-[var(--otzar-accent)]"}`}
                                  style={{ width: `${Math.min(100, pct)}%` }}
                                />
                              </div>
                              <span className={`w-10 text-left ${sh.isOverloaded ? "text-red-600 font-bold" : "text-[var(--otzar-text-muted)]"}`}>
                                {pct}%
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                  <div className="p-2.5 rounded-lg bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] space-y-2">
                    <div className="font-semibold flex items-center gap-1">
                      <ArrowLeftRight className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />
                      <span>{t("map.duplicateShelf")}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <select
                        value={shelfActionMode}
                        onChange={(e) => setShelfActionMode(e.target.value as "move_books" | "copy_books")}
                        className="px-2 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                      >
                        <option value="move_books">העבר ספרים</option>
                        <option value="copy_books">שכפל עם ברקוד חדש</option>
                      </select>
                      <select
                        value={sourceShelfNum}
                        onChange={(e) => setSourceShelfNum(Number(e.target.value) || 1)}
                        className="px-2 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                      >
                        {Array.from({ length: selectedCab.shelves_count || 5 }, (_, i) => i + 1).map((s) => (
                          <option key={s} value={s}>ממדף {s}</option>
                        ))}
                      </select>
                      <select
                        value={targetCabId || selectedCab.id}
                        onChange={(e) => setTargetCabId(Number(e.target.value))}
                        className="px-2 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                      >
                        {draftCabinets.map((c) => (
                          <option key={c.id} value={c.id}>לארון {c.code}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={1}
                        max={25}
                        value={targetShelfNum}
                        onChange={(e) => setTargetShelfNum(Math.max(1, Number(e.target.value) || 1))}
                        placeholder="למדף"
                        className="px-2 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={runningShelfAction}
                      onClick={handleRunShelfAction}
                      className="w-full py-1.5 rounded bg-[var(--otzar-accent)] text-white font-semibold hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-50"
                    >
                      {runningShelfAction ? "מבצע..." : shelfActionMode === "copy_books" ? "שכפל מדף כעת" : "העבר מדף כעת"}
                    </button>
                  </div>
                </div>

                <div className="pt-2 border-t border-[var(--otzar-border-muted)] flex items-center justify-between">
                  <span className="text-xs text-[var(--otzar-text-muted)] tabular-nums">
                    X: {Math.round(selectedCab.x)} · Y: {Math.round(selectedCab.y)}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDeleteCabinet(selectedCab.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-red-600 hover:bg-red-50 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    מחק ארון
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {reportOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setReportOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-5xl rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-[var(--otzar-text)] overflow-hidden max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[var(--otzar-border-muted)] flex items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-[var(--otzar-accent)]" />
                  דוח מידוף ותפוסת ארונות
                </h3>
                <p className="text-xs text-[var(--otzar-text-muted)] mt-0.5">
                  סיכום כמות ספרים, רוחב מדף מצטבר (לפי עובי שדרה במ״מ) והתפלגות גדלים בכל ארון ומדף.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={loadShelvingReport}
                  disabled={reportLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${reportLoading ? "animate-spin" : ""}`} />
                  רענן
                </button>
                <button
                  type="button"
                  onClick={() => setReportOpen(false)}
                  className="p-2 rounded-lg hover:bg-[var(--otzar-surface-alt)] text-[var(--otzar-text-muted)] cursor-pointer"
                  aria-label="סגור דוח"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 overflow-y-auto space-y-5 text-sm">
              {reportError && (
                <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 text-xs">{reportError}</div>
              )}

              {reportLoading && !shelvingReport ? (
                <div className="py-12 text-center text-[var(--otzar-text-muted)]">מחשב נתוני מידוף...</div>
              ) : shelvingReport ? (
                <>
                  {shelvingReport.room && (
                    <div className="p-3.5 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex flex-wrap items-center justify-between gap-3 text-xs tabular-nums">
                      <span>מידות חדר: <strong className="text-[var(--otzar-text)]">{shelvingReport.room.length_m}מ׳ × {shelvingReport.room.width_m}מ׳ ({shelvingReport.room.areaSqm} מ״ר)</strong></span>
                      <span>שטח ארונות: <strong className="text-[var(--otzar-text)]">{shelvingReport.room.cabinetsFootprintSqm} מ״ר</strong></span>
                      <span>מעברים פנויים: <strong className="text-[var(--otzar-accent)]">{shelvingReport.room.aisleFreeSqm} מ״ר ({shelvingReport.room.aisleFreePercent}%)</strong></span>
                    </div>
                  )}

                  {/* Totals strip */}
                  <div className="grid grid-cols-2 md:grid-cols-5 divide-x divide-x-reverse divide-[var(--otzar-border-muted)] rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)]">
                    <div className="p-3.5">
                      <div className="text-xs text-[var(--otzar-text-muted)]">סה״כ ספרים</div>
                      <div className="text-xl font-bold tabular-nums mt-0.5">{shelvingReport.totals.totalBooks}</div>
                    </div>
                    <div className="p-3.5">
                      <div className="text-xs text-[var(--otzar-text-muted)]">משויכים לארונות</div>
                      <div className="text-xl font-bold tabular-nums mt-0.5">{shelvingReport.totals.assignedBooks}</div>
                    </div>
                    <div className="p-3.5">
                      <div className="text-xs text-[var(--otzar-text-muted)]">ללא שיוך לארון</div>
                      <div className="text-xl font-bold tabular-nums mt-0.5">{shelvingReport.totals.unassignedBooks}</div>
                    </div>
                    <div className="p-3.5">
                      <div className="text-xs text-[var(--otzar-text-muted)]">רוחב מדף מתועד</div>
                      <div className="text-xl font-bold tabular-nums mt-0.5">{shelvingReport.totals.totalThicknessCm} ס״מ</div>
                    </div>
                    <div className="p-3.5">
                      <div className="text-xs text-[var(--otzar-text-muted)]">ללא מידת עובי</div>
                      <div className="text-xl font-bold tabular-nums mt-0.5">{shelvingReport.totals.missingThicknessCount}</div>
                    </div>
                  </div>

                  {/* Format breakdown */}
                  <div className="text-xs text-[var(--otzar-text-muted)] flex flex-wrap items-center gap-2 border-b border-[var(--otzar-border-muted)] pb-3">
                    <span className="font-semibold text-[var(--otzar-text)]">התפלגות גדלים:</span>
                    {Object.entries(shelvingReport.totals.formatBreakdown).map(([fmt, cnt], idx) => (
                      <React.Fragment key={fmt}>
                        {idx > 0 && <span aria-hidden="true">·</span>}
                        <span className="tabular-nums">
                          {fmt}: <strong className="text-[var(--otzar-text)]">{cnt}</strong>
                        </span>
                      </React.Fragment>
                    ))}
                  </div>

                  {/* Per-Cabinet Tables */}
                  {shelvingReport.cabinets.length === 0 ? (
                    <div className="py-8 text-center text-[var(--otzar-text-muted)]">אין ארונות מוגדרים במפה עדיין.</div>
                  ) : (
                    <div className="space-y-4">
                      {shelvingReport.cabinets.map((cab) => (
                        <div key={cab.id} className="rounded-xl border border-[var(--otzar-border-muted)] overflow-hidden">
                          <div className="px-4 py-2.5 bg-[var(--otzar-surface)] border-b border-[var(--otzar-border-muted)] flex flex-wrap items-center justify-between gap-2">
                            <div className="font-semibold flex flex-wrap items-center gap-2">
                              <span>ארון {cab.code}</span>
                              {cab.main_subject && (
                                <>
                                  <span aria-hidden="true" className="text-[var(--otzar-text-muted)]">·</span>
                                  <span className="text-[var(--otzar-text-muted)] font-normal">{cab.main_subject}</span>
                                </>
                              )}
                            </div>
                            <div className="text-xs text-[var(--otzar-text-muted)] tabular-nums flex flex-wrap items-center gap-2">
                              <span>{cab.booksCount} ספרים</span>
                              <span aria-hidden="true">·</span>
                              <span>{cab.totalThicknessCm} ס״מ מתועדים</span>
                              <span aria-hidden="true">·</span>
                              <span>חסר עובי: {cab.missingThicknessCount}</span>
                            </div>
                          </div>

                          <table className="w-full text-xs text-right border-collapse">
                            <thead className="bg-[var(--otzar-surface-alt)] text-[var(--otzar-text-muted)] border-b border-[var(--otzar-border-muted)]">
                              <tr>
                                <th className="py-2 px-3 font-medium">מדף</th>
                                <th className="py-2 px-3 font-medium">ספרים</th>
                                <th className="py-2 px-3 font-medium">רוחב מצטבר / תפוסה</th>
                                <th className="py-2 px-3 font-medium">עובי ממוצע</th>
                                <th className="py-2 px-3 font-medium">חסר עובי</th>
                                <th className="py-2 px-3 font-medium">גדלים</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--otzar-border-muted)]">
                              {cab.shelves.map((sh) => {
                                const fmtSummary = Object.entries(sh.formatCounts)
                                  .map(([f, c]) => `${f} (${c})`)
                                  .join(" · ");
                                return (
                                  <tr key={sh.shelfNumber} className="hover:bg-[var(--otzar-surface-alt)]/50">
                                    <td className="py-2 px-3 font-semibold tabular-nums">
                                      {sh.shelfNumber > 0 ? `מדף ${sh.shelfNumber}` : "ללא מדף"}
                                    </td>
                                    <td className="py-2 px-3 tabular-nums">{sh.booksCount}</td>
                                    <td className="py-2 px-3 tabular-nums">
                                      <span>{sh.totalThicknessCm} ס״מ</span>
                                      {sh.estimatedCapacityCm ? (
                                        <span className={`mr-1.5 ${sh.isOverloaded ? "text-red-600 font-bold" : "text-[var(--otzar-text-muted)]"}`}>
                                          / {sh.estimatedCapacityCm} ({sh.fillPercent ?? 0}%)
                                        </span>
                                      ) : null}
                                    </td>
                                    <td className="py-2 px-3 tabular-nums">
                                      {sh.avgThicknessMm != null ? `${sh.avgThicknessMm} מ״מ` : "—"}
                                    </td>
                                    <td className="py-2 px-3 tabular-nums">{sh.missingThicknessCount}</td>
                                    <td className="py-2 px-3 text-[var(--otzar-text-muted)] tabular-nums">{fmtSummary || "—"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {smartOpen && (
        <SmartShelfOrganizerModal
          onClose={() => setSmartOpen(false)}
          onMovesApplied={async () => {
            await onReload();
            await loadShelvingReport();
          }}
        />
      )}
    </div>
  );
};
