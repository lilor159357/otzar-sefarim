import React, { useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  CheckCircle2,
  X,
  Loader2,
  ArrowLeftRight,
  AlertTriangle,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Layers,
  CircleDot,
  Undo2,
  Building2,
} from "lucide-react";
import type {
  CustomShelfOrderItem,
  MultiShelfSetAnalysis,
  MultiShelfSetMove,
  ShelfDirection,
  SmartShelfMove,
  SmartShelfPlan,
  SmartShelfPrefs,
} from "../types.ts";

interface SmartShelfOrganizerModalProps {
  onClose: () => void;
  onMovesApplied: () => Promise<void> | void;
}

const PREFS_STORAGE_KEY = "otzar_smart_shelf_prefs_v1";

function loadLocalPrefs(): SmartShelfPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        shelfDirection: parsed?.shelfDirection === "bottom_up" ? "bottom_up" : "top_down",
        customShelfOrders:
          parsed?.customShelfOrders && typeof parsed.customShelfOrders === "object"
            ? parsed.customShelfOrders
            : {},
      };
    }
  } catch {}
  return { shelfDirection: "top_down", customShelfOrders: {} };
}

function saveLocalPrefs(prefs: SmartShelfPrefs) {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {}
}

function compareNaturalCodes(aCode: string, bCode: string): number {
  const aParts = String(aCode || "").trim().split(/(\d+)/);
  const bParts = String(bCode || "").trim().split(/(\d+)/);
  const maxLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLen; i++) {
    const ap = aParts[i] ?? "";
    const bp = bParts[i] ?? "";
    if (!ap && !bp) continue;
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) {
      const diff = Number(ap) - Number(bp);
      if (diff !== 0) return diff;
    } else {
      const cmp = ap.localeCompare(bp, "he", { sensitivity: "base" });
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

const SEVERITY_LABEL: Record<SmartShelfMove["severity"], { text: string; cls: string }> = {
  high: { text: "דחוף", cls: "text-red-700 dark:text-red-400 font-bold" },
  warning: { text: "מומלץ", cls: "text-amber-700 dark:text-amber-400 font-semibold" },
  info: { text: "אופטימיזציה", cls: "text-[var(--otzar-accent)] font-medium" },
};

export const SmartShelfOrganizerModal: React.FC<SmartShelfOrganizerModalProps> = ({
  onClose,
  onMovesApplied,
}) => {
  const [useAi, setUseAi] = useState(false);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<SmartShelfPlan | null>(null);
  const [prefs, setPrefs] = useState<SmartShelfPrefs>(() => loadLocalPrefs());
  const [setModes, setSetModes] = useState<Record<string, "minimal" | "rebalance">>({});
  const [expandedSequences, setExpandedSequences] = useState<Record<string, boolean>>({});
  const [showOrderedSets, setShowOrderedSets] = useState(false);

  // Click-to-record shelf order mode + 2D cabinet grid controls
  const [recordingSetName, setRecordingSetName] = useState<string | null>(null);
  const [recordedChain, setRecordedChain] = useState<CustomShelfOrderItem[]>([]);
  const [showAllCabsForSet, setShowAllCabsForSet] = useState<Record<string, boolean>>({});

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const persistPrefs = async (nextPrefs: SmartShelfPrefs) => {
    setPrefs(nextPrefs);
    saveLocalPrefs(nextPrefs);
    try {
      await fetch("/api/shelving/smart-organize-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextPrefs),
      });
    } catch {}
  };

  const syncDefaultSelections = (
    nextPlan: SmartShelfPlan,
    modesMap: Record<string, "minimal" | "rebalance">
  ) => {
    const defaultSelected = new Set<string>();
    for (const mv of nextPlan.moves) {
      if (mv.barcodes && mv.barcodes.length > 0 && mv.toCabinetId && mv.toShelf) {
        defaultSelected.add(mv.id);
      }
    }
    for (const ms of nextPlan.multiShelfSets || []) {
      const m = modesMap[ms.setName] || "minimal";
      const modeRes = m === "rebalance" ? ms.rebalanceMode : ms.minimalMode;
      for (const mv of modeRes.moves) {
        if (mv.barcodes.length > 0 && mv.toCabinetId && mv.toShelf && !mv.hasBorrowed) {
          defaultSelected.add(mv.id);
        }
      }
    }
    setSelectedIds(defaultSelected);
  };

  const runAnalysis = async (
    withAi: boolean,
    overridePrefs?: SmartShelfPrefs,
    currentModes?: Record<string, "minimal" | "rebalance">
  ) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    const activePrefs = overridePrefs || prefs;
    try {
      const res = await fetch("/api/shelving/smart-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          useAi: withAi,
          prefs: activePrefs,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "שגיאה בניתוח מסדר המדפים");
      const nextPlan: SmartShelfPlan = {
        moves: Array.isArray(json.moves) ? json.moves : [],
        multiShelfSets: Array.isArray(json.multiShelfSets) ? json.multiShelfSets : [],
        prefs: json.prefs || activePrefs,
        cabinetsMeta: Array.isArray(json.cabinetsMeta) ? json.cabinetsMeta : [],
        summary: String(json.summary || ""),
        usedAi: Boolean(json.aiUsed ?? json.usedAi),
        aiError: json.aiError || null,
      };
      if (json.prefs && !overridePrefs) {
        const mergedPrefs: SmartShelfPrefs = {
          shelfDirection:
            json.prefs.shelfDirection === "bottom_up"
              ? "bottom_up"
              : activePrefs.shelfDirection || "top_down",
          customShelfOrders:
            json.prefs.customShelfOrders && Object.keys(json.prefs.customShelfOrders).length > 0
              ? json.prefs.customShelfOrders
              : activePrefs.customShelfOrders,
        };
        setPrefs(mergedPrefs);
        saveLocalPrefs(mergedPrefs);
      }

      const activeModes = { ...(currentModes || setModes) };
      const nextExpanded: Record<string, boolean> = { ...expandedSequences };
      for (const ms of nextPlan.multiShelfSets || []) {
        if (!(ms.setName in activeModes)) {
          activeModes[ms.setName] = "minimal";
        }
        if (!(ms.setName in nextExpanded) && !ms.minimalMode.isOrdered) {
          nextExpanded[ms.setName] = true;
        }
      }
      setSetModes(activeModes);
      setExpandedSequences(nextExpanded);
      setPlan(nextPlan);
      syncDefaultSelections(nextPlan, activeModes);
    } catch (err: any) {
      setError(err?.message || "שגיאה בניתוח");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runAnalysis(false);
  }, []);

  const standardActionableMoves = useMemo(
    () =>
      (plan?.moves || []).filter(
        (m) => m.barcodes && m.barcodes.length > 0 && m.toCabinetId && m.toShelf
      ),
    [plan]
  );

  const activeMultiShelfMoves = useMemo(() => {
    const list: MultiShelfSetMove[] = [];
    for (const ms of plan?.multiShelfSets || []) {
      const m = setModes[ms.setName] || "minimal";
      const modeRes = m === "rebalance" ? ms.rebalanceMode : ms.minimalMode;
      for (const mv of modeRes.moves) {
        if (mv.barcodes.length > 0 && mv.toCabinetId && mv.toShelf) {
          list.push(mv);
        }
      }
    }
    return list;
  }, [plan, setModes]);

  const allActionableMoves = useMemo(
    () => [
      ...standardActionableMoves.map((m) => ({
        id: m.id,
        toCabinetId: m.toCabinetId!,
        toShelf: m.toShelf!,
        barcodes: m.barcodes!,
      })),
      ...activeMultiShelfMoves.map((m) => ({
        id: m.id,
        toCabinetId: m.toCabinetId,
        toShelf: m.toShelf,
        barcodes: m.barcodes,
      })),
    ],
    [standardActionableMoves, activeMultiShelfMoves]
  );

  const selectedActionableCount = allActionableMoves.filter((m) => selectedIds.has(m.id)).length;

  const handleToggleMoveSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDirectionChange = async (dir: ShelfDirection) => {
    if (prefs.shelfDirection === dir) return;
    const nextPrefs: SmartShelfPrefs = {
      ...prefs,
      shelfDirection: dir,
    };
    await persistPrefs(nextPrefs);
    await runAnalysis(useAi, nextPrefs);
  };

  const handleSetModeChange = (ms: MultiShelfSetAnalysis, nextMode: "minimal" | "rebalance") => {
    const nextModes = { ...setModes, [ms.setName]: nextMode };
    setSetModes(nextModes);

    const oldModeRes = nextMode === "rebalance" ? ms.minimalMode : ms.rebalanceMode;
    const newModeRes = nextMode === "rebalance" ? ms.rebalanceMode : ms.minimalMode;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const mv of oldModeRes.moves) next.delete(mv.id);
      for (const mv of newModeRes.moves) {
        if (!mv.hasBorrowed) next.add(mv.id);
      }
      return next;
    });
    setExpandedSequences((prev) => ({ ...prev, [ms.setName]: true }));
  };

  const updateSetChain = async (
    ms: MultiShelfSetAnalysis,
    nextChain: CustomShelfOrderItem[] | null
  ) => {
    const nextCustom = { ...prefs.customShelfOrders };
    if (!nextChain || nextChain.length === 0) {
      delete nextCustom[ms.setName];
      delete nextCustom[ms.setName.toLowerCase()];
    } else {
      nextCustom[ms.setName] = nextChain;
    }
    const nextPrefs: SmartShelfPrefs = {
      ...prefs,
      customShelfOrders: nextCustom,
    };
    await persistPrefs(nextPrefs);
    await runAnalysis(useAi, nextPrefs);
  };

  const startRecording = (ms: MultiShelfSetAnalysis) => {
    setRecordingSetName(ms.setName);
    setRecordedChain([]);
  };

  const cancelRecording = () => {
    setRecordingSetName(null);
    setRecordedChain([]);
  };

  const handleShelfClickIn2DGrid = async (
    ms: MultiShelfSetAnalysis,
    cabinetId: number,
    shelfNumber: number,
    isInSetChain: boolean,
    isManuallyAdded: boolean
  ) => {
    const isRecording = recordingSetName === ms.setName;
    if (isRecording) {
      setRecordedChain((prev) => {
        const existingIdx = prev.findIndex(
          (x) => x.cabinetId === cabinetId && x.shelfNumber === shelfNumber
        );
        if (existingIdx >= 0) {
          return prev.filter((_, idx) => idx !== existingIdx);
        }
        return [
          ...prev,
          {
            cabinetId,
            shelfNumber,
            manual: !isInSetChain || isManuallyAdded,
          },
        ];
      });
      return;
    }

    // Outside recording mode: clicking an empty shelf toggles adding/removing it in the set chain
    if (!isInSetChain) {
      const nextChain: CustomShelfOrderItem[] = [
        ...ms.shelfChain.map((s) => ({
          cabinetId: s.cabinetId,
          shelfNumber: s.shelfNumber,
          manual: s.isManuallyAdded,
        })),
        { cabinetId, shelfNumber, manual: true },
      ];
      await updateSetChain(ms, nextChain);
    } else if (isManuallyAdded) {
      const nextChain: CustomShelfOrderItem[] = ms.shelfChain
        .filter((s) => !(s.cabinetId === cabinetId && s.shelfNumber === shelfNumber))
        .map((s) => ({
          cabinetId: s.cabinetId,
          shelfNumber: s.shelfNumber,
          manual: s.isManuallyAdded,
        }));
      await updateSetChain(ms, nextChain);
    }
  };

  const finishRecording = async (ms: MultiShelfSetAnalysis) => {
    if (recordedChain.length === 0) {
      cancelRecording();
      return;
    }
    const chainCopy = [...recordedChain];
    setRecordingSetName(null);
    setRecordedChain([]);
    await updateSetChain(ms, chainCopy);
  };

  const handleApplySelected = async () => {
    const toApply = allActionableMoves.filter((m) => selectedIds.has(m.id));
    if (toApply.length === 0) return;
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/shelving/apply-moves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          moves: toApply.map((m) => ({
            toCabinetId: m.toCabinetId,
            toShelf: m.toShelf,
            barcodes: m.barcodes,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "שגיאה ביישום המהלכים");
      setNotice(`הסידור הושלם בהצלחה: ${json.movedBooks || 0} ספרים הועברו למיקום המעודכן.`);
      await onMovesApplied();
      await runAnalysis(useAi);
    } catch (err: any) {
      setError(err?.message || "שגיאה ביישום הסידור");
    } finally {
      setApplying(false);
    }
  };

  const multiShelfSets = plan?.multiShelfSets || [];
  const disorderedSets = multiShelfSets.filter(
    (ms) => !ms.minimalMode.isOrdered || ms.shelfChain.some((s) => s.foreignAlerts.length > 0)
  );
  const orderedSets = multiShelfSets.filter(
    (ms) => ms.minimalMode.isOrdered && ms.shelfChain.every((s) => s.foreignAlerts.length === 0)
  );

  const renderMultiShelfCard = (ms: MultiShelfSetAnalysis) => {
    const activeMode = setModes[ms.setName] || "minimal";
    const modeRes = activeMode === "rebalance" ? ms.rebalanceMode : ms.minimalMode;
    const isSeqExpanded = Boolean(expandedSequences[ms.setName]);
    const isRecording = recordingSetName === ms.setName;
    const showAllCabs = Boolean(showAllCabsForSet[ms.setName]);

    const foreignAlertsAll = ms.shelfChain.flatMap((step) =>
      step.foreignAlerts.map((fa) => ({
        ...fa,
        cabinetCode: step.cabinetCode,
        shelfNumber: step.shelfNumber,
      }))
    );

    const chainIndexMap = new Map<string, { order: number; step: typeof ms.shelfChain[number] }>();
    ms.shelfChain.forEach((step, idx) => {
      chainIndexMap.set(`${step.cabinetId}:${step.shelfNumber}`, { order: idx + 1, step });
    });

    const shelfPlanMap = new Map<string, typeof modeRes.shelfPlans[number]>();
    modeRes.shelfPlans.forEach((sp) => {
      shelfPlanMap.set(`${sp.cabinetId}:${sp.shelfNumber}`, sp);
    });

    const recordedIndexMap = new Map<string, number>();
    if (isRecording) {
      recordedChain.forEach((rc, idx) => {
        recordedIndexMap.set(`${rc.cabinetId}:${rc.shelfNumber}`, idx + 1);
      });
    }

    // Build 2D cabinet list: participating cabinets (or all cabinets when toggled) sorted naturally
    const participatingCabIds = new Set(ms.shelfChain.map((s) => s.cabinetId));
    const allCabsMeta = plan?.cabinetsMeta || [];
    const displayCabinets = (
      showAllCabs
        ? allCabsMeta
        : allCabsMeta.filter((c) => participatingCabIds.has(c.id))
    ).sort((a, b) => compareNaturalCodes(a.code, b.code));

    return (
      <div
        key={ms.setName}
        className="rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] overflow-hidden"
      >
        {/* Set Header + Segmented Mode Switcher */}
        <div className="p-4 bg-[var(--otzar-surface)] border-b border-[var(--otzar-border-muted)] flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Layers className="w-4 h-4 text-[var(--otzar-accent)] shrink-0" />
              <h4 className="font-bold text-sm">{ms.setName}</h4>
              {ms.minimalMode.isOrdered && activeMode === "minimal" ? (
                <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  · רצף תקין
                </span>
              ) : (
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                  · זוהו {modeRes.movesCount} כרכים להעברה
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--otzar-text-muted)] tabular-nums">
              <span>{ms.assignedCount} כרכים משויכים</span>
              <span aria-hidden="true">·</span>
              <span>{ms.shelfChain.length} מדפים בשרשרת</span>
              <span aria-hidden="true">·</span>
              <span>{ms.totalAssignedCm} ס״מ סה״כ</span>
              {ms.borrowedCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{ms.borrowedCount} מושאלים (מקומם שמור)</span>
                </>
              )}
              {ms.activeMissingCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{ms.activeMissingCount} חסרים מזוהים</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] shrink-0">
            <button
              type="button"
              onClick={() => handleSetModeChange(ms, "minimal")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap cursor-pointer transition-colors ${
                activeMode === "minimal"
                  ? "bg-[var(--otzar-bg)] text-[var(--otzar-text)] font-bold shadow-sm"
                  : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
              }`}
            >
              תיקון מינימלי (LIS)
            </button>
            <button
              type="button"
              onClick={() => handleSetModeChange(ms, "rebalance")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap cursor-pointer transition-colors ${
                activeMode === "rebalance"
                  ? "bg-[var(--otzar-bg)] text-[var(--otzar-text)] font-bold shadow-sm"
                  : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
              }`}
            >
              פריסה מחדש מאוזנת לפי ס״מ
            </button>
          </div>
        </div>

        <div className="divide-y divide-[var(--otzar-border-muted)]">
          {/* Unassigned books info */}
          {ms.unassignedCount > 0 && (
            <div className="px-4 py-2 text-xs text-[var(--otzar-text-muted)] bg-[var(--otzar-surface-alt)]/50 tabular-nums">
              {ms.unassignedCount} כרכים נוספים בסט טרם שויכו לארון/מדף (מוחרגים מבדיקת החריגים)
            </div>
          )}

          {/* 2D Cabinet & Shelf Grid + Click-to-Record Order */}
          <div className="p-4 space-y-3 bg-[var(--otzar-surface-alt)]/25">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="space-y-0.5">
                <div className="font-bold text-[var(--otzar-text)]">
                  מבט ארונות דו-ממדי והיררכיית המדפים
                </div>
                <div className="text-[11px] text-[var(--otzar-text-muted)]">
                  {isRecording
                    ? "לחץ על המדפים בארונות לפי הסדר הפיזי הרצוי (#1 ← #2 ← #3...). לחיצה חוזרת על מדף תסיר אותו."
                    : "מוצגים הארונות והמדפים של הסט במבנה דו-ממדי. ניתן להקליט סדר מדפים בלחיצות או לצרף מדף פנוי בלחיצה עליו."}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setShowAllCabsForSet((prev) => ({
                      ...prev,
                      [ms.setName]: !prev[ms.setName],
                    }))
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-[11px] font-medium hover:text-[var(--otzar-accent)] cursor-pointer whitespace-nowrap"
                >
                  <Building2 className="w-3.5 h-3.5" />
                  {showAllCabs ? "הצג רק ארונות הסט" : "הצג את כל ארונות הספרייה"}
                </button>

                {ms.hasCustomOrder && !isRecording && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => updateSetChain(ms, null)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-[11px] font-medium hover:text-[var(--otzar-accent)] cursor-pointer whitespace-nowrap"
                  >
                    <RotateCcw className="w-3 h-3" />
                    איפוס לסדר טבעי
                  </button>
                )}

                {!isRecording ? (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => startRecording(ms)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--otzar-accent)] text-white text-xs font-bold hover:bg-[var(--otzar-accent-hover)] cursor-pointer whitespace-nowrap"
                  >
                    <CircleDot className="w-3.5 h-3.5" />
                    הקלט סדר מדפים בלחיצה
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={recordedChain.length === 0}
                      onClick={() => setRecordedChain((prev) => prev.slice(0, -1))}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs font-medium cursor-pointer disabled:opacity-40 whitespace-nowrap"
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                      בטל צעד
                    </button>
                    <button
                      type="button"
                      onClick={cancelRecording}
                      className="px-2.5 py-1.5 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs font-medium cursor-pointer whitespace-nowrap"
                    >
                      ביטול
                    </button>
                    <button
                      type="button"
                      disabled={recordedChain.length === 0 || loading}
                      onClick={() => finishRecording(ms)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 cursor-pointer disabled:opacity-40 whitespace-nowrap tabular-nums"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      סיים והחל סדר ({recordedChain.length})
                    </button>
                  </>
                )}
              </div>
            </div>

            {isRecording && (
              <div className="px-3 py-2 rounded-lg border border-[var(--otzar-accent)]/40 bg-[var(--otzar-accent)]/10 text-xs flex flex-wrap items-center justify-between gap-2 tabular-nums">
                <span className="font-semibold text-[var(--otzar-accent)]">
                  מצב הקלטה פעיל — נבחרו עד כה {recordedChain.length} מדפים:
                  {recordedChain.length > 0 &&
                    " " +
                      recordedChain
                        .map((rc, i) => {
                          const cab = allCabsMeta.find((c) => c.id === rc.cabinetId);
                          return `#${i + 1} ${cab?.code || "?"}:${rc.shelfNumber}`;
                        })
                        .join(" ← ")}
                </span>
              </div>
            )}

            {/* 2D Cabinets Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {displayCabinets.map((cab) => {
                const count = Math.max(1, cab.shelves_count || 5);
                const shelfNums = Array.from({ length: count }, (_, idx) =>
                  prefs.shelfDirection === "bottom_up" ? count - idx : idx + 1
                );

                return (
                  <div
                    key={cab.id}
                    className="rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] overflow-hidden flex flex-col"
                  >
                    <div className="px-3 py-2 bg-[var(--otzar-surface)] border-b border-[var(--otzar-border-muted)] flex items-center justify-between gap-2 text-xs">
                      <span className="font-bold">ארון {cab.code}</span>
                      {cab.main_subject && (
                        <span className="text-[11px] text-[var(--otzar-text-muted)] truncate">
                          {cab.main_subject}
                        </span>
                      )}
                    </div>

                    <div className="divide-y divide-[var(--otzar-border-muted)]">
                      {shelfNums.map((sNum) => {
                        const key = `${cab.id}:${sNum}`;
                        const inChain = chainIndexMap.get(key);
                        const sp = shelfPlanMap.get(key);
                        const shelfReport = cab.shelves?.find((sh) => sh.shelfNumber === sNum);
                        const recNum = recordedIndexMap.get(key);
                        const capCm = sp?.capacityCm || shelfReport?.estimatedCapacityCm || 116;
                        const usedCm = sp ? sp.projectedUsedCm : shelfReport?.totalThicknessCm || 0;
                        const pct = capCm > 0 ? Math.min(100, Math.round((usedCm / capCm) * 100)) : 0;
                        const isOver = sp ? sp.isOverflow : (shelfReport?.fillPercent || 0) > 100;

                        const booksInSetCount = sp
                          ? sp.expectedItems.reduce(
                              (acc, it) => (it.kind !== "missing_slot" ? acc + it.copiesCount : acc),
                              0
                            )
                          : 0;
                        const hasMovesOnShelf =
                          Boolean(sp && (sp.outgoingItems.length > 0 || sp.expectedItems.some((it) => it.kind === "incoming")));

                        const badgeOrder = isRecording ? recNum : inChain?.order;

                        return (
                          <button
                            key={sNum}
                            type="button"
                            disabled={loading}
                            onClick={() =>
                              handleShelfClickIn2DGrid(
                                ms,
                                cab.id,
                                sNum,
                                Boolean(inChain),
                                Boolean(inChain?.step.isManuallyAdded)
                              )
                            }
                            title={
                              isRecording
                                ? recNum
                                  ? `לחץ להסרה מסדר ההקלטה (נבחר כ-#${recNum})`
                                  : `לחץ להוספה כמדף הבא בסדר ההקלטה`
                                : inChain
                                ? inChain.step.isManuallyAdded
                                  ? "מדף פנוי שצורף ידנית — לחץ להסרתו מהשרשרת"
                                  : `מדף #${inChain.order} בשרשרת הסט`
                                : "מדף מחוץ לשרשרת — לחץ לצרף אותו לשרשרת הסט"
                            }
                            className={`w-full px-2.5 py-2 text-right transition-colors cursor-pointer flex flex-col gap-1 ${
                              isRecording
                                ? recNum
                                  ? "bg-[var(--otzar-accent)]/15 hover:bg-[var(--otzar-accent)]/20"
                                  : inChain
                                  ? "bg-amber-50/50 dark:bg-amber-950/15 hover:bg-[var(--otzar-surface-alt)]"
                                  : "hover:bg-[var(--otzar-surface-alt)] opacity-75 hover:opacity-100"
                                : inChain
                                ? hasMovesOnShelf
                                  ? "bg-amber-50/60 dark:bg-amber-950/20 hover:bg-amber-100/50 dark:hover:bg-amber-950/30"
                                  : "bg-[var(--otzar-surface)]/50 hover:bg-[var(--otzar-surface-alt)]"
                                : "opacity-60 hover:opacity-100 hover:bg-[var(--otzar-surface-alt)]"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
                              <div className="flex items-center gap-1.5 min-w-0">
                                {badgeOrder != null ? (
                                  <span
                                    className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded text-[10px] font-bold text-white ${
                                      isRecording ? "bg-emerald-600" : "bg-[var(--otzar-accent)]"
                                    }`}
                                  >
                                    {badgeOrder}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded text-[10px] border border-dashed border-[var(--otzar-border-muted)] text-[var(--otzar-text-muted)]">
                                    +
                                  </span>
                                )}
                                <span className="font-bold">מדף {sNum}</span>
                                {inChain?.step.isManuallyAdded && (
                                  <span className="text-[10px] text-[var(--otzar-accent)]">(נוסף)</span>
                                )}
                              </div>
                              <span className="text-[10px] text-[var(--otzar-text-muted)]">
                                {inChain
                                  ? booksInSetCount > 0
                                    ? `${booksInSetCount} כרכים`
                                    : "ריק לשרשרת"
                                  : shelfReport && shelfReport.booksCount > 0
                                  ? `${shelfReport.booksCount} ספרים אחרים`
                                  : "מדף פנוי"}
                              </span>
                            </div>

                            {/* Shelf fill progress bar */}
                            <div className="flex items-center gap-2 text-[10px] tabular-nums text-[var(--otzar-text-muted)]">
                              <div className="flex-1 h-1.5 rounded-full bg-[var(--otzar-surface-alt)] overflow-hidden">
                                <div
                                  style={{ width: `${pct}%` }}
                                  className={`h-full transition-all ${
                                    isOver
                                      ? "bg-red-600"
                                      : pct > 85
                                      ? "bg-amber-500"
                                      : inChain
                                      ? "bg-[var(--otzar-accent)]"
                                      : "bg-slate-400"
                                  }`}
                                />
                              </div>
                              <span>{Math.round(usedCm)}/{Math.round(capCm)} ס״מ</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Alerts: Capacity overflow / Needs extra shelf / Foreign category books */}
          {activeMode === "minimal" && modeRes.hasCapacityOverflow && (
            <div className="p-3 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 text-xs flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>
                  בתיקון המינימלי צפויה חריגת רוחב בס״מ באחד ממדפי היעד (בהתחשבות בספרים זרים ומושאלים). מומלץ לעבור לפריסה מחדש מאוזנת.
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleSetModeChange(ms, "rebalance")}
                className="px-3 py-1 rounded-md bg-red-700 text-white font-bold hover:bg-red-800 cursor-pointer whitespace-nowrap"
              >
                עבור לפריסה מחדש מאוזנת
              </button>
            </div>
          )}

          {activeMode === "rebalance" && modeRes.needsExtraShelf && (
            <div className="p-3 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-300 text-xs flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>
                  סה״כ רוחב הסט (כולל רזרבת 8% ומרווח לכרכים חסרים) עולה על קיבולת השרשרת הנוכחית — לחץ על מדף פנוי בארון הדו-ממדי כדי לצרפו לשרשרת.
                </span>
              </div>
            </div>
          )}

          {foreignAlertsAll.length > 0 && (
            <div className="p-3 bg-amber-50/70 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200 text-xs space-y-1">
              <div className="font-bold flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span>ספרים זרים מקטגוריה שונה היושבים על מדפי הסט:</span>
              </div>
              {foreignAlertsAll.map((fa) => (
                <div key={fa.barcode} className="pr-5 text-[11px] tabular-nums">
                  {fa.title} (#{fa.barcode}) · קטגוריה: {fa.category} · יושב בארון {fa.cabinetCode} מדף{" "}
                  {fa.shelfNumber} ({fa.thicknessCm} ס״מ)
                  {fa.suggestedCabinetCode ? ` · מומלץ להעביר לארון ${fa.suggestedCabinetCode}` : ""}
                </div>
              ))}
            </div>
          )}

          {/* Actionable Moves for Active Mode */}
          {modeRes.moves.length > 0 && (
            <div className="divide-y divide-[var(--otzar-border-muted)]">
              {modeRes.moves.map((mv) => {
                const checked = selectedIds.has(mv.id);
                const sev = SEVERITY_LABEL[mv.severity] || SEVERITY_LABEL.info;
                return (
                  <div key={mv.id} className="p-3.5 flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleToggleMoveSelection(mv.id)}
                      className="mt-1 rounded accent-[var(--otzar-accent)] cursor-pointer"
                    />
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className={sev.cls}>{sev.text}</span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums font-medium">{mv.barcodes.length} כרכים להעברה</span>
                        {mv.hasBorrowed && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-bold text-amber-700 dark:text-amber-400">
                              כולל {mv.borrowedCount} מושאל כרגע (לא מסומן אוטומטית)
                            </span>
                          </>
                        )}
                      </div>
                      <div className="font-bold text-xs">{mv.title}</div>
                      <div className="text-xs text-[var(--otzar-text)]">{mv.description}</div>
                      <div className="text-xs text-[var(--otzar-text-muted)]">{mv.reason}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Toggle & Per-Shelf Internal Canonical Sequence */}
          <div>
            <button
              type="button"
              onClick={() =>
                setExpandedSequences((prev) => ({ ...prev, [ms.setName]: !isSeqExpanded }))
              }
              className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-semibold hover:bg-[var(--otzar-surface-alt)]/50 cursor-pointer"
            >
              <span>
                פירוט הסדר התורני הפנימי בכל מדף ({activeMode === "rebalance" ? "לפי פריסה מחדש" : "לפי תיקון מינימלי"})
              </span>
              {isSeqExpanded ? (
                <ChevronUp className="w-4 h-4 text-[var(--otzar-text-muted)]" />
              ) : (
                <ChevronDown className="w-4 h-4 text-[var(--otzar-text-muted)]" />
              )}
            </button>

            {isSeqExpanded && (
              <div className="divide-y divide-[var(--otzar-border-muted)] border-t border-[var(--otzar-border-muted)]">
                {modeRes.shelfPlans.map((sp) => (
                  <div key={`seq-${sp.cabinetId}-${sp.shelfNumber}`} className="p-3.5 space-y-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2 tabular-nums">
                      <div className="flex flex-wrap items-center gap-2 font-bold">
                        <span>
                          ארון {sp.cabinetCode} · מדף {sp.shelfNumber}
                        </span>
                        {sp.isOverflow && (
                          <span className="text-red-700 dark:text-red-400">
                            · חריגה צפויה +{sp.overflowCm} ס״מ
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[var(--otzar-text-muted)]">
                        <span>
                          תפוסה צפויה: {sp.projectedUsedCm} / {sp.capacityCm} ס״מ ({sp.fillPercent}%)
                        </span>
                        {sp.foreignCm > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              זרים: {sp.foreignBooksCount} ספרים ({sp.foreignCm} ס״מ)
                            </span>
                          </>
                        )}
                        {sp.borrowedCount > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              מושאלים שמורים: {sp.borrowedCount} ({sp.borrowedCm} ס״מ)
                            </span>
                          </>
                        )}
                        {sp.missingReservedCm > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>מרווח לחסרים: {sp.missingReservedCm} ס״מ</span>
                          </>
                        )}
                      </div>
                    </div>

                    {sp.outgoingItems.length > 0 && (
                      <div className="text-rose-700 dark:text-rose-400 text-[11px]">
                        <span className="font-bold">לשלוף מהמדף: </span>
                        {sp.outgoingItems.map((oi, i) => (
                          <span key={i}>
                            {i > 0 ? " · " : ""}
                            {oi.label}
                            {oi.copiesCount > 1 ? ` (×${oi.copiesCount})` : ""}
                            {oi.borrowedCount > 0 ? " (מושאל כרגע)" : ""} ← ארון {oi.toCabinetCode} מדף{" "}
                            {oi.toShelf}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="text-[11px] leading-relaxed">
                      <span className="font-semibold text-[var(--otzar-text-muted)]">
                        הסדר המומלץ במדף:{" "}
                      </span>
                      {sp.expectedItems.length === 0 ? (
                        <span className="text-[var(--otzar-text-muted)]">מדף פנוי</span>
                      ) : (
                        sp.expectedItems.map((it, idx) => (
                          <span
                            key={idx}
                            className={
                              it.kind === "incoming"
                                ? "text-emerald-700 dark:text-emerald-400 font-bold"
                                : it.kind === "missing_slot"
                                ? "text-amber-700 dark:text-amber-400 italic"
                                : "text-[var(--otzar-text)]"
                            }
                          >
                            {idx > 0 ? " · " : ""}
                            {it.kind === "incoming" ? "+ " : ""}
                            {it.kind === "missing_slot" ? `[מקום לחסר: ${it.label}]` : it.label}
                            {it.copiesCount > 1 ? ` (×${it.copiesCount})` : ""}
                            {it.borrowedCount > 0 ? " (מושאל כרגע)" : ""}
                            {it.kind === "incoming" && it.fromCabinetCode
                              ? ` (מארון ${it.fromCabinetCode} מדף ${it.fromShelf})`
                              : ""}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl max-h-[92vh] flex flex-col rounded-2xl border border-[var(--otzar-border)] bg-[var(--otzar-surface)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--otzar-border-muted)]">
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-[var(--otzar-accent)]" />
              מסדר מדפים חכם (חישוב ס״מ + סדר תורני + AI)
            </h3>
            <p className="text-xs text-[var(--otzar-text-muted)] mt-0.5">
              מאתר מדפים חורגים ברוחב בס״מ, מציג ארונות במבנה דו-ממדי לסידור סטים רב-מדפיים, מאחד סטים מפוצלים ומשבץ ספרים ללא מיקום.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-[var(--otzar-surface-alt)] text-[var(--otzar-text-muted)] cursor-pointer"
            aria-label="סגור"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-3 border-b border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-2 cursor-pointer font-medium">
              <input
                type="checkbox"
                checked={useAi}
                onChange={(e) => {
                  const next = e.target.checked;
                  setUseAi(next);
                  runAnalysis(next);
                }}
                className="rounded accent-[var(--otzar-accent)]"
              />
              <span>שלב גם המלצות עומק מ-Gemini AI</span>
            </label>

            <div className="flex items-center gap-1 p-0.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]">
              <button
                type="button"
                disabled={loading}
                onClick={() => handleDirectionChange("top_down")}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                  prefs.shelfDirection === "top_down"
                    ? "bg-[var(--otzar-accent)] text-white font-bold"
                    : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                }`}
              >
                מדף 1 עליון (1 ← N)
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => handleDirectionChange("bottom_up")}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                  prefs.shelfDirection === "bottom_up"
                    ? "bg-[var(--otzar-accent)] text-white font-bold"
                    : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                }`}
              >
                מדף 1 תחתון (N ← 1)
              </button>
            </div>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={() => runAnalysis(useAi)}
            className="px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-semibold hover:bg-[var(--otzar-surface)] cursor-pointer whitespace-nowrap"
          >
            {loading ? "מנתח..." : "הרץ ניתוח מחדש"}
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-5 text-sm">
          {notice && (
            <div className="p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-xs font-medium flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{notice}</span>
            </div>
          )}
          {error && (
            <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 text-xs">{error}</div>
          )}
          {plan?.aiError && (
            <div className="p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>המלצות AI לא צורפו: {plan.aiError} (מוצג הניתוח הדטרמיניסטי המלא).</span>
            </div>
          )}

          {loading ? (
            <div className="py-12 flex items-center justify-center gap-2 text-[var(--otzar-text-muted)]">
              <Loader2 className="w-4 h-4 animate-spin" />
              מחשב רוחב מדפים, עומס ספרים, רצף תורני על פני מדפים וזיהוי חריגים...
            </div>
          ) : plan ? (
            <>
              <div className="p-3.5 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] text-sm font-medium">
                {plan.summary}
              </div>

              {disorderedSets.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-[var(--otzar-text-muted)]">
                      בדיקת סדר רצף תורני בסטים רב-מדפיים ({disorderedSets.length} דורשים סידור)
                    </h4>
                  </div>
                  <div className="space-y-4">
                    {disorderedSets.map((ms) => renderMultiShelfCard(ms))}
                  </div>
                </div>
              )}

              {plan.moves.length > 0 && (
                <div className="space-y-2">
                  {disorderedSets.length > 0 && (
                    <h4 className="text-xs font-bold text-[var(--otzar-text-muted)]">
                      המלצות רוחב, שיבוץ ואחסון נוספות ({plan.moves.length})
                    </h4>
                  )}
                  <div className="divide-y divide-[var(--otzar-border-muted)] rounded-xl border border-[var(--otzar-border-muted)] overflow-hidden">
                    {plan.moves.map((mv) => {
                      const isActionable = Boolean(mv.barcodes && mv.barcodes.length > 0 && mv.toCabinetId && mv.toShelf);
                      const checked = selectedIds.has(mv.id);
                      const sev = SEVERITY_LABEL[mv.severity] || SEVERITY_LABEL.info;
                      return (
                        <div key={mv.id} className="p-4 flex items-start gap-3 bg-[var(--otzar-bg)]">
                          {isActionable ? (
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => handleToggleMoveSelection(mv.id)}
                              className="mt-1 rounded accent-[var(--otzar-accent)] cursor-pointer"
                            />
                          ) : (
                            <span className="mt-1 w-4 h-4 shrink-0" />
                          )}
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className={sev.cls}>{sev.text}</span>
                              <span aria-hidden="true">·</span>
                              <span className="text-[var(--otzar-text-muted)]">
                                {mv.source === "ai" ? "המלצת Gemini AI" : "חישוב מידות אוטומטי"}
                              </span>
                              {mv.barcodes && mv.barcodes.length > 0 && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="tabular-nums font-medium">{mv.barcodes.length} ספרים להעברה</span>
                                </>
                              )}
                            </div>
                            <div className="font-bold">{mv.title}</div>
                            <div className="text-xs text-[var(--otzar-text)]">{mv.description}</div>
                            <div className="text-xs text-[var(--otzar-text-muted)]">{mv.reason}</div>
                            {(mv.fromCabinetCode || mv.toCabinetCode) && (
                              <div className="text-xs font-mono tabular-nums text-[var(--otzar-accent)] flex items-center gap-1.5 pt-0.5">
                                <span>{mv.fromCabinetCode ? `ארון ${mv.fromCabinetCode} מדף ${mv.fromShelf || "-"}` : "ללא ארון"}</span>
                                <ArrowLeftRight className="w-3.5 h-3.5" />
                                <span>{mv.toCabinetCode ? `ארון ${mv.toCabinetCode} מדף ${mv.toShelf || "-"}` : "לסידור ידני"}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {orderedSets.length > 0 && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setShowOrderedSets((p) => !p)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>
                      {orderedSets.length} סטים רב-מדפיים נוספים מסודרים ברצף תקין ({showOrderedSets ? "הסתר" : "הצג לפריסה מחדש או עריכת שרשרת"})
                    </span>
                  </button>
                  {showOrderedSets && (
                    <div className="space-y-4">
                      {orderedSets.map((ms) => renderMultiShelfCard(ms))}
                    </div>
                  )}
                </div>
              )}

              {plan.moves.length === 0 && disorderedSets.length === 0 && (
                <div className="py-6 text-center text-[var(--otzar-text-muted)] text-xs">
                  כל המדפים מאוזנים בטווח הס״מ והסטים מסודרים ברצף תקין על פני המדפים.
                </div>
              )}
            </>
          ) : null}
        </div>

        <div className="px-6 py-4 border-t border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-[var(--otzar-text-muted)] tabular-nums">
            {allActionableMoves.length > 0
              ? `נבחרו ${selectedActionableCount} מתוך ${allActionableMoves.length} פעולות אוטומטיות`
              : "אין מהלכים אוטומטיים זמינים כרגע"}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium border border-[var(--otzar-border-muted)] cursor-pointer"
            >
              סגור
            </button>
            <button
              type="button"
              disabled={applying || selectedActionableCount === 0}
              onClick={handleApplySelected}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
            >
              <CheckCircle2 className="w-4 h-4" />
              {applying ? "מבצע העברה..." : `בצע מהלכים נבחרים (${selectedActionableCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
