import React, { useEffect, useMemo, useRef, useState } from "react";
import { X, Wand2, CheckCircle2, Loader2, AlertTriangle } from "lucide-react";

export interface SetPatternTargetItem {
  kind: "book" | "queue";
  id: string | number;
  title: string;
  volume: string;
  sub_series: string;
}

interface PreviewRow extends SetPatternTargetItem {
  paramX: string;
  selected: boolean;
}

interface SetPatternBuilderModalProps {
  setName: string;
  sampleTitle: string;
  currentKind?: "book" | "queue";
  currentId?: string | number;
  currentVolume?: string;
  currentSubSeries?: string;
  onApplied: (updatedCurrentTitle?: string, updatedCurrentSubSeries?: string) => Promise<void> | void;
  onClose: () => void;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractParamXFromTemplate(
  item: SetPatternTargetItem,
  prefix: string,
  suffix: string
): string {
  const title = (item.title || "").trim();
  if (prefix || suffix) {
    if (title.startsWith(prefix) && title.endsWith(suffix) && title.length >= prefix.length + suffix.length) {
      const mid = title.slice(prefix.length, title.length - suffix.length).trim();
      if (mid) return mid;
    }
    // Try flexible prefix/suffix without trailing dash/spaces
    const cleanPrefix = prefix.replace(/[\s–\-]+$/, "").trim();
    if (cleanPrefix && title.startsWith(cleanPrefix)) {
      let rest = title.slice(cleanPrefix.length).replace(/^[\s–\-:]+/, "").trim();
      if (suffix) {
        const cleanSuffix = suffix.trim();
        if (rest.endsWith(cleanSuffix)) {
          rest = rest.slice(0, rest.length - cleanSuffix.length).trim();
        }
      }
      if (rest) return rest;
    }
  }
  const sub = (item.sub_series || "").trim();
  if (sub) {
    // Avoid duplicating a word that is already right at the end of prefix (e.g. "מסכת ")
    const lastWordMatch = prefix.trim().match(/([^\s–\-]+)$/);
    const lastWord = lastWordMatch ? lastWordMatch[1] : "";
    if (lastWord && sub.startsWith(lastWord + " ")) {
      return sub.slice(lastWord.length + 1).trim();
    }
    return sub;
  }
  if (title.includes("–") || title.includes("-")) {
    const parts = title.split(/[–-]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return parts[parts.length - 1];
    }
  }
  return item.volume || title;
}

export const SetPatternBuilderModal: React.FC<SetPatternBuilderModalProps> = ({
  setName,
  sampleTitle,
  currentKind,
  currentId,
  currentVolume = "",
  currentSubSeries = "",
  onApplied,
  onClose,
}) => {
  const sampleInputRef = useRef<HTMLInputElement>(null);
  const [sampleText, setSampleText] = useState(sampleTitle || setName);
  const [templateStr, setTemplateStr] = useState(
    sampleTitle ? sampleTitle : setName ? `${setName} – {X}` : "{X}"
  );
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number } | null>(null);
  const [alsoUpdateSubSeries, setAlsoUpdateSubSeries] = useState(false);

  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [rows, setRows] = useState<PreviewRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/books/set-sync-count?setName=" + encodeURIComponent(setName.trim()))
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => {
        if (cancelled) return;
        const fetched: SetPatternTargetItem[] = Array.isArray(d?.items) ? d.items : [];
        const hasCurrent =
          currentId != null &&
          fetched.some((it) => it.kind === currentKind && String(it.id) === String(currentId));
        const merged =
          !hasCurrent && currentId != null
            ? [
                {
                  kind: currentKind || "book",
                  id: currentId,
                  title: sampleTitle || setName,
                  volume: currentVolume,
                  sub_series: currentSubSeries,
                },
                ...fetched,
              ]
            : fetched;
        setRows(
          merged.map((it) => ({
            ...it,
            paramX: it.sub_series || it.volume || it.title,
            selected: true,
          }))
        );
      })
      .catch(() => {
        if (!cancelled) setErrorMsg("שגיאה בטעינת כרכי הסט");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setName]);

  const syncSelectionFromInput = () => {
    const el = sampleInputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (end > start) {
      setSelectionRange({ start, end });
    } else {
      setSelectionRange(null);
    }
  };

  const handleConvertSelectionToParam = () => {
    if (!selectionRange || selectionRange.end <= selectionRange.start) return;
    const prefix = sampleText.slice(0, selectionRange.start);
    const suffix = sampleText.slice(selectionRange.end);
    const nextTpl = `${prefix}{X}${suffix}`;
    setTemplateStr(nextTpl);
    setRows((prev) =>
      prev.map((row) => ({
        ...row,
        paramX: extractParamXFromTemplate(row, prefix, suffix),
      }))
    );
  };

  const computedPreview = useMemo(() => {
    const tpl = templateStr.includes("{X}") ? templateStr : `${templateStr} {X}`;
    return rows.map((r) => ({
      ...r,
      afterTitle: tpl.replace(/\{X\}/g, r.paramX.trim()).replace(/\s{2,}/g, " ").trim(),
    }));
  }, [rows, templateStr]);

  const handleApply = async () => {
    const chosen = computedPreview.filter((r) => r.selected && r.afterTitle);
    if (chosen.length === 0) return;
    setApplying(true);
    setErrorMsg(null);
    try {
      const updates = chosen.map((r) => ({
        kind: r.kind,
        id: r.id,
        newTitle: r.afterTitle,
        ...(alsoUpdateSubSeries ? { newSubSeries: r.paramX.trim() } : {}),
      }));
      const res = await fetch("/api/books/apply-set-pattern", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "שגיאה בהחלת תבנית השם");

      const currentRow = chosen.find(
        (r) => currentId != null && r.kind === currentKind && String(r.id) === String(currentId)
      );
      await onApplied(
        currentRow?.afterTitle,
        alsoUpdateSubSeries ? currentRow?.paramX.trim() : undefined
      );
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || "שגיאה בהחלת התבנית");
    } finally {
      setApplying(false);
    }
  };

  const selectedTextPreview =
    selectionRange && selectionRange.end > selectionRange.start
      ? sampleText.slice(selectionRange.start, selectionRange.end)
      : "";

  // Unused helper reference guard
  void escapeRegExp;

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-xs flex items-center justify-center p-4"
      dir="rtl"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl border border-[var(--otzar-border)] bg-[var(--otzar-bg)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-[var(--otzar-accent)]" />
            <div>
              <h3 className="font-bold text-base">בונה תבניות שם לסט: {setName}</h3>
              <p className="text-xs text-[var(--otzar-text-muted)]">
                סמן בעכבר את המילה המשתנה (למשל שם המסכת/החלק) והפוך אותה לפרמטר קבוע {"{X}"} לכל כרכי הסט
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--otzar-surface)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 text-sm flex-1">
          {errorMsg && (
            <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Step 1: Mouse Selection */}
          <div className="p-4 rounded-xl border border-[var(--otzar-border)] bg-[var(--otzar-surface-alt)] space-y-2.5">
            <label className="block text-xs font-bold">
              1. סמן בעכבר את החלק המשתנה מתוך שם הספר לדוגמה:
            </label>
            <div className="flex flex-wrap items-center gap-2.5">
              <input
                ref={sampleInputRef}
                type="text"
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                onSelect={syncSelectionFromInput}
                onMouseUp={syncSelectionFromInput}
                onKeyUp={syncSelectionFromInput}
                className="flex-1 min-w-[260px] px-3 py-2 rounded-lg border border-[var(--otzar-border)] bg-[var(--otzar-bg)] font-bold text-base selection:bg-amber-300 selection:text-black"
              />
              <button
                type="button"
                disabled={!selectedTextPreview}
                onClick={handleConvertSelectionToParam}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
              >
                <Wand2 className="w-3.5 h-3.5" />
                {selectedTextPreview
                  ? `הפוך מסומן ("${selectedTextPreview}") לפרמטר {X}`
                  : "סמן טקסט בעכבר והפוך לפרמטר {X}"}
              </button>
            </div>

            <div className="pt-2 grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
              <div>
                <label className="block text-xs font-semibold mb-1">2. תבנית השם האחידה (עם {"{X}"}):</label>
                <input
                  type="text"
                  value={templateStr}
                  onChange={(e) => setTemplateStr(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-semibold text-sm"
                />
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer select-none pb-1.5">
                <input
                  type="checkbox"
                  checked={alsoUpdateSubSeries}
                  onChange={(e) => setAlsoUpdateSubSeries(e.target.checked)}
                  className="rounded accent-[var(--otzar-accent)]"
                />
                <span>עדכן גם את שדה &quot;תת-סדרה&quot; בערך של {"{X}"}</span>
              </label>
            </div>
          </div>

          {/* Step 2: Preview Table with Volume Column */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold">
                3. תצוגה מקדימה לפני החלה ({computedPreview.filter((r) => r.selected).length} מתוך {computedPreview.length} נבחרו)
              </span>
              <button
                type="button"
                onClick={() => {
                  const allSelected = rows.every((r) => r.selected);
                  setRows((p) => p.map((r) => ({ ...r, selected: !allSelected })));
                }}
                className="text-xs text-[var(--otzar-accent)] font-semibold hover:underline cursor-pointer"
              >
                בחר / בטל הכל
              </button>
            </div>

            {loading ? (
              <div className="p-8 text-center text-xs text-[var(--otzar-text-muted)] flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                טוען את כל כרכי הסט...
              </div>
            ) : computedPreview.length === 0 ? (
              <div className="p-6 text-center text-xs text-[var(--otzar-text-muted)] border border-[var(--otzar-border-muted)] rounded-xl">
                לא נמצאו כרכים קיימים המשויכים לסט זה.
              </div>
            ) : (
              <div className="border border-[var(--otzar-border-muted)] rounded-xl overflow-hidden max-h-[340px] overflow-y-auto">
                <table className="w-full text-xs border-collapse">
                  <thead className="bg-[var(--otzar-surface-alt)] sticky top-0 z-10 border-b border-[var(--otzar-border-muted)]">
                    <tr>
                      <th className="p-2 text-right w-8"></th>
                      <th className="p-2 text-right w-28">כרך</th>
                      <th className="p-2 text-right">לפני</th>
                      <th className="p-2 text-right w-44">פרמטר {"{X}"}</th>
                      <th className="p-2 text-right">אחרי</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--otzar-border-muted)]">
                    {computedPreview.map((r, idx) => (
                      <tr key={`${r.kind}-${r.id}-${idx}`} className={!r.selected ? "opacity-45" : ""}>
                        <td className="p-2 text-center">
                          <input
                            type="checkbox"
                            checked={r.selected}
                            onChange={(e) =>
                              setRows((prev) =>
                                prev.map((x, i) => (i === idx ? { ...x, selected: e.target.checked } : x))
                              )
                            }
                            className="rounded accent-[var(--otzar-accent)]"
                          />
                        </td>
                        <td className="p-2 font-semibold text-[var(--otzar-text)] whitespace-nowrap">
                          <span className="inline-block px-2 py-0.5 rounded bg-[var(--otzar-surface)] border border-[var(--otzar-border-muted)]">
                            {r.volume || "—"}
                          </span>
                          {r.kind === "queue" && (
                            <span className="mr-1 text-[10px] text-amber-700">(בתור AI)</span>
                          )}
                        </td>
                        <td className="p-2 text-[var(--otzar-text-muted)]">{r.title || "(ריק)"}</td>
                        <td className="p-2">
                          <input
                            type="text"
                            value={r.paramX}
                            onChange={(e) => {
                              const val = e.target.value;
                              setRows((prev) =>
                                prev.map((x, i) => (i === idx ? { ...x, paramX: val } : x))
                              );
                            }}
                            className="w-full px-2 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-medium"
                          />
                        </td>
                        <td className="p-2 font-bold text-emerald-700 dark:text-emerald-400">
                          {r.afterTitle}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-semibold border border-[var(--otzar-border-muted)] cursor-pointer"
          >
            ביטול
          </button>
          <button
            type="button"
            disabled={applying || loading || computedPreview.filter((r) => r.selected && r.afterTitle).length === 0}
            onClick={handleApply}
            className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
          >
            {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {applying
              ? "מחיל תבנית..."
              : `החל על כל הסט (${computedPreview.filter((r) => r.selected && r.afterTitle).length} כרכים)`}
          </button>
        </div>
      </div>
    </div>
  );
};
