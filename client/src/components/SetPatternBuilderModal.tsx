import React, { useEffect, useMemo, useRef, useState } from "react";
import { X, Wand2, CheckCircle2, Loader2, AlertTriangle, Sparkles } from "lucide-react";

export type PatternTargetField = "title" | "sub_series" | "volume";

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
  initialField?: PatternTargetField;
  currentKind?: "book" | "queue";
  currentId?: string | number;
  currentVolume?: string;
  currentSubSeries?: string;
  onApplied: (updated?: {
    title?: string;
    sub_series?: string;
    volume?: string;
  }) => Promise<void> | void;
  onClose: () => void;
}

function getFieldValue(item: SetPatternTargetItem, field: PatternTargetField): string {
  if (field === "sub_series") return (item.sub_series || "").trim();
  if (field === "volume") return (item.volume || "").trim();
  return (item.title || "").trim();
}

function normalizeHebrewGeresh(str: string): string {
  return str
    .replace(/([א-ת])['`]/g, "$1׳")
    .replace(/([א-ת])"/g, "$1״")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractLastWordFromPrefix(prefix: string): string {
  const m = prefix.trim().match(/([^\s–\-:]+)$/);
  return m ? m[1] : "";
}

function extractSmartParamX(
  item: SetPatternTargetItem,
  field: PatternTargetField,
  prefix: string,
  suffix: string,
  normalizeGeresh: boolean
): string {
  const raw = getFieldValue(item, field);

  // 1. Direct exact prefix / suffix slice on the target field
  if ((prefix || suffix) && raw) {
    if (raw.startsWith(prefix) && raw.endsWith(suffix) && raw.length >= prefix.length + suffix.length) {
      const mid = raw.slice(prefix.length, raw.length - suffix.length).trim();
      if (mid) return normalizeGeresh && field === "volume" ? normalizeHebrewGeresh(mid) : mid;
    }
    const cleanPrefix = prefix.replace(/[\s–\-:]+$/, "").trim();
    if (cleanPrefix && raw.startsWith(cleanPrefix)) {
      let rest = raw.slice(cleanPrefix.length).replace(/^[\s–\-:]+/, "").trim();
      if (suffix) {
        const cleanSuffix = suffix.trim();
        if (rest.endsWith(cleanSuffix)) {
          rest = rest.slice(0, rest.length - cleanSuffix.length).trim();
        }
      }
      if (rest) return normalizeGeresh && field === "volume" ? normalizeHebrewGeresh(rest) : rest;
    }
  }

  const lastPrefixWord = extractLastWordFromPrefix(prefix);

  // 2. Smart field-specific extraction
  if (field === "sub_series") {
    let candidate = raw;
    // Strip "סדר מועד - ..." or "סדר נשים – ..." wrappers if not part of prefix
    if (candidate && (candidate.includes(" - ") || candidate.includes(" – "))) {
      const parts = candidate.split(/\s+[–-]\s+/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        candidate = parts[parts.length - 1];
      }
    }
    // If sub_series is missing or just a generic Seder name, inspect volume or title for "מסכת ..."
    if (!candidate || /^סדר\s+(זרעים|מועד|נשים|נזיקין|קדשים|קודשים|טהרות)$/.test(candidate)) {
      const volStr = (item.volume || "").trim();
      const titleStr = (item.title || "").trim();
      const mVol = volStr.match(/(מסכת\s+[^–\-]+)/);
      const mTitle = titleStr.match(/(מסכת\s+[^–\-]+)/);
      if (mVol) {
        candidate = mVol[1].trim();
      } else if (mTitle) {
        candidate = mTitle[1].trim();
      } else if (titleStr.includes("–") || titleStr.includes("-")) {
        const parts = titleStr.split(/[–-]/).map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2) candidate = parts[parts.length - 1];
      }
    }
    if (lastPrefixWord && candidate.startsWith(lastPrefixWord + " ")) {
      candidate = candidate.slice(lastPrefixWord.length + 1).trim();
    }
    return candidate || raw || item.title;
  }

  if (field === "volume") {
    let candidate = raw;
    // If volume contains "מסכת יומא - כרך ב'", take right-hand side when prefix specifies כרך/חלק or generic
    if (candidate && (candidate.includes(" - ") || candidate.includes(" – "))) {
      const parts = candidate.split(/\s+[–-]\s+/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        candidate = parts[parts.length - 1];
      }
    }
    // If template prefix ends with כרך / חלק / ספר, strip any existing כרך / חלק / ספר prefix from paramX
    if (/^(כרך|חלק|ספר)$/.test(lastPrefixWord)) {
      candidate = candidate.replace(/^(כרך|חלק|ספר)\s+/, "").trim();
    }
    // Also strip "מסכת ..." if user is converting single-tractate volume like "מסכת שקלים" into "כרך א׳" -> keep or clear smartly
    if (!candidate && item.title) {
      candidate = item.title;
    }
    return normalizeGeresh ? normalizeHebrewGeresh(candidate) : candidate;
  }

  // 3. Default for field === "title"
  const sub = (item.sub_series || "").trim();
  if (sub) {
    if (lastPrefixWord && sub.startsWith(lastPrefixWord + " ")) {
      return sub.slice(lastPrefixWord.length + 1).trim();
    }
    return sub;
  }
  if (raw.includes("–") || raw.includes("-")) {
    const parts = raw.split(/[–-]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return parts[parts.length - 1];
    }
  }
  return item.volume || raw;
}

const FIELD_LABELS: Record<PatternTargetField, string> = {
  title: "שם הספר",
  sub_series: "תת-סדרה / מסכת",
  volume: "כרך / חלק",
};

export const SetPatternBuilderModal: React.FC<SetPatternBuilderModalProps> = ({
  setName,
  sampleTitle,
  initialField = "title",
  currentKind,
  currentId,
  currentVolume = "",
  currentSubSeries = "",
  onApplied,
  onClose,
}) => {
  const sampleInputRef = useRef<HTMLInputElement>(null);
  const [targetField, setTargetField] = useState<PatternTargetField>(initialField);
  const [sampleText, setSampleText] = useState(
    initialField === "sub_series"
      ? currentSubSeries || "מסכת בבא מציעא"
      : initialField === "volume"
      ? currentVolume || "כרך א׳"
      : sampleTitle || setName
  );
  const [templateStr, setTemplateStr] = useState(
    initialField === "sub_series"
      ? "מסכת {X}"
      : initialField === "volume"
      ? "כרך {X}"
      : sampleTitle || (setName ? `${setName} – {X}` : "{X}")
  );
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number } | null>(null);
  const [alsoUpdateSubSeries, setAlsoUpdateSubSeries] = useState(false);
  const [normalizeGeresh, setNormalizeGeresh] = useState(true);

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

        const initPrefix = initialField === "sub_series" ? "מסכת " : initialField === "volume" ? "כרך " : "";
        setRows(
          merged.map((it) => ({
            ...it,
            paramX: extractSmartParamX(it, initialField, initPrefix, "", true),
            selected: true,
          }))
        );

        // Pick best initial sample if current didn't have a value for initialField
        if (merged.length > 0) {
          const curItem = merged.find(
            (it) => currentId != null && it.kind === currentKind && String(it.id) === String(currentId)
          );
          const firstNonEmpty = merged.find((it) => getFieldValue(it, initialField)) || merged[0];
          const chosenSample =
            (curItem && getFieldValue(curItem, initialField)) ||
            getFieldValue(firstNonEmpty, initialField) ||
            sampleTitle ||
            setName;
          setSampleText(chosenSample);
        }
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

  const applyTemplateToRows = (nextField: PatternTargetField, nextTpl: string, nextNormGeresh = normalizeGeresh) => {
    const xIdx = nextTpl.indexOf("{X}");
    const prefix = xIdx >= 0 ? nextTpl.slice(0, xIdx) : "";
    const suffix = xIdx >= 0 ? nextTpl.slice(xIdx + 3) : "";
    setRows((prev) =>
      prev.map((row) => ({
        ...row,
        paramX: extractSmartParamX(row, nextField, prefix, suffix, nextNormGeresh),
      }))
    );
  };

  const handleSwitchTargetField = (nextField: PatternTargetField) => {
    setTargetField(nextField);
    setSelectionRange(null);

    const curItem = rows.find(
      (it) => currentId != null && it.kind === currentKind && String(it.id) === String(currentId)
    );
    const firstNonEmpty = rows.find((it) => getFieldValue(it, nextField)) || rows[0];
    const nextSample =
      (curItem && getFieldValue(curItem, nextField)) ||
      (firstNonEmpty && getFieldValue(firstNonEmpty, nextField)) ||
      (nextField === "sub_series" ? currentSubSeries : nextField === "volume" ? currentVolume : sampleTitle) ||
      setName;
    setSampleText(nextSample);

    let nextTpl = "{X}";
    if (nextField === "title") {
      nextTpl = nextSample || (setName ? `${setName} – {X}` : "{X}");
    } else if (nextField === "sub_series") {
      nextTpl = nextSample.includes("מסכת ") || rows.some((r) => r.sub_series.includes("מסכת"))
        ? "מסכת {X}"
        : nextSample || "{X}";
    } else if (nextField === "volume") {
      nextTpl = nextSample.includes("חלק ") ? "חלק {X}" : "כרך {X}";
    }
    setTemplateStr(nextTpl);
    applyTemplateToRows(nextField, nextTpl, normalizeGeresh);
  };

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
        paramX: extractSmartParamX(row, targetField, prefix, suffix, normalizeGeresh),
      }))
    );
  };

  const handleSelectQuickPreset = (presetTpl: string) => {
    setTemplateStr(presetTpl);
    applyTemplateToRows(targetField, presetTpl, normalizeGeresh);
  };

  const computedPreview = useMemo(() => {
    const tpl = templateStr.includes("{X}") ? templateStr : `${templateStr} {X}`;
    return rows.map((r) => {
      const rawParam = targetField === "volume" && normalizeGeresh ? normalizeHebrewGeresh(r.paramX) : r.paramX.trim();
      const afterVal = tpl
        .replace(/\{X\}/g, rawParam)
        .replace(/\s{2,}/g, " ")
        .trim();
      const beforeVal = getFieldValue(r, targetField);
      return {
        ...r,
        beforeVal,
        afterVal,
      };
    });
  }, [rows, templateStr, targetField, normalizeGeresh]);

  const handleApply = async () => {
    const chosen = computedPreview.filter((r) => r.selected && r.afterVal);
    if (chosen.length === 0) return;
    setApplying(true);
    setErrorMsg(null);
    try {
      const updates = chosen.map((r) => {
        if (targetField === "title") {
          return {
            kind: r.kind,
            id: r.id,
            newTitle: r.afterVal,
            ...(alsoUpdateSubSeries ? { newSubSeries: r.paramX.trim() } : {}),
          };
        }
        if (targetField === "sub_series") {
          return {
            kind: r.kind,
            id: r.id,
            newSubSeries: r.afterVal,
          };
        }
        return {
          kind: r.kind,
          id: r.id,
          newVolume: r.afterVal,
        };
      });

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
      if (currentRow) {
        if (targetField === "title") {
          await onApplied({
            title: currentRow.afterVal,
            ...(alsoUpdateSubSeries ? { sub_series: currentRow.paramX.trim() } : {}),
          });
        } else if (targetField === "sub_series") {
          await onApplied({ sub_series: currentRow.afterVal });
        } else {
          await onApplied({ volume: currentRow.afterVal });
        }
      } else {
        await onApplied();
      }
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

  const quickPresets = useMemo(() => {
    if (targetField === "sub_series") {
      return [
        { label: "מסכת {X}", tpl: "מסכת {X}" },
        { label: "{X} (ללא קידומת)", tpl: "{X}" },
      ];
    }
    if (targetField === "volume") {
      return [
        { label: "כרך {X}", tpl: "כרך {X}" },
        { label: "חלק {X}", tpl: "חלק {X}" },
        { label: "{X} בלבד", tpl: "{X}" },
      ];
    }
    return [
      { label: `${setName} – {X}`, tpl: `${setName} – {X}` },
      { label: `${setName} – מסכת {X}`, tpl: `${setName} – מסכת {X}` },
    ];
  }, [targetField, setName]);

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
        <div className="px-5 py-3.5 border-b border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Wand2 className="w-5 h-5 text-[var(--otzar-accent)] shrink-0" />
            <div className="min-w-0">
              <h3 className="font-bold text-base truncate">בונה תבניות אחיד לסט: {setName}</h3>
              <p className="text-xs text-[var(--otzar-text-muted)]">
                בחר איזה שדה לאחד (שם ספר / תת-סדרה / כרך), סמן את החלק המשתנה {"{X}"} או בחר תבנית מהירה
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--otzar-surface)] cursor-pointer shrink-0"
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

          {/* Target Field Selector */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl border border-[var(--otzar-border)] bg-[var(--otzar-surface-alt)]">
            <span className="text-xs font-bold">שדה יעד לאיחוד בכל הסט:</span>
            <div className="inline-flex rounded-lg border border-[var(--otzar-border)] bg-[var(--otzar-bg)] p-0.5 gap-1">
              {(["title", "sub_series", "volume"] as PatternTargetField[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => handleSwitchTargetField(f)}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors cursor-pointer ${
                    targetField === f
                      ? "bg-[var(--otzar-accent)] text-white"
                      : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] hover:bg-[var(--otzar-surface)]"
                  }`}
                >
                  {FIELD_LABELS[f]}
                </button>
              ))}
            </div>
          </div>

          {/* Step 1: Mouse Selection & Quick Presets */}
          <div className="p-4 rounded-xl border border-[var(--otzar-border)] bg-[var(--otzar-surface-alt)] space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="block text-xs font-bold">
                1. סמן בעכבר את החלק המשתנה מתוך {FIELD_LABELS[targetField]} לדוגמה:
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-[var(--otzar-text-muted)]">תבניות מהירות:</span>
                {quickPresets.map((p) => (
                  <button
                    key={p.tpl}
                    type="button"
                    onClick={() => handleSelectQuickPreset(p.tpl)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold border cursor-pointer ${
                      templateStr === p.tpl
                        ? "border-[var(--otzar-accent)] bg-[var(--otzar-accent)]/10 text-[var(--otzar-accent)]"
                        : "border-[var(--otzar-border)] bg-[var(--otzar-bg)] hover:bg-[var(--otzar-surface)]"
                    }`}
                  >
                    <Sparkles className="w-3 h-3" />
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

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
                <label className="block text-xs font-semibold mb-1">
                  2. התבנית האחידה עבור {FIELD_LABELS[targetField]} (עם {"{X}"}):
                </label>
                <input
                  type="text"
                  value={templateStr}
                  onChange={(e) => setTemplateStr(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-semibold text-sm"
                />
              </div>
              {targetField === "title" && (
                <label className="flex items-center gap-2 text-xs cursor-pointer select-none pb-1.5">
                  <input
                    type="checkbox"
                    checked={alsoUpdateSubSeries}
                    onChange={(e) => setAlsoUpdateSubSeries(e.target.checked)}
                    className="rounded accent-[var(--otzar-accent)]"
                  />
                  <span>עדכן גם את שדה &quot;תת-סדרה&quot; בערך של {"{X}"}</span>
                </label>
              )}
              {targetField === "volume" && (
                <label className="flex items-center gap-2 text-xs cursor-pointer select-none pb-1.5">
                  <input
                    type="checkbox"
                    checked={normalizeGeresh}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setNormalizeGeresh(next);
                      applyTemplateToRows("volume", templateStr, next);
                    }}
                    className="rounded accent-[var(--otzar-accent)]"
                  />
                  <span>נרמל גרש עברי אחיד (למשל א&apos; ← א׳)</span>
                </label>
              )}
            </div>
          </div>

          {/* Step 3: Preview Table */}
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
                      <th className="p-2 text-right w-36">
                        {targetField === "volume" ? "תת-סדרה / ספר" : "כרך"}
                      </th>
                      <th className="p-2 text-right">לפני ({FIELD_LABELS[targetField]})</th>
                      <th className="p-2 text-right w-44">פרמטר {"{X}"}</th>
                      <th className="p-2 text-right">אחרי ({FIELD_LABELS[targetField]})</th>
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
                        <td className="p-2 font-semibold text-[var(--otzar-text)]">
                          <span className="inline-block px-2 py-0.5 rounded bg-[var(--otzar-surface)] border border-[var(--otzar-border-muted)]">
                            {targetField === "volume"
                              ? r.sub_series || r.title || "—"
                              : r.volume || "—"}
                          </span>
                          {targetField === "sub_series" && r.title ? (
                            <div className="text-[10px] text-[var(--otzar-text-muted)] truncate max-w-[140px] mt-0.5">
                              {r.title}
                            </div>
                          ) : null}
                          {r.kind === "queue" && (
                            <span className="mr-1 text-[10px] text-amber-700">(בתור AI)</span>
                          )}
                        </td>
                        <td className="p-2 text-[var(--otzar-text-muted)]">{r.beforeVal || "(ריק)"}</td>
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
                          {r.afterVal}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-semibold border border-[var(--otzar-border-muted)] cursor-pointer"
          >
            ביטול
          </button>
          <button
            type="button"
            disabled={applying || loading || computedPreview.filter((r) => r.selected && r.afterVal).length === 0}
            onClick={handleApply}
            className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
          >
            {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {applying
              ? "מחיל תבנית..."
              : `החל על כל הסט (${computedPreview.filter((r) => r.selected && r.afterVal).length} כרכים)`}
          </button>
        </div>
      </div>
    </div>
  );
};
