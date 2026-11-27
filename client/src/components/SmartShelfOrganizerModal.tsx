import React, { useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  CheckCircle2,
  X,
  Loader2,
  ArrowLeftRight,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Plus,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Layers,
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
  const [addingShelfForSet, setAddingShelfForSet] = useState<string | null>(null);
  const [newStepCabinetId, setNewStepCabinetId] = useState<string>("");
  const [newStepShelfNum, setNewStepShelfNum] = useState<number>(1);
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

  const moveChainStep = async (ms: MultiShelfSetAnalysis, idx: number, delta: -1 | 1) => {
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= ms.shelfChain.length) return;
    const chain: CustomShelfOrderItem[] = ms.shelfChain.map((s) => ({
      cabinetId: s.cabinetId,
      shelfNumber: s.shelfNumber,
      manual: s.isManuallyAdded,
    }));
    const [moved] = chain.splice(idx, 1);
    chain.splice(targetIdx, 0, moved);
    await updateSetChain(ms, chain);
  };

  const removeManualChainStep = async (ms: MultiShelfSetAnalysis, idx: number) => {
    const step = ms.shelfChain[idx];
    if (!step || !step.isManuallyAdded) return;
    const chain: CustomShelfOrderItem[] = ms.shelfChain
      .filter((_, i) => i !== idx)
      .map((s) => ({
        cabinetId: s.cabinetId,
        shelfNumber: s.shelfNumber,
        manual: s.isManuallyAdded,
      }));
    await updateSetChain(ms, chain);
  };

  const handleAddShelfToChain = async (ms: MultiShelfSetAnalysis) => {
    const cabIdNum = Number(newStepCabinetId);
    if (!cabIdNum) return;
    const exists = ms.shelfChain.some(
      (s) => s.cabinetId === cabIdNum && s.shelfNumber === newStepShelfNum
    );
    if (exists) {
      setAddingShelfForSet(null);
      return;
    }
    const chain: CustomShelfOrderItem[] = [
      ...ms.shelfChain.map((s) => ({
        cabinetId: s.cabinetId,
        shelfNumber: s.shelfNumber,
        manual: s.isManuallyAdded,
      })),
      { cabinetId: cabIdNum, shelfNumber: newStepShelfNum, manual: true },
    ];
    setAddingShelfForSet(null);
    await updateSetChain(ms, chain);
  };

  const openAddShelfPicker = (ms: MultiShelfSetAnalysis) => {
    if (addingShelfForSet === ms.setName) {
      setAddingShelfForSet(null);
      return;
    }
    const lastStep = ms.shelfChain[ms.shelfChain.length - 1];
    const cabsMeta = plan?.cabinetsMeta || [];
    const defaultCab =
      cabsMeta.find((c) => c.id === lastStep?.cabinetId) || cabsMeta[0] || null;
    if (defaultCab) {
      setNewStepCabinetId(String(defaultCab.id));
      const usedInCab = new Set(
        ms.shelfChain.filter((s) => s.cabinetId === defaultCab.id).map((s) => s.shelfNumber)
      );
      let suggestedShelf = 1;
      for (let s = 1; s <= defaultCab.shelves_count; s++) {
        if (!usedInCab.has(s)) {
          suggestedShelf = s;
          break;
        }
      }
      setNewStepShelfNum(suggestedShelf);
    }
    setAddingShelfForSet(ms.setName);
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

  const selectedCabForPicker = (plan?.cabinetsMeta || []).find(
    (c) => String(c.id) === newStepCabinetId
  );

  const renderMultiShelfCard = (ms: MultiShelfSetAnalysis) => {
    const activeMode = setModes[ms.setName] || "minimal";
    const modeRes = activeMode === "rebalance" ? ms.rebalanceMode : ms.minimalMode;
    const isSeqExpanded = Boolean(expandedSequences[ms.setName]);
    const foreignAlertsAll = ms.shelfChain.flatMap((step) =>
      step.foreignAlerts.map((fa) => ({ ...fa, cabinetCode: step.cabinetCode, shelfNumber: step.shelfNumber }))
    );

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

          {/* Editable Shelf Chain Strip */}
          <div className="p-3.5 space-y-2.5 bg-[var(--otzar-surface-alt)]/30">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-[var(--otzar-text-muted)]">
                סדר שרשרת המדפים עבור סט זה (ניתנת לסידור ידני):
              </span>
              <div className="flex items-center gap-2">
                {ms.hasCustomOrder && (
                  <button
                    type="button"
                    onClick={() => updateSetChain(ms, null)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-[11px] font-medium hover:text-[var(--otzar-accent)] cursor-pointer whitespace-nowrap"
                  >
                    <RotateCcw className="w-3 h-3" />
                    איפוס לסדר טבעי
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openAddShelfPicker(ms)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--otzar-accent)]/40 bg-[var(--otzar-accent)]/10 text-[var(--otzar-accent)] text-[11px] font-bold hover:bg-[var(--otzar-accent)]/20 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  הוסף מדף לשרשרת
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xs tabular-nums">
              {ms.shelfChain.map((step, idx) => (
                <div
                  key={`${step.cabinetId}-${step.shelfNumber}`}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                >
                  <span className="text-[11px] text-[var(--otzar-text-muted)]">{idx + 1}.</span>
                  <span className="font-semibold">
                    ארון {step.cabinetCode} מדף {step.shelfNumber}
                  </span>
                  {step.isManuallyAdded && (
                    <span className="text-[10px] text-[var(--otzar-accent)] font-medium">(נוסף)</span>
                  )}
                  <button
                    type="button"
                    disabled={idx === 0 || loading}
                    onClick={() => moveChainStep(ms, idx, -1)}
                    title="הקדם מדף בשרשרת"
                    className="p-0.5 rounded hover:bg-[var(--otzar-surface-alt)] disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === ms.shelfChain.length - 1 || loading}
                    onClick={() => moveChainStep(ms, idx, 1)}
                    title="אחר מדף בשרשרת"
                    className="p-0.5 rounded hover:bg-[var(--otzar-surface-alt)] disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowDown className="w-3 h-3" />
                  </button>
                  {step.isManuallyAdded && (
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => removeManualChainStep(ms, idx)}
                      title="הסר מדף ריק מהשרשרת"
                      className="p-0.5 rounded text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {addingShelfForSet === ms.setName && (
              <div className="pt-2 flex flex-wrap items-center gap-2 text-xs">
                <select
                  value={newStepCabinetId}
                  onChange={(e) => {
                    setNewStepCabinetId(e.target.value);
                    setNewStepShelfNum(1);
                  }}
                  className="px-2.5 py-1.5 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                >
                  {(plan?.cabinetsMeta || []).map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      ארון {c.code} {c.main_subject ? `(${c.main_subject})` : ""}
                    </option>
                  ))}
                </select>
                <select
                  value={newStepShelfNum}
                  onChange={(e) => setNewStepShelfNum(Number(e.target.value) || 1)}
                  className="px-2.5 py-1.5 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                >
                  {Array.from(
                    { length: selectedCabForPicker?.shelves_count || 5 },
                    (_, i) => i + 1
                  ).map((n) => (
                    <option key={n} value={n}>
                      מדף {n}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => handleAddShelfToChain(ms)}
                  className="px-3 py-1.5 rounded-md bg-[var(--otzar-accent)] text-white font-bold hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                >
                  צרף מדף
                </button>
                <button
                  type="button"
                  onClick={() => setAddingShelfForSet(null)}
                  className="px-2.5 py-1.5 rounded-md border border-[var(--otzar-border-muted)] cursor-pointer"
                >
                  ביטול
                </button>
              </div>
            )}
          </div>

          {/* Alerts: Capacity overflow / Needs extra shelf / Foreign category books */}
          {(activeMode === "minimal" && modeRes.hasCapacityOverflow) && (
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

          {(activeMode === "rebalance" && modeRes.needsExtraShelf) && (
            <div className="p-3 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-300 text-xs flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>
                  סה״כ רוחב הסט (כולל רזרבת 8% ומרווח לכרכים חסרים) עולה על קיבולת השרשרת הנוכחית — מומלץ להוסיף מדף פנוי דרך "+ הוסף מדף לשרשרת".
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
        className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl border border-[var(--otzar-border)] bg-[var(--otzar-surface)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--otzar-border-muted)]">
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-[var(--otzar-accent)]" />
              מסדר מדפים חכם (חישוב ס״מ + סדר תורני + AI)
            </h3>
            <p className="text-xs text-[var(--otzar-text-muted)] mt-0.5">
              מאתר מדפים חורגים ברוחב בס״מ, מנתח רצף של סטים גדולים על פני מדפים, מאחד סטים מפוצלים ומשבץ ספרים ללא מיקום.
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

              {/* Multi-shelf canonical sequence analysis */}
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

              {/* Standard moves (overloads, single-shelf split sets, unassigned, AI) */}
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

              {/* Already-ordered multi-shelf sets (collapsible for inspection / manual rebalance) */}
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
