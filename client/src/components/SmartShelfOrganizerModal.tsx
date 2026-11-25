import React, { useEffect, useState } from "react";
import { Sparkles, CheckCircle2, X, Loader2, ArrowLeftRight, AlertTriangle } from "lucide-react";
import type { SmartShelfMove, SmartShelfPlan } from "../types.ts";

interface SmartShelfOrganizerModalProps {
  onClose: () => void;
  onMovesApplied: () => Promise<void> | void;
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAnalysis = async (withAi: boolean) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/shelving/smart-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useAi: withAi }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "שגיאה בניתוח מסדר המדפים");
      const nextPlan: SmartShelfPlan = {
        moves: Array.isArray(json.moves) ? json.moves : [],
        summary: String(json.summary || ""),
        usedAi: Boolean(json.aiUsed ?? json.usedAi),
        aiError: json.aiError || null,
      };
      setPlan(nextPlan);
      const defaultSelected = new Set<string>();
      for (const mv of nextPlan.moves) {
        if (mv.barcodes && mv.barcodes.length > 0 && mv.toCabinetId && mv.toShelf) {
          defaultSelected.add(mv.id);
        }
      }
      setSelectedIds(defaultSelected);
    } catch (err: any) {
      setError(err?.message || "שגיאה בניתוח");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runAnalysis(false);
  }, []);

  const actionableMoves = (plan?.moves || []).filter(
    (m) => m.barcodes && m.barcodes.length > 0 && m.toCabinetId && m.toShelf
  );

  const handleApplySelected = async () => {
    const toApply = actionableMoves.filter((m) => selectedIds.has(m.id));
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

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-4xl rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-[var(--otzar-text)] overflow-hidden max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[var(--otzar-border-muted)] flex items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-[var(--otzar-accent)]" />
              מסדר מדפים חכם (חישוב ס״מ + AI)
            </h3>
            <p className="text-xs text-[var(--otzar-text-muted)] mt-0.5">
              מאתר מדפים חורגים ברוחב בס״מ, מאחד סטים מפוצלים ומשבץ ספרים ללא מיקום לפי נושא הארון.
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
            <span>שלב גם המלצות עומק מ-Gemini AI (דורש מפתח API פעיל)</span>
          </label>
          <button
            type="button"
            disabled={loading}
            onClick={() => runAnalysis(useAi)}
            className="px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-semibold hover:bg-[var(--otzar-surface)] cursor-pointer"
          >
            {loading ? "מנתח..." : "הרץ ניתוח מחדש"}
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-4 text-sm">
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
              מחשב רוחב מדפים, עומס ספרים ופיזור סטים...
            </div>
          ) : plan ? (
            <>
              <div className="p-3.5 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] text-sm font-medium">
                {plan.summary}
              </div>

              {plan.moves.length === 0 ? (
                <div className="py-8 text-center text-[var(--otzar-text-muted)]">
                  כל המדפים מאוזנים בטווח הס״מ והסטים מאורגנים היטב.
                </div>
              ) : (
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
                            onChange={() => {
                              setSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(mv.id)) next.delete(mv.id);
                                else next.add(mv.id);
                                return next;
                              });
                            }}
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
              )}
            </>
          ) : null}
        </div>

        <div className="px-6 py-4 border-t border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-[var(--otzar-text-muted)] tabular-nums">
            {actionableMoves.length > 0
              ? `נבחרו ${selectedIds.size} מתוך ${actionableMoves.length} פעולות אוטומטיות`
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
              disabled={applying || selectedIds.size === 0}
              onClick={handleApplySelected}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
            >
              <CheckCircle2 className="w-4 h-4" />
              {applying ? "מבצע העברה..." : `בצע מהלכים נבחרים (${selectedIds.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
