import React, { useEffect, useRef, useState } from "react";
import { Plus, Save, RotateCw, Trash2, CheckCircle2, BarChart3, X, RefreshCw, Copy, Sparkles, ArrowLeftRight, Ruler } from "lucide-react";
import type { CabinetRow, MapEntrance, RoomDimensions, ShelvingReport } from "../types.ts";
import { DEFAULT_ENTRANCE, EntranceMarker, MAP_HEIGHT, MAP_WIDTH } from "./LibraryMap2D.tsx";
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
const snapVal = (v: number) => Math.round(v / SNAP) * SNAP;

function clampRotatedCabinet(c: CabinetRow, targetX: number, targetY: number) {
  const rad = ((c.rotation || 0) * Math.PI) / 180;
  const halfW = (Math.abs(c.width * Math.cos(rad)) + Math.abs(c.height * Math.sin(rad))) / 2;
  const halfH = (Math.abs(c.width * Math.sin(rad)) + Math.abs(c.height * Math.cos(rad))) / 2;
  const minCx = 15 + halfW;
  const maxCx = Math.max(minCx, MAP_WIDTH - 15 - halfW);
  const minCy = 15 + halfH;
  const maxCy = Math.max(minCy, MAP_HEIGHT - 20 - halfH);
  const targetCx = targetX + c.width / 2;
  const targetCy = targetY + c.height / 2;
  const clampedCx = Math.max(minCx, Math.min(maxCx, targetCx));
  const clampedCy = Math.max(minCy, Math.min(maxCy, targetCy));
  return {
    x: Math.round(clampedCx - c.width / 2),
    y: Math.round(clampedCy - c.height / 2),
  };
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
  const [draftCabinets, setDraftCabinets] = useState<CabinetRow[]>(cabinets);
  const [draftEntrance, setDraftEntrance] = useState<MapEntrance>(entrance || DEFAULT_ENTRANCE);
  const [draftRoom, setDraftRoom] = useState<RoomDimensions>(() => ({
    width_m: Number(roomDimensions?.width_m) > 0 ? Number(roomDimensions?.width_m) : 5,
    length_m: Number(roomDimensions?.length_m) > 0 ? Number(roomDimensions?.length_m) : 6,
  }));
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
    | { type: "cabinet"; id: number; offsetX: number; offsetY: number }
    | { type: "entrance" }
    | { type: "resize"; id: number; dir: ResizeDir; startPt: { x: number; y: number }; startCab: CabinetRow }
    | null
  >(null);

  useEffect(() => {
    setDraftCabinets(cabinets);
    if (selectedId && !cabinets.some((c) => c.id === selectedId)) {
      setSelectedId(cabinets[0]?.id ?? null);
    } else if (!selectedId && cabinets[0]) {
      setSelectedId(cabinets[0].id);
    }
  }, [cabinets]);

  useEffect(() => {
    if (entrance) setDraftEntrance(entrance);
  }, [entrance?.wall, entrance?.offset]);

  useEffect(() => {
    if (roomDimensions && (Number(roomDimensions.width_m) > 0 || Number(roomDimensions.length_m) > 0)) {
      setDraftRoom({
        width_m: Number(roomDimensions.width_m) > 0 ? Number(roomDimensions.width_m) : 5,
        length_m: Number(roomDimensions.length_m) > 0 ? Number(roomDimensions.length_m) : 6,
      });
    }
  }, [roomDimensions?.width_m, roomDimensions?.length_m]);

  useEffect(() => {
    fetch("/api/reports/shelving")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setShelvingReport(d); })
      .catch(() => {});
  }, [cabinets.length]);

  const selectedCab = draftCabinets.find((c) => c.id === selectedId) || null;
  const pxPerCmX = (MAP_WIDTH - 20) / Math.max(100, (Number(draftRoom.length_m) || 6) * 100);
  const pxPerCmY = (MAP_HEIGHT - 20) / Math.max(100, (Number(draftRoom.width_m) || 5) * 100);

  const getSvgCoords = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * MAP_WIDTH,
      y: ((clientY - rect.top) / rect.height) * MAP_HEIGHT,
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
    };
    setSelectedId(cab.id);
  };

  const handleEntrancePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { type: "entrance" };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const pt = getSvgCoords(e.clientX, e.clientY);

    if (dragRef.current.type === "entrance") {
      const distTop = Math.abs(pt.y - 10);
      const distBottom = Math.abs(MAP_HEIGHT - 10 - pt.y);
      const distLeft = Math.abs(pt.x - 10);
      const distRight = Math.abs(MAP_WIDTH - 10 - pt.x);
      const minD = Math.min(distTop, distBottom, distLeft, distRight);

      let wall: MapEntrance["wall"] = "bottom";
      let offset = 50;
      if (minD === distTop) {
        wall = "top";
        offset = ((pt.x - 10) / (MAP_WIDTH - 20)) * 100;
      } else if (minD === distBottom) {
        wall = "bottom";
        offset = ((pt.x - 10) / (MAP_WIDTH - 20)) * 100;
      } else if (minD === distLeft) {
        wall = "left";
        offset = ((pt.y - 10) / (MAP_HEIGHT - 20)) * 100;
      } else {
        wall = "right";
        offset = ((pt.y - 10) / (MAP_HEIGHT - 20)) * 100;
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
        newWidth = Math.max(40, Math.min(420, snapVal(startCab.width + dxLocal)));
        shiftLocalX = (newWidth - startCab.width) / 2;
      } else if (dir.includes("w")) {
        newWidth = Math.max(40, Math.min(420, snapVal(startCab.width - dxLocal)));
        shiftLocalX = -(newWidth - startCab.width) / 2;
      }

      if (dir.includes("s")) {
        newHeight = Math.max(30, Math.min(300, snapVal(startCab.height + dyLocal)));
        shiftLocalY = (newHeight - startCab.height) / 2;
      } else if (dir.includes("n")) {
        newHeight = Math.max(30, Math.min(300, snapVal(startCab.height - dyLocal)));
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
        width_cm: Math.max(30, Math.round(newWidth / pxPerCmX)),
        depth_cm: Math.max(20, Math.round(newHeight / pxPerCmY)),
        x: newCx - newWidth / 2,
        y: newCy - newHeight / 2,
      };
      const clamped = clampRotatedCabinet(candidate, candidate.x, candidate.y);
      setDraftCabinets((prev) =>
        prev.map((c) => (c.id === id ? { ...candidate, x: clamped.x, y: clamped.y } : c))
      );
      return;
    }

    const { id, offsetX, offsetY } = dragRef.current;
    setDraftCabinets((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const clamped = clampRotatedCabinet(c, snapVal(pt.x - offsetX), snapVal(pt.y - offsetY));
        return { ...c, x: clamped.x, y: clamped.y };
      })
    );
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  const updateSelectedField = (patch: Partial<CabinetRow>) => {
    if (!selectedCab) return;
    setDraftCabinets((prev) =>
      prev.map((c) => {
        if (c.id !== selectedCab.id) return c;
        const merged = { ...c, ...patch };
        const clamped = clampRotatedCabinet(merged, merged.x, merged.y);
        return { ...merged, x: clamped.x, y: clamped.y };
      })
    );
  };

  const handleSaveLayout = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const [cabRes, setRes] = await Promise.all([
        fetch("/api/cabinets/layout/batch", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cabinets: draftCabinets }),
        }),
        fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ map_entrance: draftEntrance, room_dimensions: draftRoom }),
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
            const rawW = Math.max(40, Math.min(420, Math.round((Number(newWidthCm) || 120) * pxPerCmX)));
            const rawH = Math.max(30, Math.min(300, Math.round((Number(newDepthCm) || 40) * pxPerCmY)));
            const clampedNew = clampRotatedCabinet({ width: rawW, height: rawH, rotation: 0 } as any, 60 + ((draftCabinets.length * 30) % 400), 240);
            return { x: clampedNew.x, y: clampedNew.y };
          })(),
          width: Math.max(40, Math.min(420, Math.round((Number(newWidthCm) || 120) * pxPerCmX))),
          height: Math.max(30, Math.min(300, Math.round((Number(newDepthCm) || 40) * pxPerCmY))),
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
    setDraftCabinets((prev) =>
      prev.map((c) => {
        const wCm = Number(c.width_cm) > 0 ? Number(c.width_cm) : Math.round(c.width / pxPerCmX);
        const dCm = Number(c.depth_cm) > 0 ? Number(c.depth_cm) : Math.round(c.height / pxPerCmY);
        const wPx = Math.max(40, Math.min(420, Math.round(wCm * pxPerCmX)));
        const hPx = Math.max(30, Math.min(300, Math.round(dCm * pxPerCmY)));
        const merged = { ...c, width_cm: wCm, depth_cm: dCm, width: wPx, height: hPx };
        const clamped = clampRotatedCabinet(merged, merged.x, merged.y);
        return { ...merged, x: clamped.x, y: clamped.y };
      })
    );
    setNotice("מידות הארונות במפה הותאמו לקנה המידה של החדר.");
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

  const roomWidthM = Math.max(1, Number(draftRoom.width_m) || 5);
  const roomLengthM = Math.max(1, Number(draftRoom.length_m) || 6);
  const roomAreaSqm = Math.round(roomWidthM * roomLengthM * 100) / 100;
  const cabFootprintSqm = Math.round(
    draftCabinets.reduce((sum, c) => {
      const wCm = Number(c.width_cm) > 0 ? Number(c.width_cm) : Math.round(c.width / pxPerCmX);
      const dCm = Number(c.depth_cm) > 0 ? Number(c.depth_cm) : Math.round(c.height / pxPerCmY);
      return sum + (wCm / 100) * (dCm / 100);
    }, 0) * 100
  ) / 100;
  const aisleFreePct = roomAreaSqm > 0 ? Math.max(0, Math.round(((roomAreaSqm - cabFootprintSqm) / roomAreaSqm) * 100)) : 0;

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
              value={draftRoom.length_m}
              onChange={(e) => setDraftRoom((p) => ({ ...p, length_m: Math.max(1, Number(e.target.value) || 1) }))}
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
              value={draftRoom.width_m}
              onChange={(e) => setDraftRoom((p) => ({ ...p, width_m: Math.max(1, Number(e.target.value) || 1) }))}
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
        <button
          type="button"
          onClick={handleScaleMapFromCm}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] hover:bg-[var(--otzar-surface)] cursor-pointer"
        >
          <Ruler className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />
          סנכרן מידות ארונות (ס״מ) לקנה מידה
        </button>
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        {/* Interactive Drag & Resize Canvas */}
        <div className="lg:col-span-2 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] overflow-hidden select-none">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
            className="w-full h-[420px] block touch-none"
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
          >
            <defs>
              <pattern id="editor-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="currentColor" strokeOpacity="0.09" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#editor-grid)" />
            <rect x="10" y="10" width={MAP_WIDTH - 20} height={MAP_HEIGHT - 20} rx="8" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />

            <EntranceMarker entrance={draftEntrance} draggable onPointerDown={handleEntrancePointerDown} />

            {draftCabinets.map((cab) => {
              const isSel = cab.id === selectedId;
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
                      fill={isSel ? "var(--otzar-accent)" : "var(--otzar-bg)"}
                      stroke={isSel ? "var(--otzar-accent-hover)" : "var(--otzar-text-muted)"}
                      strokeWidth={isSel ? "2.5" : "1.5"}
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
                      value={selectedCab.width_cm ?? Math.round(selectedCab.width / pxPerCmX)}
                      onChange={(e) => {
                        const cm = Math.max(30, Number(e.target.value) || 120);
                        updateSelectedField({
                          width_cm: cm,
                          width: Math.max(40, Math.min(420, Math.round(cm * pxPerCmX))),
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
                      value={selectedCab.depth_cm ?? Math.round(selectedCab.height / pxPerCmY)}
                      onChange={(e) => {
                        const cm = Math.max(20, Number(e.target.value) || 40);
                        updateSelectedField({
                          depth_cm: cm,
                          height: Math.max(30, Math.min(300, Math.round(cm * pxPerCmY))),
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
