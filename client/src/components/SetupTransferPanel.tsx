import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  Loader2,
  PackageCheck,
  RotateCcw,
  ShieldAlert,
  Upload,
  X,
} from "lucide-react";

interface SetupTransferPanelProps {
  onReload: () => void;
  section?: "transfer" | "reset" | "all";
}

interface BundleSummary {
  hasFirebase: boolean;
  projectId: string | null;
  email: string | null;
  aiKeysCount: number;
  libraryName: string;
  hasReleaseToken: boolean;
  hasAdminPin: boolean;
}

interface ImportSuccessResult {
  message: string;
  clearedDemoData: boolean;
  projectId: string | null;
  importedCounts: {
    cabinets: number;
    books: number;
    borrowers: number;
    loans: number;
    aiKeysCount: number;
  };
  nextBarcode: number;
  deleteFileReminder: boolean;
}

export const SetupTransferPanel: React.FC<SetupTransferPanelProps> = ({ onReload, section = "all" }) => {
  const [mode, setMode] = useState<"export" | "import">("export");
  const [summary, setSummary] = useState<BundleSummary | null>(null);

  // Export state
  const [exportPasscode, setExportPasscode] = useState("");
  const [showExportPass, setShowExportPass] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportedCode, setExportedCode] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Import state
  const [bundleInput, setBundleInput] = useState("");
  const [importedFileName, setImportedFileName] = useState<string | null>(null);
  const [importPasscode, setImportPasscode] = useState("");
  const [showImportPass, setShowImportPass] = useState(false);
  const [clearDemoData, setClearDemoData] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<ImportSuccessResult | null>(null);

  // Clean start modal state (double confirmation)
  const [cleanModalOpen, setCleanModalOpen] = useState(false);
  const [cleanAck, setCleanAck] = useState(false);
  const [cleanConfirmText, setCleanConfirmText] = useState("");
  const [cleaning, setCleaning] = useState(false);
  const [cleanError, setCleanError] = useState<string | null>(null);
  const [cleanSuccessMsg, setCleanSuccessMsg] = useState<string | null>(null);

  const loadSummary = async () => {
    try {
      const res = await fetch("/api/sync/setup-bundle/summary");
      if (res.ok) {
        setSummary(await res.json());
      }
    } catch {}
  };

  useEffect(() => {
    loadSummary();
  }, []);

  const handleExport = async (action: "download" | "copy") => {
    setExportMsg(null);
    setCopiedCode(false);
    const trimmed = exportPasscode.trim();
    if (trimmed.length < 4) {
      setExportMsg({ type: "err", text: "נא להזין קוד העברה בן 4 תווים לפחות (מומלץ 6 תווים ומעלה)." });
      return;
    }
    setExporting(true);
    try {
      const res = await fetch("/api/sync/setup-bundle/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setExportMsg({ type: "err", text: data.error || "שגיאה ביצירת חבילת ההעברה" });
        return;
      }

      setExportedCode(data.transferCode || null);
      if (action === "download") {
        const blob = new Blob([data.bundleJson], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = data.fileName || "otzar-sefarim-setup.otzar-setup";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setExportMsg({
          type: "ok",
          text: `קובץ ההעברה (${data.fileName}) הורד בהצלחה. שמור את קוד ההעברה לשימוש במחשב הישיבה.`,
        });
      } else if (data.transferCode) {
        await navigator.clipboard.writeText(data.transferCode);
        setCopiedCode(true);
        setExportMsg({
          type: "ok",
          text: "קוד ההעברה המוצפן הועתק ללוח. ניתן להדביק אותו במחשב הישיבה.",
        });
      }
    } catch (err: any) {
      setExportMsg({ type: "err", text: err?.message || "שגיאה בהפקת חבילת ההעברה" });
    } finally {
      setExporting(false);
    }
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    try {
      const text = await file.text();
      setBundleInput(text);
      setImportedFileName(file.name);
    } catch {
      setImportError("לא ניתן לקרוא את הקובץ שנבחר.");
    }
    e.target.value = "";
  };

  const handleImport = async () => {
    setImportError(null);
    setImportSuccess(null);
    if (!bundleInput.trim()) {
      setImportError("נא לבחור קובץ .otzar-setup או להדביק קוד העברה.");
      return;
    }
    if (!importPasscode.trim()) {
      setImportError("נא להזין את קוד ההעברה שנקבע בעת הייצוא.");
      return;
    }
    setImporting(true);
    try {
      const res = await fetch("/api/sync/setup-bundle/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundleInput: bundleInput.trim(),
          passcode: importPasscode.trim(),
          clearDemoData,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setImportError(data.error || "שגיאה בייבוא חבילת ההעברה");
        return;
      }
      setImportSuccess(data);
      setBundleInput("");
      setImportedFileName(null);
      setImportPasscode("");
      await loadSummary();
      onReload();
    } catch (err: any) {
      setImportError(err?.message || "שגיאת תקשורת בעת ייבוא ההגדרות");
    } finally {
      setImporting(false);
    }
  };

  const handleCleanStart = async () => {
    setCleanError(null);
    setCleaning(true);
    try {
      const res = await fetch("/api/sync/clean-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmText: cleanConfirmText.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCleanError(data.error || "שגיאה באיפוס מאגר הספרים");
        return;
      }
      setCleanModalOpen(false);
      setCleanAck(false);
      setCleanConfirmText("");
      setCleanSuccessMsg(
        `איפוס בוצע בהצלחה: נמחקו ${data.deletedBooks ?? 0} ספרים, ${data.deletedLoans ?? 0} השאלות ו-${data.deletedAiQueue ?? 0} פריטים בתור AI. מונה הברקודים אופס ל-${data.nextBarcode ?? 100001} והארונות וההגדרות נשמרו.`
      );
      onReload();
    } catch (err: any) {
      setCleanError(err?.message || "שגיאת תקשורת בעת האיפוס");
    } finally {
      setCleaning(false);
    }
  };

  const exportPassLen = exportPasscode.trim().length;

  return (
    <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] space-y-5">
      {(section === "transfer" || section === "all") && (<>
      {/* Header + Segmented Switch */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 font-semibold text-base">
            <PackageCheck className="w-4 h-4 text-[var(--otzar-accent)]" />
            <span>העברה והתקנה במחשב חדש (הישיבה)</span>
          </div>
          <p className="text-xs text-[var(--otzar-text-muted)]">
            העברה מוצפנת בלחיצה אחת של חיבור ה-Firebase, מפתחות ה-AI והגדרות המערכת עם משיכת ספרים אוטומטית מהענן.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)]">
          <button
            type="button"
            onClick={() => setMode("export")}
            className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 ${
              mode === "export" ? "bg-[var(--otzar-accent)] text-white" : "text-[var(--otzar-text-muted)]"
            }`}
          >
            ייצוא ממחשב זה
          </button>
          <button
            type="button"
            onClick={() => setMode("import")}
            className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 ${
              mode === "import" ? "bg-[var(--otzar-accent)] text-white" : "text-[var(--otzar-text-muted)]"
            }`}
          >
            ייבוא במחשב חדש
          </button>
        </div>
      </div>

      {mode === "export" ? (
        <div className="space-y-4">
          {summary && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--otzar-text-muted)] tabular-nums">
              <span>
                Firebase:{" "}
                <strong className="text-[var(--otzar-text)]">
                  {summary.hasFirebase ? `מחובר (${summary.projectId})` : "לא הוגדר"}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                מפתחות AI: <strong className="text-[var(--otzar-text)]">{summary.aiKeysCount}</strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                הגדרות תצוגה, מדבקות ו-A4: <strong className="text-[var(--otzar-text)]">כלולות</strong>
              </span>
            </div>
          )}

          <div className="space-y-1.5 max-w-md">
            <label className="block text-xs font-medium">
              קוד אבטחה להצפנת החבילה (לשימוש בעת הייבוא במחשב הישיבה)
            </label>
            <div className="relative flex items-center">
              <input
                type={showExportPass ? "text" : "password"}
                dir="ltr"
                value={exportPasscode}
                onChange={(e) => setExportPasscode(e.target.value)}
                placeholder="הזן קוד העברה (מומלץ 6 תווים ומעלה)"
                className="w-full px-3 py-2 pl-9 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setShowExportPass((v) => !v)}
                className="absolute left-2.5 text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] cursor-pointer"
                title={showExportPass ? "הסתר קוד" : "הצג קוד"}
              >
                {showExportPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-[var(--otzar-text-muted)]">
              מומלץ לבחור קוד העברה בן <strong>6 תווים ומעלה</strong> לשמירה על מפתחות ה-AI וסיסמת הענן.
              {exportPassLen > 0 && (
                <span
                  className={`mr-1.5 font-medium tabular-nums ${
                    exportPassLen >= 6 ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"
                  }`}
                >
                  {exportPassLen >= 6
                    ? `(אורך מומלץ: ${exportPassLen} תווים)`
                    : `(קצר: ${exportPassLen} תווים — מומלץ 6+)`}
                </span>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              disabled={exporting}
              onClick={() => handleExport("download")}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
            >
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              הורד קובץ העברה (.otzar-setup)
            </button>
            <button
              type="button"
              disabled={exporting}
              onClick={() => handleExport("copy")}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Copy className="w-4 h-4 text-[var(--otzar-accent)]" />
              {copiedCode ? "קוד ההעברה הועתק!" : "העתק קוד העברה מהיר"}
            </button>
          </div>

          {exportMsg && (
            <div
              className={`p-3 rounded-lg text-xs font-medium border ${
                exportMsg.type === "ok"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200 dark:border-emerald-800"
                  : "border-red-300 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-200 dark:border-red-800"
              }`}
            >
              {exportMsg.text}
            </div>
          )}

          {exportedCode && (
            <div className="space-y-1">
              <div className="text-xs text-[var(--otzar-text-muted)]">קוד העברה מוצפן שנוצר:</div>
              <textarea
                readOnly
                dir="ltr"
                rows={2}
                value={exportedCode}
                onFocus={(e) => e.target.select()}
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] font-mono text-xs"
              />
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <label className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] cursor-pointer whitespace-nowrap shrink-0">
              <Upload className="w-4 h-4 text-[var(--otzar-accent)]" />
              <span>{importedFileName ? `נבחר: ${importedFileName}` : "בחר קובץ .otzar-setup"}</span>
              <input type="file" accept=".otzar-setup,.json,.txt" onChange={handleFilePick} className="hidden" />
            </label>
            <span className="text-xs text-[var(--otzar-text-muted)]">או הדבק קוד העברה מטה:</span>
          </div>

          <textarea
            dir="ltr"
            rows={3}
            value={bundleInput}
            onChange={(e) => {
              setBundleInput(e.target.value);
              setImportedFileName(null);
            }}
            placeholder="OTZAR-SETUP:... או הדבק את תוכן קובץ ה-.otzar-setup"
            className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs"
          />

          <div className="space-y-1.5 max-w-md">
            <label className="block text-xs font-medium">קוד האבטחה שנקבע בעת הייצוא</label>
            <div className="relative flex items-center">
              <input
                type={showImportPass ? "text" : "password"}
                dir="ltr"
                value={importPasscode}
                onChange={(e) => setImportPasscode(e.target.value)}
                placeholder="הזן קוד העברה לפענוח"
                className="w-full px-3 py-2 pl-9 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setShowImportPass((v) => !v)}
                className="absolute left-2.5 text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] cursor-pointer"
                title={showImportPass ? "הסתר קוד" : "הצג קוד"}
              >
                {showImportPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <label className="flex items-start gap-2.5 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={clearDemoData}
              onChange={(e) => setClearDemoData(e.target.checked)}
              className="mt-0.5 rounded border-[var(--otzar-border-muted)] accent-[var(--otzar-accent)]"
            />
            <span>
              <strong className="text-[var(--otzar-text)]">נקה נתוני דמו ראשוניים (מקומית בלבד) ומשוך מהענן</strong>
              <span className="block text-[var(--otzar-text-muted)] mt-0.5">
                מוחק רק את רשומות הדמו במחשב זה ללא השפעה על הענן, ורק לאחר אימות חיבור תקין ל-Firebase.
              </span>
            </span>
          </label>

          <button
            type="button"
            disabled={importing}
            onClick={handleImport}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
          >
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackageCheck className="w-4 h-4" />}
            {importing ? "מאמת חיבור ומושך ספרייה מהענן..." : "אמת חיבור, יבא הגדרות ומשוך ספרייה"}
          </button>

          {importError && (
            <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-200 dark:border-red-800 text-xs font-medium">
              {importError}
            </div>
          )}

          {importSuccess && (
            <div className="space-y-2.5">
              <div className="p-3.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200 dark:border-emerald-800 text-xs space-y-1.5">
                <div className="flex items-center gap-1.5 font-semibold">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{importSuccess.message}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 tabular-nums">
                  <span>ארונות: {importSuccess.importedCounts.cabinets}</span>
                  <span aria-hidden="true">·</span>
                  <span>ספרים: {importSuccess.importedCounts.books}</span>
                  <span aria-hidden="true">·</span>
                  <span>שואלים: {importSuccess.importedCounts.borrowers}</span>
                  <span aria-hidden="true">·</span>
                  <span>מפתחות AI: {importSuccess.importedCounts.aiKeysCount}</span>
                  <span aria-hidden="true">·</span>
                  <span>ברקוד אוטומטי הבא: {importSuccess.nextBarcode}</span>
                </div>
              </div>
              {importSuccess.deleteFileReminder && (
                <div className="p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-800 text-xs flex items-center gap-2 font-medium">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span>
                    תזכורת אבטחה: מטעמי בטיחות, מומלץ למחוק כעת את קובץ ההעברה (.otzar-setup) מתיקיית ההורדות או מההתקן הנייד.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      </>)}



      {/* Clean Start Reset Section */}

      {(section === "reset" || section === "all") && (<>
      <div className={section === "all" ? "border-t border-[var(--otzar-border-muted)] pt-4 space-y-2.5" : "space-y-2.5"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <RotateCcw className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              <span>התחלה נקייה בישיבה (איפוס ספרי ניסיון בלבד)</span>
            </div>
            <p className="text-xs text-[var(--otzar-text-muted)]">
              מוחק רק ספרים, השאלות ותור AI (ומאפס את מונה הברקודים ל-100001) לקראת קטלוג אמת — תוך שמירה מלאה על מפת הארונות, מפתחות ה-AI, חיבור ה-Firebase והמדבקות.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setCleanError(null);
              setCleanAck(false);
              setCleanConfirmText("");
              setCleanModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40 cursor-pointer whitespace-nowrap shrink-0"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            איפוס מאגר ספרים והשאלות לקראת קטלוג אמת
          </button>
        </div>

        {cleanSuccessMsg && (
          <div className="p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200 dark:border-emerald-800 text-xs font-medium">
            {cleanSuccessMsg}
          </div>
        )}
      </div>

      </>)}



      {/* Double Confirmation Modal for Clean Start */}
      {cleanModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-[var(--otzar-text)] p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-base text-red-700 dark:text-red-400">
                <AlertTriangle className="w-5 h-5" />
                <span>אישור כפול — התחלה נקייה לקטלוג אמת</span>
              </div>
              <button
                type="button"
                onClick={() => setCleanModalOpen(false)}
                className="p-1 rounded-md text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-lg border border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20 space-y-1">
                <div className="font-semibold text-red-800 dark:text-red-300">יימחקו לצמיתות:</div>
                <ul className="list-disc pr-4 space-y-0.5 text-red-900/90 dark:text-red-200/90">
                  <li>כל הספרים הקיימים (מקומית ובענן)</li>
                  <li>כל רישומי ההשאלות</li>
                  <li>תור הסריקות של ה-AI ותמונותיו</li>
                  <li>מונה הברקודים יאופס ל-100001</li>
                </ul>
              </div>
              <div className="p-3 rounded-lg border border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/20 space-y-1">
                <div className="font-semibold text-emerald-800 dark:text-emerald-300">יישמרו ללא פגע:</div>
                <ul className="list-disc pr-4 space-y-0.5 text-emerald-900/90 dark:text-emerald-200/90">
                  <li>מפת הארונות שעיצבת</li>
                  <li>מפתחות ה-AI והגדרות המודלים</li>
                  <li>חיבור ה-Firebase ורשימת השואלים</li>
                  <li>תבניות המדבקות, A4 ושם הישיבה</li>
                </ul>
              </div>
            </div>

            <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={cleanAck}
                onChange={(e) => setCleanAck(e.target.checked)}
                className="mt-0.5 rounded border-[var(--otzar-border-muted)] accent-red-600"
              />
              <span>אני מאשר שספרי הניסיון וההשאלות יימחקו ומוכן להתחיל קטלוג אמת מברקוד 100001.</span>
            </label>

            <div className="space-y-1">
              <label className="block text-xs font-medium">לאישור סופי הקלד: אפס (או את קוד ה-PIN של המנהל)</label>
              <input
                type="text"
                value={cleanConfirmText}
                onChange={(e) => setCleanConfirmText(e.target.value)}
                placeholder="הקלד: אפס"
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface)] text-sm"
              />
            </div>

            {cleanError && (
              <div className="p-2.5 rounded-lg border border-red-300 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-200 text-xs font-medium">
                {cleanError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setCleanModalOpen(false)}
                className="px-3.5 py-2 rounded-lg text-xs font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] cursor-pointer"
              >
                ביטול
              </button>
              <button
                type="button"
                disabled={cleaning || !cleanAck || !cleanConfirmText.trim()}
                onClick={handleCleanStart}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 cursor-pointer"
              >
                {cleaning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                {cleaning ? "מאפס מאגר..." : "בצע איפוס ספרי ניסיון עכשיו"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};