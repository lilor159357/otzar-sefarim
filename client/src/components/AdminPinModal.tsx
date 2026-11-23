import React, { useEffect, useRef, useState } from "react";
import { Lock, ShieldCheck, X } from "lucide-react";

interface AdminPinModalProps {
  onSuccess: (token: string) => void;
  onClose: () => void;
}

export const AdminPinModal: React.FC<AdminPinModalProps> = ({ onSuccess, onClose }) => {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 40);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: pin.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "קוד שגוי");
        setPin("");
        inputRef.current?.focus();
        return;
      }
      onSuccess(data.token);
    } catch {
      setError("שגיאה בתקשורת עם השרת");
    } finally {
      setLoading(false);
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
        className="w-full max-w-sm rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-[var(--otzar-text)] p-6 space-y-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-base">
            <Lock className="w-4 h-4 text-[var(--otzar-accent)]" />
            <span>כניסת מנהל (Admin)</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--otzar-surface-alt)] text-[var(--otzar-text-muted)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-[var(--otzar-text-muted)]">
          הזן קוד PIN לפתיחת קטלוג, עריכת ספרים, הדפסת מדבקות, עורך מפה והגדרות. (ברירת מחדל ראשונית: <span className="font-mono">1234</span>)
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            dir="ltr"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="PIN"
            className="w-full px-4 py-2.5 text-center tracking-widest text-lg font-mono rounded-lg border-2 border-[var(--otzar-border)] bg-[var(--otzar-bg)] focus:outline-none focus:border-[var(--otzar-accent)]"
          />

          {error && (
            <div className="text-xs text-red-600 text-center font-medium">{error}</div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-lg text-sm border border-[var(--otzar-border-muted)] cursor-pointer"
            >
              ביטול
            </button>
            <button
              type="submit"
              disabled={loading || !pin.trim()}
              className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
            >
              <ShieldCheck className="w-4 h-4" />
              {loading ? "מאמת..." : "פתח מצב מנהל"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
