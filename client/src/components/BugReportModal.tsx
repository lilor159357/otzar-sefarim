import React, { useState } from "react";
import { Bug, X, Send, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useStrings } from "../lib/stringsContext.tsx";

interface BugReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  appVersion?: string;
  totalBooks?: number;
  totalCabinets?: number;
}

export const BugReportModal: React.FC<BugReportModalProps> = ({
  isOpen,
  onClose,
  appVersion = "v1.0.17",
  totalBooks = 0,
  totalCabinets = 0,
}) => {
  const { t } = useStrings();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("פענוח AI");
  const [description, setDescription] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setStatusMessage(null);

    const diagnosticsObj = includeDiagnostics
      ? {
          app_version: appVersion,
          user_agent: navigator.userAgent,
          platform: navigator.platform,
          screen_resolution: `${window.innerWidth}x${window.innerHeight}`,
          total_books: totalBooks,
          total_cabinets: totalCabinets,
          time: new Date().toISOString(),
        }
      : {};

    try {
      const res = await fetch("/api/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          category,
          diagnostics: diagnosticsObj,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "שגיאה בשליחת דיווח התקלה");
      }

      setStatusMessage({
        type: "success",
        text: `הדיווח נשלח בהצלחה ונרשם במערכת המעקב (מזהה: ${data.reportId || "OK"}). ייפתח עבורו GitHub Issue אוטומטי.`,
      });

      setTimeout(() => {
        setTitle("");
        setDescription("");
        onClose();
      }, 2500);
    } catch (err: any) {
      setStatusMessage({
        type: "error",
        text: err?.message || "נכשלה שליחת דיווח התקלה. אנא נסה שוב מאוחר יותר.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-200">
      <div className="bg-[var(--otzar-surface)] border border-[var(--otzar-border)] rounded-2xl shadow-2xl max-w-lg w-full p-6 space-y-4 text-[var(--otzar-text)]">
        <div className="flex items-center justify-between border-b border-[var(--otzar-border-muted)] pb-3">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400">
              <Bug className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-lg">דיווח על תקלה / באג</h2>
              <p className="text-xs text-[var(--otzar-text-muted)]">הדיווח יישלח ישירות למפתח דרך GitHub ו-Firestore</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {statusMessage && (
          <div
            className={`p-3 rounded-xl flex items-center gap-2 text-xs font-semibold ${
              statusMessage.type === "success"
                ? "bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300"
                : "bg-red-50 text-red-800 border border-red-200 dark:bg-red-950/40 dark:text-red-300"
            }`}
          >
            {statusMessage.type === "success" ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            <span>{statusMessage.text}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div>
            <label className="block text-xs font-bold mb-1">כותרת התקלה *</label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="לדוגמה: ארון בורח מחוץ לגבולות המפה / שגיאה בסריקת סט"
              className="w-full px-3 py-2 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-sm focus:outline-none focus:border-[var(--otzar-accent)]"
            />
          </div>

          <div>
            <label className="block text-xs font-bold mb-1">קטגוריה</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-sm focus:outline-none focus:border-[var(--otzar-accent)]"
            >
              <option value="פענוח AI">פענוח AI וסריקת ספרים</option>
              <option value="מפה וארונות">מפה דו-ממדית ועורך ארונות</option>
              <option value="סנכרון ומובייל">סנכרון ענן ומכשיר נייד</option>
              <option value="השאלה ומחזור">השאלות, החזרות וסל מיחזור</option>
              <option value="כללי">ממשק, עיצוב או כללי</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold mb-1">פירוט התקלה והשלבים לשחזור</label>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="פרט מה קרה, מה ציפית שיקרה, ואילו פעולות ביצעת לפני הופעת התקלה..."
              className="w-full px-3 py-2 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-sm focus:outline-none focus:border-[var(--otzar-accent)] resize-none"
            />
          </div>

          <div className="flex items-center gap-2 p-2.5 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] text-xs text-[var(--otzar-text-muted)]">
            <input
              type="checkbox"
              id="includeDiag"
              checked={includeDiagnostics}
              onChange={(e) => setIncludeDiagnostics(e.target.checked)}
              className="rounded accent-[var(--otzar-accent)] cursor-pointer"
            />
            <label htmlFor="includeDiag" className="cursor-pointer select-none">
              צרף אוטומטית נתוני מערכת ואבחון (גרסה {appVersion}, גודל מסך, {totalBooks} ספרים, {totalCabinets} ארונות)
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--otzar-border-muted)]">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 rounded-xl border border-[var(--otzar-border-muted)] text-sm font-medium hover:bg-[var(--otzar-surface-alt)] cursor-pointer"
            >
              ביטול
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-bold shadow-sm transition-colors cursor-pointer disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              <span>{submitting ? "שולח דיווח..." : "שלח דיווח תקלה"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
