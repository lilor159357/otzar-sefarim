import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  Download,
  FileText,
  Plus,
  Printer,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { BookRow } from "../types.ts";
import { useStrings } from "../lib/stringsContext.tsx";

interface LabelsModuleProps {
  books: BookRow[];
  settings: Record<string, any>;
  onReload: () => Promise<void>;
}

interface LabelQueueRow {
  barcode: string;
  title: string;
  author: string;
  volume: string;
  category: string;
  cabinet_code: string | null;
  shelf_number: number | null;
}

export const LabelsModule: React.FC<LabelsModuleProps> = ({ books, settings, onReload }) => {
  const { t } = useStrings();
  const [queue, setQueue] = useState<LabelQueueRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [startPosition, setStartPosition] = useState<number>(1);
  const [drawGuides, setDrawGuides] = useState<boolean>(false);

  // Label design toggles
  const [showLibraryName, setShowLibraryName] = useState<boolean>(Boolean(settings.label_config?.showLibraryName));
  const [showBookTitle, setShowBookTitle] = useState<boolean>(settings.label_config?.showBookTitle !== false);
  const [showLocation, setShowLocation] = useState<boolean>(settings.label_config?.showLocation !== false);

  // A4 template mm dimensions
  const [rows, setRows] = useState<number>(Number(settings.a4_template?.rows) || 8);
  const [cols, setCols] = useState<number>(Number(settings.a4_template?.cols) || 3);
  const [marginTopMm, setMarginTopMm] = useState<number>(Number(settings.a4_template?.marginTopMm ?? 12));
  const [marginBottomMm, setMarginBottomMm] = useState<number>(Number(settings.a4_template?.marginBottomMm ?? 12));
  const [marginRightMm, setMarginRightMm] = useState<number>(Number(settings.a4_template?.marginRightMm ?? 8));
  const [marginLeftMm, setMarginLeftMm] = useState<number>(Number(settings.a4_template?.marginLeftMm ?? 8));
  const [gapXMm, setGapXMm] = useState<number>(Number(settings.a4_template?.gapXMm ?? 4));
  const [gapYMm, setGapYMm] = useState<number>(Number(settings.a4_template?.gapYMm ?? 2));

  // Add existing book to queue picker
  const [showPicker, setShowPicker] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  // PDF generation & preview
  const [generating, setGenerating] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBarcodes, setPdfBarcodes] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadQueue = async () => {
    const res = await fetch("/api/labels/queue");
    if (res.ok) {
      const data: LabelQueueRow[] = await res.json();
      setQueue(data);
      setSelected(new Set(data.map((d) => d.barcode)));
    }
  };

  useEffect(() => {
    loadQueue();
  }, []);

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  const totalSlotsPerPage = Math.max(1, rows * cols);
  const clampedStart = Math.max(1, Math.min(totalSlotsPerPage, startPosition));
  const selectedBarcodes = queue.filter((q) => selected.has(q.barcode)).map((q) => q.barcode);

  const toggleAll = () => {
    if (selected.size === queue.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(queue.map((q) => q.barcode)));
    }
  };

  const toggleOne = (bc: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(bc)) next.delete(bc);
      else next.add(bc);
      return next;
    });
  };

  const handleSaveTemplate = async () => {
    setNotice(null);
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label_config: { showLibraryName, showBookTitle, showLocation },
        a4_template: { rows, cols, marginTopMm, marginRightMm, marginBottomMm, marginLeftMm, gapXMm, gapYMm },
      }),
    });
    setNotice("תבנית ה-A4 ועיצוב המדבקה נשמרו בהצלחה.");
    await onReload();
  };

  const handleMarkPrinted = async (barcodesToMark: string[]) => {
    if (barcodesToMark.length === 0) return;
    await fetch("/api/labels/queue/mark-printed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ barcodes: barcodesToMark }),
    });
    await Promise.all([loadQueue(), onReload()]);
  };

  const handleAddToQueue = async (barcodes: string[]) => {
    await fetch("/api/labels/queue/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ barcodes }),
    });
    setShowPicker(false);
    await Promise.all([loadQueue(), onReload()]);
  };

  const handleGeneratePdf = async () => {
    if (selectedBarcodes.length === 0) {
      setError("בחר לפחות ספר אחד מהתור להפקה.");
      return;
    }
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/labels/generate-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          barcodes: selectedBarcodes,
          startPosition: clampedStart,
          drawGuides,
          markAsPrinted: false,
          templateOverride: { rows, cols, marginTopMm, marginRightMm, marginBottomMm, marginLeftMm, gapXMm, gapYMm },
          configOverride: { showLibraryName, showBookTitle, showLocation },
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "שגיאה בהפקת PDF");
      }
      const blob = await res.blob();
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      const url = URL.createObjectURL(blob);
      setPdfUrl(url);
      setPdfBarcodes(selectedBarcodes);
    } catch (err: any) {
      setError(err?.message || t("errors.pdfGenerateFailed"));
    } finally {
      setGenerating(false);
    }
  };

  const pickerMatches = books
    .filter((b) => {
      const q = pickerQuery.trim().toLowerCase();
      if (!q) return true;
      return b.barcode.toLowerCase().includes(q) || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q);
    })
    .slice(0, 30);

  return (
    <div className="space-y-5 max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("labels.pageTitle")}</h1>
          <p className="text-sm text-[var(--otzar-text-muted)]">
            {t("labels.pageSubtitle")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowPicker((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("labels.addExistingButton")}
          </button>

          <button
            type="button"
            disabled={selectedBarcodes.length === 0 || generating}
            onClick={handleGeneratePdf}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
          >
            <Printer className="w-4 h-4" />
            {generating ? t("labels.generatingPdf") : t("labels.generatePdfCount", { count: selectedBarcodes.length })}
          </button>
        </div>
      </div>

      {notice && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-sm">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}
      {error && <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 text-sm">{error}</div>}

      {/* Re-queue Existing Books Drawer */}
      {showPicker && (
        <div className="p-4 rounded-xl border border-[var(--otzar-border)] bg-[var(--otzar-surface)] space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-sm">בחר ספר מהמאגר להדפסה חוזרת</h3>
            <button type="button" onClick={() => setShowPicker(false)} className="p-1 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 text-[var(--otzar-text-muted)] absolute right-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="חפש לפי שם ספר או ברקוד..."
              className="w-full pr-9 pl-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-sm"
            />
          </div>
          <div className="max-h-48 overflow-y-auto divide-y divide-[var(--otzar-border-muted)] rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]">
            {pickerMatches.map((b) => (
              <div key={b.barcode} className="px-3 py-2 flex items-center justify-between text-sm">
                <div>
                  <span className="font-mono tabular-nums text-xs text-[var(--otzar-accent)] ml-2">{b.barcode}</span>
                  <span className="font-medium">{b.title}</span>
                  {b.volume && <span className="text-xs text-[var(--otzar-text-muted)] mr-1">({b.volume})</span>}
                </div>
                <button
                  type="button"
                  onClick={() => handleAddToQueue([b.barcode])}
                  className="px-2.5 py-1 rounded text-xs font-semibold bg-[var(--otzar-surface)] text-[var(--otzar-accent)] cursor-pointer"
                >
                  + הוסף לתור
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Queue Table */}
        <div className="lg:col-span-7 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex items-center justify-between">
            <div className="flex items-center gap-3 text-sm font-semibold">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={queue.length > 0 && selected.size === queue.length}
                  onChange={toggleAll}
                  className="accent-[var(--otzar-accent)]"
                />
                <span>ממתינים להדפסה ({queue.length})</span>
              </label>
            </div>
            {selectedBarcodes.length > 0 && (
              <button
                type="button"
                onClick={() => handleMarkPrinted(selectedBarcodes)}
                className="inline-flex items-center gap-1 text-xs text-[var(--otzar-text-muted)] hover:text-red-600 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                נקה מסומנים מהתור
              </button>
            )}
          </div>

          {queue.length === 0 ? (
            <div className="p-8 text-center text-sm text-[var(--otzar-text-muted)]">
              אין כרגע ספרים שממתינים להדפסת מדבקה. הוסף ספרים בקטלוג או בחר ספר להדפסה חוזרת.
            </div>
          ) : (
            <div className="max-h-[460px] overflow-y-auto divide-y divide-[var(--otzar-border-muted)]">
              {queue.map((q) => (
                <label
                  key={q.barcode}
                  className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-[var(--otzar-surface-alt)] cursor-pointer text-sm"
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={selected.has(q.barcode)}
                      onChange={() => toggleOne(q.barcode)}
                      className="accent-[var(--otzar-accent)]"
                    />
                    <div>
                      <div className="font-semibold">
                        {q.title}
                        {q.volume && <span className="text-xs text-[var(--otzar-text-muted)] font-normal mr-1">({q.volume})</span>}
                      </div>
                      <div className="text-xs text-[var(--otzar-text-muted)] tabular-nums">
                        {q.cabinet_code ? `ארון ${q.cabinet_code} · מדף ${q.shelf_number ?? "-"}` : "ללא מיקום"}
                      </div>
                    </div>
                  </div>
                  <span className="font-mono text-xs font-bold tabular-nums text-[var(--otzar-accent)]">{q.barcode}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Right Side: Start Position Visual Grid + Design + A4 Dimensions */}
        <div className="lg:col-span-5 space-y-4">
          {/* Start Position + Mini A4 Grid Preview */}
          <div className="p-4 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] space-y-3">
            <div className="flex items-center justify-between">
              <label className="font-bold text-sm">התחל ממדבקה מספר X בדף</label>
              <input
                type="number"
                min={1}
                max={totalSlotsPerPage}
                value={clampedStart}
                onChange={(e) => setStartPosition(Math.max(1, Number(e.target.value) || 1))}
                className="w-20 px-2.5 py-1 rounded-lg border-2 border-[var(--otzar-border)] bg-[var(--otzar-surface)] text-center font-bold tabular-nums text-sm"
              />
            </div>

            <div className="text-xs text-[var(--otzar-text-muted)]">
              לחץ על מדבקה בתרשים כדי להתחיל ממנה (אפור = ריק מדף קודם, כתום = יודפס כעת):
            </div>

            <div
              className="grid gap-1 p-2.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)]"
              style={{ gridTemplateColumns: `repeat(${Math.min(8, cols)}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: Math.min(48, totalSlotsPerPage) }, (_, idx) => {
                const slotNum = idx + 1;
                const isSkipped = slotNum < clampedStart;
                const willPrint = slotNum >= clampedStart && slotNum < clampedStart + selectedBarcodes.length;
                return (
                  <button
                    key={slotNum}
                    type="button"
                    onClick={() => setStartPosition(slotNum)}
                    className={`h-6 rounded text-[10px] font-mono tabular-nums border cursor-pointer transition-colors ${
                      isSkipped
                        ? "bg-slate-200 dark:bg-slate-700 border-transparent text-slate-400"
                        : willPrint
                        ? "bg-[var(--otzar-accent)] border-[var(--otzar-accent-hover)] text-white font-bold"
                        : "bg-[var(--otzar-bg)] border-[var(--otzar-border-muted)] text-[var(--otzar-text-muted)]"
                    }`}
                  >
                    {slotNum}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Label Content & A4 Millimeter Grid */}
          <div className="p-4 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] space-y-3 text-sm">
            <h3 className="font-bold text-sm border-b border-[var(--otzar-border-muted)] pb-2">עיצוב מדבקה ומידות דף A4 (מ״מ)</h3>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={showBookTitle} onChange={(e) => setShowBookTitle(e.target.checked)} className="accent-[var(--otzar-accent)]" />
                הצג שם ספר
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={showLocation} onChange={(e) => setShowLocation(e.target.checked)} className="accent-[var(--otzar-accent)]" />
                הצג ארון ומדף
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={showLibraryName} onChange={(e) => setShowLibraryName(e.target.checked)} className="accent-[var(--otzar-accent)]" />
                הצג שם ישיבה
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={drawGuides} onChange={(e) => setDrawGuides(e.target.checked)} className="accent-[var(--otzar-accent)]" />
                קווי גזירה עדינים
              </label>
            </div>

            <div className="grid grid-cols-4 gap-2 text-xs pt-1">
              <div>
                <label className="block text-[var(--otzar-text-muted)] mb-1">שורות</label>
                <input type="number" min={1} max={20} value={rows} onChange={(e) => setRows(Math.max(1, Number(e.target.value) || 8))} className="w-full px-2 py-1 rounded border border-[var(--otzar-border-muted)] tabular-nums" />
              </div>
              <div>
                <label className="block text-[var(--otzar-text-muted)] mb-1">עמודות</label>
                <input type="number" min={1} max={8} value={cols} onChange={(e) => setCols(Math.max(1, Number(e.target.value) || 3))} className="w-full px-2 py-1 rounded border border-[var(--otzar-border-muted)] tabular-nums" />
              </div>
              <div>
                <label className="block text-[var(--otzar-text-muted)] mb-1">רווח X</label>
                <input type="number" min={0} max={30} value={gapXMm} onChange={(e) => setGapXMm(Number(e.target.value) || 0)} className="w-full px-2 py-1 rounded border border-[var(--otzar-border-muted)] tabular-nums" />
              </div>
              <div>
                <label className="block text-[var(--otzar-text-muted)] mb-1">רווח Y</label>
                <input type="number" min={0} max={30} value={gapYMm} onChange={(e) => setGapYMm(Number(e.target.value) || 0)} className="w-full px-2 py-1 rounded border border-[var(--otzar-border-muted)] tabular-nums" />
              </div>
              <div>
                <label className="block text-[var(--otzar-text-muted)] mb-1">שול עליון</label>
                <input type="number" min={0} max={50} value={marginTopMm} onChange={(e) => setMarginTopMm(Number(e.target.value) || 0)} className="w-full px-2 py-1 rounded border border-[var(--otzar-border-muted)] tabular-nums" />
              </div>
              <div>
                <label className="block text-[var(--otzar-text-muted)] mb-1">שול תחתון</label>
                <input type="number" min={0} max={50} value={marginBottomMm} onChange={(e) => setMarginBottomMm(Number(e.target.value) || 0)} className="w-full px-2 py-1 rounded border border-[var(--otzar-border-muted)] tabular-nums" />
              </div>
              <div>
                <label className="block text-[var(--otzar-text-muted)] mb-1">שול ימין</label>
                <input type="number" min={0} max={50} value={marginRightMm} onChange={(e) => setMarginRightMm(Number(e.target.value) || 0)} className="w-full px-2 py-1 rounded border border-[var(--otzar-border-muted)] tabular-nums" />
              </div>
              <div>
                <label className="block text-[var(--otzar-text-muted)] mb-1">שול שמאל</label>
                <input type="number" min={0} max={50} value={marginLeftMm} onChange={(e) => setMarginLeftMm(Number(e.target.value) || 0)} className="w-full px-2 py-1 rounded border border-[var(--otzar-border-muted)] tabular-nums" />
              </div>
            </div>

            <button
              type="button"
              onClick={handleSaveTemplate}
              className="w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              שמור תבנית A4 כברירת מחדל
            </button>
          </div>
        </div>
      </div>

      {/* Embedded PDF Preview & Print Modal */}
      {pdfUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setPdfUrl(null)}
        >
          <div
            className="w-full max-w-5xl h-[90vh] rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-[var(--otzar-border-muted)] flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 font-bold text-sm">
                <FileText className="w-4 h-4 text-[var(--otzar-accent)]" />
                <span>תצוגה מקדימה להדפסה ({pdfBarcodes.length} מדבקות)</span>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={pdfUrl}
                  download="otzar-labels.pdf"
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)]"
                >
                  <Download className="w-3.5 h-3.5" />
                  הורד PDF
                </a>
                <button
                  type="button"
                  onClick={async () => {
                    await handleMarkPrinted(pdfBarcodes);
                    setPdfUrl(null);
                    setNotice("המדבקות סומנו כהודפסו והוסרו מהתור.");
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  סמן כהודפסו וסגור
                </button>
                <button type="button" onClick={() => setPdfUrl(null)} className="p-1.5 rounded hover:bg-[var(--otzar-surface-alt)] cursor-pointer">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <iframe src={pdfUrl} title="תצוגת PDF מדבקות" className="w-full flex-1 border-0 bg-slate-100" />
          </div>
        </div>
      )}
    </div>
  );
};
