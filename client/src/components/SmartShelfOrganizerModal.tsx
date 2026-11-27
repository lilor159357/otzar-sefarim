import React, { useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  CheckCircle2,
  X,
  Loader2,
  ArrowLeftRight,
  AlertTriangle,
  RotateCcw,
  Layers,
  CircleDot,
  Undo2,
  Building2,
  Search,
  Eye,
  Trash2,
  ListChecks,
  BookOpen,
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

  // Master-detail & compact navigation state
  const [mainTab, setMainTab] = useState<"sets" | "general">("sets");
  const [selectedSetName, setSelectedSetName] = useState<string | null>(null);
  const [setSearch, setSetSearch] = useState("");
  const [setListFilter, setSetListFilter] = useState<"all" | "disordered">("all");
  const [innerSetTab, setInnerSetTab] = useState<"cabinets" | "moves" | "sequence">("cabinets");

  // Current vs Projected preview toggle on 2D cabinets
  const [cabinetViewMode, setCabinetViewMode] = useState<"current" | "projected">("current");
  // Focused shelf quick inspector inside 2D bookcase view
  const [focusedShelfKey, setFocusedShelfKey] = useState<string | null>(null);
  // Filters for Moves / Sequence / General tabs
  const [movesShelfFilter, setMovesShelfFilter] = useState<string>("all");
  const [seqChangedOnly, setSeqChangedOnly] = useState<boolean>(false);
  const [seqQuery, setSeqQuery] = useState<string>("");
  const [generalQuery, setGeneralQuery] = useState<string>("");

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
      for (const ms of nextPlan.multiShelfSets || []) {
        if (!(ms.setName in activeModes)) {
          activeModes[ms.setName] = "minimal";
        }
      }
      setSetModes(activeModes);
      setPlan(nextPlan);
      syncDefaultSelections(nextPlan, activeModes);

      // Select initial set & tab cleanly
      const sets = nextPlan.multiShelfSets || [];
      if (sets.length === 0 && nextPlan.moves.length > 0) {
        setMainTab("general");
      } else if (sets.length > 0) {
        setSelectedSetName((prev) =>
          prev && sets.some((s) => s.setName === prev) ? prev : sets[0].setName
        );
      }
    } catch (err: any) {
      setError(err?.message || "שגיאה בניתוח");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runAnalysis(false);
  }, []);

  const multiShelfSets = plan?.multiShelfSets || [];
  const disorderedSets = useMemo(
    () =>
      multiShelfSets.filter(
        (ms) => !ms.minimalMode.isOrdered || ms.shelfChain.some((s) => s.foreignAlerts.length > 0)
      ),
    [multiShelfSets]
  );

  const filteredSidebarSets = useMemo(() => {
    const q = setSearch.trim().toLowerCase();
    return multiShelfSets.filter((ms) => {
      if (setListFilter === "disordered") {
        const isDisordered =
          !ms.minimalMode.isOrdered || ms.shelfChain.some((s) => s.foreignAlerts.length > 0);
        if (!isDisordered) return false;
      }
      if (q && !ms.setName.toLowerCase().includes(q) && !ms.dominantCategory.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [multiShelfSets, setListFilter, setSearch]);

  const activeSet = useMemo(() => {
    if (multiShelfSets.length === 0) return null;
    return multiShelfSets.find((s) => s.setName === selectedSetName) || multiShelfSets[0];
  }, [multiShelfSets, selectedSetName]);

  const standardActionableMoves = useMemo(
    () =>
      (plan?.moves || []).filter(
        (m) => m.barcodes && m.barcodes.length > 0 && m.toCabinetId && m.toShelf
      ),
    [plan]
  );

  const activeMultiShelfMoves = useMemo(() => {
    const list: MultiShelfSetMove[] = [];
    for (const ms of multiShelfSets) {
      const m = setModes[ms.setName] || "minimal";
      const modeRes = m === "rebalance" ? ms.rebalanceMode : ms.minimalMode;
      for (const mv of modeRes.moves) {
        if (mv.barcodes.length > 0 && mv.toCabinetId && mv.toShelf) {
          list.push(mv);
        }
      }
    }
    return list;
  }, [multiShelfSets, setModes]);

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

  const handleSelectBatch = (ids: string[], checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
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
    setFocusedShelfKey(null);
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

    const key = `${cabinetId}:${shelfNumber}`;
    if (isInSetChain) {
      // Focus / toggle inspector for this shelf
      setFocusedShelfKey((prev) => (prev === key ? null : key));
    } else {
      // Attach free shelf to the chain
      const nextChain: CustomShelfOrderItem[] = [
        ...ms.shelfChain.map((s) => ({
          cabinetId: s.cabinetId,
          shelfNumber: s.shelfNumber,
          manual: s.isManuallyAdded,
        })),
        { cabinetId, shelfNumber, manual: true },
      ];
      await updateSetChain(ms, nextChain);
      setFocusedShelfKey(key);
    }
  };

  const handleRemoveManualShelf = async (
    ms: MultiShelfSetAnalysis,
    cabinetId: number,
    shelfNumber: number
  ) => {
    const nextChain: CustomShelfOrderItem[] = ms.shelfChain
      .filter((s) => !(s.cabinetId === cabinetId && s.shelfNumber === shelfNumber))
      .map((s) => ({
        cabinetId: s.cabinetId,
        shelfNumber: s.shelfNumber,
        manual: s.isManuallyAdded,
      }));
    setFocusedShelfKey(null);
    await updateSetChain(ms, nextChain);
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

  const filteredGeneralMoves = useMemo(() => {
    const q = generalQuery.trim().toLowerCase();
    return (plan?.moves || []).filter((mv) => {
      if (!q) return true;
      return (
        mv.title.toLowerCase().includes(q) ||
        mv.description.toLowerCase().includes(q) ||
        mv.reason.toLowerCase().includes(q) ||
        (mv.fromCabinetCode || "").toLowerCase().includes(q) ||
        (mv.toCabinetCode || "").toLowerCase().includes(q)
      );
    });
  }, [plan, generalQuery]);

  const renderActiveSetWorkspace = (ms: MultiShelfSetAnalysis) => {
    const activeMode = setModes[ms.setName] || "minimal";
    const modeRes = activeMode === "rebalance" ? ms.rebalanceMode : ms.minimalMode;
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

    const participatingCabIds = new Set(ms.shelfChain.map((s) => s.cabinetId));
    const allCabsMeta = plan?.cabinetsMeta || [];
    const displayCabinets = (
      showAllCabs
        ? allCabsMeta
        : allCabsMeta.filter((c) => participatingCabIds.has(c.id))
    ).sort((a, b) => compareNaturalCodes(a.code, b.code));

    const focusedPlan = focusedShelfKey ? shelfPlanMap.get(focusedShelfKey) || null : null;
    const focusedChainOrder = focusedShelfKey ? chainIndexMap.get(focusedShelfKey)?.order : undefined;

    const filteredSetMoves = modeRes.moves.filter((mv) => {
      if (movesShelfFilter === "all") return true;
      const fromKey = `${mv.fromCabinetId}:${mv.fromShelf}`;
      const toKey = `${mv.toCabinetId}:${mv.toShelf}`;
      return fromKey === movesShelfFilter || toKey === movesShelfFilter;
    });

    const filteredShelfPlans = modeRes.shelfPlans.filter((sp) => {
      if (seqChangedOnly) {
        const hasChange = sp.outgoingItems.length > 0 || sp.expectedItems.some((it) => it.kind === "incoming");
        if (!hasChange) return false;
      }
      const q = seqQuery.trim().toLowerCase();
      if (q) {
        const matchShelf = `ארון ${sp.cabinetCode} מדף ${sp.shelfNumber}`.toLowerCase().includes(q);
        const matchItem =
          sp.expectedItems.some((it) => it.label.toLowerCase().includes(q)) ||
          sp.outgoingItems.some((oi) => oi.label.toLowerCase().includes(q));
        if (!matchShelf && !matchItem) return false;
      }
      return true;
    });

    const setActionableMoveIds = modeRes.moves
      .filter((m) => m.barcodes.length > 0 && m.toCabinetId && m.toShelf)
      .map((m) => m.id);
    const setSelectedCount = setActionableMoveIds.filter((id) => selectedIds.has(id)).length;

    return (
      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {/* Selected Set Header + Mode Switcher */}
        <div className="shrink-0 px-4 py-3 bg-[var(--otzar-surface)] border-b border-[var(--otzar-border-muted)] flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Layers className="w-4 h-4 text-[var(--otzar-accent)] shrink-0" />
              <h4 className="font-bold text-sm">{ms.setName}</h4>
              {ms.minimalMode.isOrdered && activeMode === "minimal" ? (
                <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  · רצף תקין
                </span>
              ) : (
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 tabular-nums">
                  · {modeRes.movesCount} כרכים להעברה
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--otzar-text-muted)] tabular-nums">
              <span>{ms.assignedCount} כרכים משויכים</span>
              <span aria-hidden="true">·</span>
              <span>{ms.shelfChain.length} מדפים בשרשרת</span>
              <span aria-hidden="true">·</span>
              <span>{ms.totalAssignedCm} ס״מ סה״כ</span>
              {ms.borrowedCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{ms.borrowedCount} מושאלים (שמורים)</span>
                </>
              )}
              {ms.activeMissingCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{ms.activeMissingCount} חסרים מזוהים</span>
                </>
              )}
              {ms.unassignedCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{ms.unassignedCount} טרם שויכו לארון</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] shrink-0">
            <button
              type="button"
              onClick={() => handleSetModeChange(ms, "minimal")}
              className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap cursor-pointer transition-colors ${
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
              className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap cursor-pointer transition-colors ${
                activeMode === "rebalance"
                  ? "bg-[var(--otzar-bg)] text-[var(--otzar-text)] font-bold shadow-sm"
                  : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
              }`}
            >
              פריסה מחדש לפי ס״מ
            </button>
          </div>
        </div>

        {/* Inner Tabs for Selected Set — Prevents endless vertical scrolling */}
        <div className="shrink-0 px-4 pt-2 border-b border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)]/40 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setInnerSetTab("cabinets")}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 cursor-pointer transition-colors whitespace-nowrap ${
                innerSetTab === "cabinets"
                  ? "border-[var(--otzar-accent)] text-[var(--otzar-accent)]"
                  : "border-transparent text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
              }`}
            >
              <Building2 className="w-3.5 h-3.5" />
              קיר ארונות דו-ממדי ({ms.shelfChain.length})
            </button>
            <button
              type="button"
              onClick={() => setInnerSetTab("moves")}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 cursor-pointer transition-colors whitespace-nowrap tabular-nums ${
                innerSetTab === "moves"
                  ? "border-[var(--otzar-accent)] text-[var(--otzar-accent)]"
                  : "border-transparent text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
              }`}
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
              רשימת העברות ({modeRes.movesCount})
            </button>
            <button
              type="button"
              onClick={() => setInnerSetTab("sequence")}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 cursor-pointer transition-colors whitespace-nowrap tabular-nums ${
                innerSetTab === "sequence"
                  ? "border-[var(--otzar-accent)] text-[var(--otzar-accent)]"
                  : "border-transparent text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              סדר תורני לפי מדף ({modeRes.shelfPlans.length})
            </button>
          </div>

          {setActionableMoveIds.length > 0 && (
            <span className="text-[11px] text-[var(--otzar-text-muted)] tabular-nums pb-1">
              מסומנים בסט זה: {setSelectedCount}/{setActionableMoveIds.length}
            </span>
          )}
        </div>

        {/* Scrollable Inner Tab Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          {/* Compact Contextual Alerts */}
          {activeMode === "minimal" && modeRes.hasCapacityOverflow && (
            <div className="p-2.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 text-xs flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>
                  בתיקון המינימלי צפויה חריגת רוחב בס״מ באחד ממדפי היעד. מומלץ לבדוק פריסה מחדש מאוזנת.
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleSetModeChange(ms, "rebalance")}
                className="px-2.5 py-1 rounded-md bg-red-700 text-white font-bold hover:bg-red-800 cursor-pointer whitespace-nowrap"
              >
                עבור לפריסה מחדש
              </button>
            </div>
          )}

          {activeMode === "rebalance" && modeRes.needsExtraShelf && (
            <div className="p-2.5 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-300 text-xs flex items-center gap-2 font-medium">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                רוחב הסט עולה על קיבולת השרשרת הנוכחית — לחץ על מדף פנוי (+) בקיר הארונות כדי לצרפו לשרשרת.
              </span>
            </div>
          )}

          {foreignAlertsAll.length > 0 && (
            <div className="p-2.5 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200 text-xs space-y-1">
              <div className="font-bold flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span>ספרים זרים מקטגוריה שונה היושבים על מדפי הסט ({foreignAlertsAll.length}):</span>
              </div>
              {foreignAlertsAll.map((fa) => (
                <div key={fa.barcode} className="pr-5 text-[11px] tabular-nums">
                  {fa.title} (#{fa.barcode}) · {fa.category} · ארון {fa.cabinetCode} מדף {fa.shelfNumber} ({fa.thicknessCm} ס״מ)
                  {fa.suggestedCabinetCode ? ` · מומלץ לארון ${fa.suggestedCabinetCode}` : ""}
                </div>
              ))}
            </div>
          )}

          {/* TAB 1: 2D FLOOR-ALIGNED BOOKCASE WALL */}
          {innerSetTab === "cabinets" && (
            <div className="space-y-3">
              {/* Top Controls Bar: Current vs Projected + Record Order + Show All */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="inline-flex items-center gap-1 p-1 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)]">
                  <button
                    type="button"
                    onClick={() => setCabinetViewMode("current")}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold cursor-pointer transition-colors whitespace-nowrap ${
                      cabinetViewMode === "current"
                        ? "bg-[var(--otzar-bg)] text-[var(--otzar-text)] shadow-sm"
                        : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                    }`}
                  >
                    <Eye className="w-3.5 h-3.5" />
                    מצב נוכחי כעת
                  </button>
                  <button
                    type="button"
                    onClick={() => setCabinetViewMode("projected")}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold cursor-pointer transition-colors whitespace-nowrap ${
                      cabinetViewMode === "projected"
                        ? "bg-[var(--otzar-accent)] text-white shadow-sm"
                        : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                    }`}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    תצוגה מקדימה אחרי סידור
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
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
                    {showAllCabs ? "רק ארונות הסט" : "כל ארונות הספרייה"}
                  </button>

                  {ms.hasCustomOrder && !isRecording && (
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => updateSetChain(ms, null)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-[11px] font-medium hover:text-[var(--otzar-accent)] cursor-pointer whitespace-nowrap"
                    >
                      <RotateCcw className="w-3 h-3" />
                      איפוס לטבעי
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
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs font-medium cursor-pointer disabled:opacity-40 whitespace-nowrap"
                      >
                        <Undo2 className="w-3.5 h-3.5" />
                        בטל
                      </button>
                      <button
                        type="button"
                        onClick={cancelRecording}
                        className="px-2 py-1.5 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs font-medium cursor-pointer whitespace-nowrap"
                      >
                        ביטול
                      </button>
                      <button
                        type="button"
                        disabled={recordedChain.length === 0 || loading}
                        onClick={() => finishRecording(ms)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 cursor-pointer disabled:opacity-40 whitespace-nowrap tabular-nums"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        שמור סדר ({recordedChain.length})
                      </button>
                    </>
                  )}
                </div>
              </div>

              {isRecording && (
                <div className="px-3 py-2 rounded-lg border border-[var(--otzar-accent)]/40 bg-[var(--otzar-accent)]/10 text-xs font-semibold text-[var(--otzar-accent)] tabular-nums">
                  מצב הקלטה פעיל — לחץ על המדפים לפי הסדר הפיזי (#1 ← #2 ← #3...). נבחרו {recordedChain.length} מדפים
                  {recordedChain.length > 0 &&
                    ": " +
                      recordedChain
                        .map((rc, i) => {
                          const cab = allCabsMeta.find((c) => c.id === rc.cabinetId);
                          return `#${i + 1} ${cab?.code || "?"}:${rc.shelfNumber}`;
                        })
                        .join(" ← ")}
                </div>
              )}

              {/* 2D Bookcase Wall — floor-aligned so shorter cabinets align with bottom shelves */}
              <div className="rounded-lg border border-[var(--otzar-border-muted)] bg-gradient-to-b from-[var(--otzar-bg)] to-[var(--otzar-surface-alt)]/50 px-3 pt-4 pb-2 overflow-x-auto">
                <div className="inline-flex min-w-full items-end gap-3.5 border-b-4 border-stone-400/75 dark:border-stone-600">
                  {displayCabinets.map((cab) => {
                    const count = Math.max(1, cab.shelves_count || 5);
                    const shelfNums = Array.from({ length: count }, (_, idx) =>
                      prefs.shelfDirection === "bottom_up" ? count - idx : idx + 1
                    );

                    return (
                      <div
                        key={cab.id}
                        className="min-w-[215px] flex-1 max-w-[280px] shrink-0 flex flex-col rounded-t-md border-x-[5px] border-t-[6px] border-amber-900/30 dark:border-amber-700/45 bg-[var(--otzar-bg)] shadow-sm overflow-hidden"
                      >
                        {/* Cabinet crown / header */}
                        <div className="px-2.5 py-1.5 bg-amber-950/[0.06] dark:bg-amber-900/20 border-b-[3px] border-amber-900/25 dark:border-amber-700/40 flex items-center justify-between gap-2 text-xs">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-bold whitespace-nowrap">ארון {cab.code}</span>
                            <span className="text-[10px] text-[var(--otzar-text-muted)] tabular-nums whitespace-nowrap">
                              ({count} מדפים)
                            </span>
                          </div>
                          {cab.main_subject && (
                            <span className="text-[10px] text-[var(--otzar-text-muted)] truncate">
                              {cab.main_subject}
                            </span>
                          )}
                        </div>

                        {/* Uniform-height shelves */}
                        <div className="flex flex-col">
                          {shelfNums.map((sNum) => {
                            const key = `${cab.id}:${sNum}`;
                            const inChain = chainIndexMap.get(key);
                            const sp = shelfPlanMap.get(key);
                            const shelfReport = cab.shelves?.find((sh) => sh.shelfNumber === sNum);
                            const recNum = recordedIndexMap.get(key);
                            const isFocused = !isRecording && focusedShelfKey === key;

                            const capCm = sp?.capacityCm || shelfReport?.estimatedCapacityCm || 116;

                            // Compute projected vs current cleanly
                            const projectedBooksCount = sp
                              ? sp.expectedItems.reduce(
                                  (acc, it) => (it.kind !== "missing_slot" ? acc + it.copiesCount : acc),
                                  0
                                )
                              : 0;
                            const currentBooksCount = sp
                              ? sp.currentSetCount ??
                                sp.expectedItems.reduce((a, it) => (it.kind === "staying" ? a + it.copiesCount : a), 0) +
                                  sp.outgoingItems.reduce((a, oi) => a + oi.copiesCount, 0)
                              : shelfReport?.booksCount || 0;

                            const projectedUsedCm = sp
                              ? sp.projectedUsedCm
                              : shelfReport?.estimatedUsedCm ?? shelfReport?.totalThicknessCm ?? 0;
                            const currentUsedCm = sp
                              ? sp.currentUsedCm ?? Math.round((sp.stayingCm + sp.outgoingCm + sp.foreignCm) * 10) / 10
                              : shelfReport?.estimatedUsedCm ?? shelfReport?.totalThicknessCm ?? 0;

                            const displayCm = cabinetViewMode === "current" ? currentUsedCm : projectedUsedCm;
                            const pct = capCm > 0 ? Math.min(100, Math.round((displayCm / capCm) * 100)) : 0;
                            const isOver = capCm > 0 && displayCm > capCm + 0.5;

                            const inCount =
                              sp?.incomingCount ??
                              (sp ? sp.expectedItems.reduce((a, it) => (it.kind === "incoming" ? a + it.copiesCount : a), 0) : 0);
                            const outCount =
                              sp?.outgoingCount ??
                              (sp ? sp.outgoingItems.reduce((a, oi) => a + oi.copiesCount, 0) : 0);
                            const hasMovesOnShelf = inCount > 0 || outCount > 0;

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
                                    ? `לחץ להצגת פירוט מלא של ארון ${cab.code} מדף ${sNum}`
                                    : "מדף מחוץ לשרשרת — לחץ לצרף אותו לשרשרת הסט"
                                }
                                className={`w-full h-[64px] px-2.5 py-1.5 text-right transition-colors cursor-pointer flex flex-col justify-between border-b-[3px] border-amber-900/25 dark:border-amber-700/40 ${
                                  isFocused
                                    ? "ring-2 ring-inset ring-[var(--otzar-accent)] bg-[var(--otzar-accent)]/10"
                                    : isRecording
                                    ? recNum
                                      ? "bg-[var(--otzar-accent)]/15 hover:bg-[var(--otzar-accent)]/20"
                                      : inChain
                                      ? "bg-amber-50/50 dark:bg-amber-950/15 hover:bg-[var(--otzar-surface-alt)]"
                                      : "hover:bg-[var(--otzar-surface-alt)] opacity-75 hover:opacity-100"
                                    : inChain
                                    ? hasMovesOnShelf
                                      ? "bg-amber-50/55 dark:bg-amber-950/20 hover:bg-amber-100/50 dark:hover:bg-amber-950/30"
                                      : "bg-[var(--otzar-surface)]/65 hover:bg-[var(--otzar-surface-alt)]"
                                    : "bg-[var(--otzar-bg)] opacity-70 hover:opacity-100 hover:bg-[var(--otzar-surface-alt)]"
                                }`}
                              >
                                <div className="flex items-center justify-between gap-1.5 text-[11px] tabular-nums">
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

                                  <div className="flex items-center gap-1 text-[10px] text-[var(--otzar-text-muted)] truncate">
                                    {inChain ? (
                                      cabinetViewMode === "current" ? (
                                        <>
                                          <span>
                                            {currentBooksCount > 0 ? `${currentBooksCount} כעת` : "ריק כעת"}
                                          </span>
                                          {hasMovesOnShelf && (
                                            <span className="font-bold text-[var(--otzar-accent)]">
                                              ({inCount > 0 ? `+${inCount}` : ""}
                                              {inCount > 0 && outCount > 0 ? "/" : ""}
                                              {outCount > 0 ? `-${outCount}` : ""})
                                            </span>
                                          )}
                                        </>
                                      ) : (
                                        <span>
                                          {projectedBooksCount > 0 ? `${projectedBooksCount} אחרי` : "יתפנה"}
                                        </span>
                                      )
                                    ) : shelfReport && shelfReport.booksCount > 0 ? (
                                      <span>{shelfReport.booksCount} ספרים אחרים</span>
                                    ) : (
                                      <span>מדף פנוי</span>
                                    )}
                                  </div>
                                </div>

                                {/* Shelf fill progress bar */}
                                <div className="flex items-center gap-2 text-[10px] tabular-nums text-[var(--otzar-text-muted)]">
                                  <div className="flex-1 h-2 rounded-xs bg-[var(--otzar-surface-alt)] overflow-hidden">
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
                                  <span>{Math.round(displayCm)}/{Math.round(capCm)} ס״מ</span>
                                </div>
                              </button>
                            );
                          })}
                        </div>

                        {/* Cabinet floor plinth */}
                        <div className="h-2.5 bg-amber-950/15 dark:bg-amber-800/30" />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--otzar-text-muted)] px-1">
                  <span>
                    {cabinetViewMode === "current"
                      ? "מציג מצב נוכחי כעת על המדפים (והשינויים הצפויים בסוגריים). לחץ על מדף לפירוט מדויק."
                      : "תצוגה מקדימה: מציג איך המדפים ייראו אחרי ביצוע כל ההעברות."}
                  </span>
                  <span>קו רצפה · ארונות נמוכים מיושרים מטה</span>
                </div>
              </div>

              {/* Focused Shelf Quick Inspector (appears when user clicks a shelf in 2D wall) */}
              {focusedPlan && (
                <div className="rounded-xl border border-[var(--otzar-accent)]/45 bg-[var(--otzar-surface)] p-3.5 space-y-2.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--otzar-border-muted)] pb-2">
                    <div className="flex flex-wrap items-center gap-2 font-bold">
                      <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded bg-[var(--otzar-accent)] text-white text-[10px] tabular-nums">
                        #{focusedChainOrder ?? "-"}
                      </span>
                      <span>
                        מיקוד מדף: ארון {focusedPlan.cabinetCode} · מדף {focusedPlan.shelfNumber}
                      </span>
                      <span className="font-normal text-[var(--otzar-text-muted)] tabular-nums">
                        · כעת:{" "}
                        {focusedPlan.currentUsedCm ??
                          Math.round((focusedPlan.stayingCm + focusedPlan.outgoingCm + focusedPlan.foreignCm) * 10) /
                            10}{" "}
                        ס״מ ← אחרי: {focusedPlan.projectedUsedCm} / {focusedPlan.capacityCm} ס״מ
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {focusedPlan.isManuallyAdded && (
                        <button
                          type="button"
                          onClick={() =>
                            handleRemoveManualShelf(ms, focusedPlan.cabinetId, focusedPlan.shelfNumber)
                          }
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-red-300 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer text-[11px]"
                        >
                          <Trash2 className="w-3 h-3" />
                          הסר מדף מהשרשרת
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setMovesShelfFilter(`${focusedPlan.cabinetId}:${focusedPlan.shelfNumber}`);
                          setInnerSetTab("moves");
                        }}
                        className="px-2.5 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-medium hover:text-[var(--otzar-accent)] cursor-pointer text-[11px]"
                      >
                        סנן העברות למדף זה
                      </button>
                      <button
                        type="button"
                        onClick={() => setFocusedShelfKey(null)}
                        className="p-1 rounded hover:bg-[var(--otzar-surface-alt)] text-[var(--otzar-text-muted)] cursor-pointer"
                        title="סגור מיקוד מדף"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {focusedPlan.outgoingItems.length > 0 && (
                    <div className="text-rose-700 dark:text-rose-400 text-[11px]">
                      <span className="font-bold">לשלוף מהמדף: </span>
                      {focusedPlan.outgoingItems.map((oi, i) => (
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
                    <span className="font-semibold text-[var(--otzar-text-muted)]">הסדר המומלץ במדף: </span>
                    {focusedPlan.expectedItems.length === 0 ? (
                      <span className="text-[var(--otzar-text-muted)]">מדף פנוי</span>
                    ) : (
                      focusedPlan.expectedItems.map((it, idx) => (
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
              )}
            </div>
          )}

          {/* TAB 2: ACTIONABLE MOVES FOR SELECTED SET */}
          {innerSetTab === "moves" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={movesShelfFilter}
                    onChange={(e) => setMovesShelfFilter(e.target.value)}
                    className="px-2.5 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs tabular-nums"
                  >
                    <option value="all">כל המדפים בסט ({modeRes.moves.length} פעולות)</option>
                    {ms.shelfChain.map((s, idx) => (
                      <option key={`${s.cabinetId}:${s.shelfNumber}`} value={`${s.cabinetId}:${s.shelfNumber}`}>
                        #{idx + 1} ארון {s.cabinetCode} · מדף {s.shelfNumber}
                      </option>
                    ))}
                  </select>
                </div>

                {setActionableMoveIds.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleSelectBatch(setActionableMoveIds, true)}
                      className="px-2.5 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] hover:text-[var(--otzar-accent)] cursor-pointer text-[11px] font-medium"
                    >
                      בחר הכל בסט
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelectBatch(setActionableMoveIds, false)}
                      className="px-2.5 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] hover:text-[var(--otzar-accent)] cursor-pointer text-[11px] font-medium"
                    >
                      נקה בסט
                    </button>
                  </div>
                )}
              </div>

              {filteredSetMoves.length === 0 ? (
                <div className="py-10 text-center text-xs text-[var(--otzar-text-muted)] rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)]/30">
                  {modeRes.moves.length === 0
                    ? "אין צורך בהעברת ספרים — הסט מסודר ברצף תקין."
                    : "אין העברות התואמות למדף שסונן."}
                </div>
              ) : (
                <div className="divide-y divide-[var(--otzar-border-muted)] rounded-xl border border-[var(--otzar-border-muted)] overflow-hidden">
                  {filteredSetMoves.map((mv) => {
                    const checked = selectedIds.has(mv.id);
                    const sev = SEVERITY_LABEL[mv.severity] || SEVERITY_LABEL.info;
                    return (
                      <div key={mv.id} className="p-3.5 flex items-start gap-3 bg-[var(--otzar-bg)]">
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
            </div>
          )}

          {/* TAB 3: PER-SHELF CANONICAL SEQUENCE DETAILS */}
          {innerSetTab === "sequence" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="relative flex-1 min-w-[200px] max-w-xs">
                  <Search className="w-3.5 h-3.5 text-[var(--otzar-text-muted)] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={seqQuery}
                    onChange={(e) => setSeqQuery(e.target.value)}
                    placeholder="סנן לפי מדף או שם מסכת/כרך..."
                    className="w-full pr-8 pl-2.5 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs"
                  />
                </div>
                <label className="inline-flex items-center gap-2 cursor-pointer font-medium">
                  <input
                    type="checkbox"
                    checked={seqChangedOnly}
                    onChange={(e) => setSeqChangedOnly(e.target.checked)}
                    className="rounded accent-[var(--otzar-accent)]"
                  />
                  <span>הצג רק מדפים עם שינוי ({modeRes.shelfPlans.filter((sp) => sp.outgoingItems.length > 0 || sp.expectedItems.some((it) => it.kind === "incoming")).length})</span>
                </label>
              </div>

              {filteredShelfPlans.length === 0 ? (
                <div className="py-10 text-center text-xs text-[var(--otzar-text-muted)] rounded-xl border border-[var(--otzar-border-muted)]">
                  אין מדפים התואמים לסינון.
                </div>
              ) : (
                <div className="divide-y divide-[var(--otzar-border-muted)] rounded-xl border border-[var(--otzar-border-muted)] overflow-hidden">
                  {filteredShelfPlans.map((sp) => {
                    const orderNum = chainIndexMap.get(`${sp.cabinetId}:${sp.shelfNumber}`)?.order;
                    const curCm =
                      sp.currentUsedCm ??
                      Math.round((sp.stayingCm + sp.outgoingCm + sp.foreignCm) * 10) / 10;
                    return (
                      <div key={`seq-${sp.cabinetId}-${sp.shelfNumber}`} className="p-3.5 space-y-2 text-xs bg-[var(--otzar-bg)]">
                        <div className="flex flex-wrap items-center justify-between gap-2 tabular-nums">
                          <div className="flex flex-wrap items-center gap-2 font-bold">
                            {orderNum != null && (
                              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded bg-[var(--otzar-accent)] text-white text-[10px]">
                                #{orderNum}
                              </span>
                            )}
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
                              כעת: {curCm} ס״מ ← צפוי: {sp.projectedUsedCm} / {sp.capacityCm} ס״מ ({sp.fillPercent}%)
                            </span>
                            {sp.foreignCm > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>
                                  זרים: {sp.foreignBooksCount} ({sp.foreignCm} ס״מ)
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
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-3 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-6xl h-[92vh] flex flex-col rounded-2xl border border-[var(--otzar-border)] bg-[var(--otzar-surface)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Fixed Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-[var(--otzar-border-muted)]">
          <div>
            <h3 className="text-base sm:text-lg font-bold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-[var(--otzar-accent)]" />
              מסדר מדפים חכם (חישוב ס״מ + סדר תורני + AI)
            </h3>
            <p className="text-xs text-[var(--otzar-text-muted)] mt-0.5">
              {plan?.summary || "עבודה ממוקדת סט-אחר-סט עם תצוגת מצב נוכחי מול סידור מוצע."}
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

        {/* Fixed Top Controls & Main Domain Tabs */}
        <div className="shrink-0 px-5 py-2.5 border-b border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            {/* Main Mode Tabs */}
            <div className="flex items-center gap-1 p-0.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]">
              <button
                type="button"
                onClick={() => setMainTab("sets")}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-colors whitespace-nowrap tabular-nums ${
                  mainTab === "sets"
                    ? "bg-[var(--otzar-accent)] text-white"
                    : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                סידור סטים ברצף ({multiShelfSets.length})
              </button>
              <button
                type="button"
                onClick={() => setMainTab("general")}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-colors whitespace-nowrap tabular-nums ${
                  mainTab === "general"
                    ? "bg-[var(--otzar-accent)] text-white"
                    : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                }`}
              >
                <ListChecks className="w-3.5 h-3.5" />
                עומסים, שיבוץ ו-AI ({plan?.moves.length ?? 0})
              </button>
            </div>

            {/* Shelf Direction Switcher */}
            <div className="flex items-center gap-1 p-0.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]">
              <button
                type="button"
                disabled={loading}
                onClick={() => handleDirectionChange("top_down")}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                  prefs.shelfDirection === "top_down"
                    ? "bg-[var(--otzar-surface-alt)] text-[var(--otzar-text)] font-bold"
                    : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                }`}
              >
                מדף 1 עליון
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => handleDirectionChange("bottom_up")}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                  prefs.shelfDirection === "bottom_up"
                    ? "bg-[var(--otzar-surface-alt)] text-[var(--otzar-text)] font-bold"
                    : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                }`}
              >
                מדף 1 תחתון
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-1.5 cursor-pointer font-medium">
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
              <span>שלב המלצות Gemini AI</span>
            </label>

            <button
              type="button"
              disabled={loading}
              onClick={() => runAnalysis(useAi)}
              className="px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-semibold hover:bg-[var(--otzar-surface)] cursor-pointer whitespace-nowrap"
            >
              {loading ? "מנתח..." : "הרץ ניתוח מחדש"}
            </button>
          </div>
        </div>

        {/* Notices */}
        {(notice || error || plan?.aiError) && (
          <div className="shrink-0 px-5 pt-3 space-y-2">
            {notice && (
              <div className="p-2.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-xs font-medium flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{notice}</span>
              </div>
            )}
            {error && (
              <div className="p-2.5 rounded-lg border border-red-300 bg-red-50 text-red-800 text-xs">{error}</div>
            )}
            {plan?.aiError && (
              <div className="p-2.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>המלצות AI לא צורפו: {plan.aiError} (מוצג הניתוח הדטרמיניסטי המלא).</span>
              </div>
            )}
          </div>
        )}

        {/* Main Workspace Body — Fixed Height, Independent Scroll Zones */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {loading ? (
            <div className="flex-1 flex items-center justify-center gap-2 text-sm text-[var(--otzar-text-muted)]">
              <Loader2 className="w-4 h-4 animate-spin" />
              מחשב רוחב מדפים, עומס ספרים, רצף תורני על פני מדפים וזיהוי חריגים...
            </div>
          ) : plan ? (
            mainTab === "sets" ? (
              multiShelfSets.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-[var(--otzar-text-muted)] p-6">
                  <span>לא נמצאו סטים המתפרשים על מספר מדפים.</span>
                  {plan.moves.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setMainTab("general")}
                      className="px-3 py-1.5 rounded-lg bg-[var(--otzar-accent)] text-white font-semibold cursor-pointer"
                    >
                      עבור להמלצות רוחב ושיבוץ ({plan.moves.length})
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex-1 min-w-0 min-h-0 flex flex-col md:flex-row overflow-hidden">
                  {/* Right Sidebar: Set List (Master) */}
                  <aside className="w-full md:w-[275px] max-h-[30vh] md:max-h-none shrink-0 border-b md:border-b-0 md:border-l border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)]/30 flex flex-col min-h-0">
                    <div className="shrink-0 p-3 space-y-2 border-b border-[var(--otzar-border-muted)]">
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 text-[var(--otzar-text-muted)] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          type="text"
                          value={setSearch}
                          onChange={(e) => setSetSearch(e.target.value)}
                          placeholder="חפש סט..."
                          className="w-full pr-8 pl-2.5 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs"
                        />
                      </div>
                      <div className="flex items-center gap-1 text-[11px]">
                        <button
                          type="button"
                          onClick={() => setSetListFilter("all")}
                          className={`flex-1 py-1 rounded-md font-medium cursor-pointer tabular-nums ${
                            setListFilter === "all"
                              ? "bg-[var(--otzar-bg)] text-[var(--otzar-text)] font-bold shadow-xs border border-[var(--otzar-border-muted)]"
                              : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                          }`}
                        >
                          הכל ({multiShelfSets.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setSetListFilter("disordered")}
                          className={`flex-1 py-1 rounded-md font-medium cursor-pointer tabular-nums ${
                            setListFilter === "disordered"
                              ? "bg-[var(--otzar-bg)] text-amber-700 dark:text-amber-400 font-bold shadow-xs border border-[var(--otzar-border-muted)]"
                              : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                          }`}
                        >
                          דורשים סידור ({disorderedSets.length})
                        </button>
                      </div>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-[var(--otzar-border-muted)]">
                      {filteredSidebarSets.length === 0 ? (
                        <div className="p-4 text-center text-xs text-[var(--otzar-text-muted)]">
                          אין סטים תואמים לסינון.
                        </div>
                      ) : (
                        filteredSidebarSets.map((ms) => {
                          const isSelected = activeSet?.setName === ms.setName;
                          const mode = setModes[ms.setName] || "minimal";
                          const modeRes = mode === "rebalance" ? ms.rebalanceMode : ms.minimalMode;
                          const isOrdered = ms.minimalMode.isOrdered && ms.shelfChain.every((s) => s.foreignAlerts.length === 0);
                          const selectedHere = modeRes.moves.filter((m) => selectedIds.has(m.id)).length;
                          return (
                            <button
                              key={ms.setName}
                              type="button"
                              onClick={() => {
                                setSelectedSetName(ms.setName);
                                setFocusedShelfKey(null);
                                setMovesShelfFilter("all");
                                setSeqQuery("");
                              }}
                              className={`w-full p-3 text-right cursor-pointer transition-colors flex flex-col gap-1 ${
                                isSelected
                                  ? "bg-[var(--otzar-accent)]/10 border-r-4 border-r-[var(--otzar-accent)]"
                                  : "hover:bg-[var(--otzar-surface)]"
                              }`}
                            >
                              <div className="font-bold text-xs leading-snug line-clamp-2">{ms.setName}</div>
                              <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
                                <span className="text-[var(--otzar-text-muted)]">
                                  {ms.assignedCount} כרכים · {ms.shelfChain.length} מדפים
                                </span>
                                {isOrdered && mode === "minimal" ? (
                                  <span className="font-semibold text-emerald-700 dark:text-emerald-400">תקין ✓</span>
                                ) : (
                                  <span className="font-bold text-amber-700 dark:text-amber-400">
                                    {modeRes.movesCount} להעברה
                                  </span>
                                )}
                              </div>
                              {selectedHere > 0 && (
                                <div className="text-[10px] text-[var(--otzar-accent)] font-medium tabular-nums">
                                  {selectedHere} פעולות מסומנות לביצוע
                                </div>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </aside>

                  {/* Left Workspace: Single Selected Set Detail */}
                  {activeSet ? (
                    renderActiveSetWorkspace(activeSet)
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-xs text-[var(--otzar-text-muted)]">
                      בחר סט מהרשימה בצד ימין כדי לראות את המדפים וההמלצות.
                    </div>
                  )}
                </div>
              )
            ) : (
              /* TAB 2: GENERAL CAPACITY, UNASSIGNED PLACEMENTS & AI MOVES */
              <div className="flex-1 min-w-0 min-h-0 flex flex-col p-4 gap-3 overflow-hidden">
                <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="relative flex-1 min-w-[200px] max-w-sm">
                    <Search className="w-3.5 h-3.5 text-[var(--otzar-text-muted)] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={generalQuery}
                      onChange={(e) => setGeneralQuery(e.target.value)}
                      placeholder="חפש לפי ארון, מדף או כותרת..."
                      className="w-full pr-8 pl-2.5 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs"
                    />
                  </div>
                  {standardActionableMoves.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          handleSelectBatch(
                            standardActionableMoves.map((m) => m.id),
                            true
                          )
                        }
                        className="px-2.5 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] hover:text-[var(--otzar-accent)] cursor-pointer text-[11px] font-medium"
                      >
                        בחר הכל
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleSelectBatch(
                            standardActionableMoves.map((m) => m.id),
                            false
                          )
                        }
                        className="px-2.5 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] hover:text-[var(--otzar-accent)] cursor-pointer text-[11px] font-medium"
                      >
                        נקה הכל
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-[var(--otzar-border-muted)] divide-y divide-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]">
                  {filteredGeneralMoves.length === 0 ? (
                    <div className="py-12 text-center text-xs text-[var(--otzar-text-muted)]">
                      אין המלצות רוחב, שיבוץ או AI נוספות להצגה.
                    </div>
                  ) : (
                    filteredGeneralMoves.map((mv) => {
                      const isActionable = Boolean(mv.barcodes && mv.barcodes.length > 0 && mv.toCabinetId && mv.toShelf);
                      const checked = selectedIds.has(mv.id);
                      const sev = SEVERITY_LABEL[mv.severity] || SEVERITY_LABEL.info;
                      return (
                        <div key={mv.id} className="p-4 flex items-start gap-3">
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
                            <div className="font-bold text-sm">{mv.title}</div>
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
                    })
                  )}
                </div>
              </div>
            )
          ) : null}
        </div>

        {/* Fixed Footer */}
        <div className="shrink-0 px-5 py-3.5 border-t border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-[var(--otzar-text-muted)] tabular-nums">
            {allActionableMoves.length > 0
              ? `נבחרו ${selectedActionableCount} מתוך ${allActionableMoves.length} פעולות אוטומטיות בכל הספרייה`
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
