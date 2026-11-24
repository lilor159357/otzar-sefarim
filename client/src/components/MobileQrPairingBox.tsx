import React, { useEffect, useState } from "react";
import { QrCode, RefreshCw, EyeOff, Smartphone, Copy, Check, Loader2, ShieldAlert } from "lucide-react";

interface MobileQrResult {
  qrDataUrl: string;
  pairingCode: string;
  libraryName: string;
  projectId: string;
  expiresInSec: number;
}

export const MobileQrPairingBox: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrData, setQrData] = useState<MobileQrResult | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!qrData || secondsLeft <= 0) return;
    const t = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          setQrData(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [qrData, secondsLeft]);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/sync/mobile-qr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.qrDataUrl) {
        setError(data.error || "שגיאה ביצירת ברקוד לחיבור הטלפון");
        return;
      }
      setQrData(data as MobileQrResult);
      setSecondsLeft(Number(data.expiresInSec) || 120);
    } catch (err: any) {
      setError(err?.message || "שגיאה ביצירת ברקוד");
    } finally {
      setLoading(false);
    }
  };

  const handleCopyCode = async () => {
    if (!qrData?.pairingCode) return;
    try {
      await navigator.clipboard.writeText(qrData.pairingCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const mm = String(Math.floor(secondsLeft / 60));
  const ss = String(secondsLeft % 60).padStart(2, "0");

  return (
    <div className="p-4 rounded-xl border border-[var(--otzar-accent)]/35 bg-[var(--otzar-accent-soft)]/30 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 font-semibold text-sm text-[var(--otzar-text)]">
            <Smartphone className="w-4 h-4 text-[var(--otzar-accent)]" />
            <span>חיבור אפליקציית הטלפון בסריקת ברקוד (QR)</span>
          </div>
          <p className="text-xs text-[var(--otzar-text-muted)]">
            סורקים במצלמת אפליקציית המובייל ומתחברים ישירות לספרייה בלחיצה אחת בלי להקליד סיסמה.
          </p>
        </div>

        {!qrData ? (
          <button
            type="button"
            disabled={loading}
            onClick={handleGenerate}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
            <span>הצג ברקוד לחיבור מהיר</span>
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={loading}
              onClick={handleGenerate}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] hover:bg-[var(--otzar-surface)] cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>רענן</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setQrData(null);
                setSecondsLeft(0);
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] hover:bg-[var(--otzar-surface)] cursor-pointer"
            >
              <EyeOff className="w-3.5 h-3.5" />
              <span>הסתר</span>
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="p-2.5 rounded-lg border border-red-300 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-200 dark:border-red-800 text-xs">
          {error}
        </div>
      )}

      {qrData && (
        <div className="flex flex-col sm:flex-row items-center gap-4 pt-1">
          <div className="p-2.5 rounded-xl bg-white border border-slate-200 shadow-sm shrink-0">
            <img
              src={qrData.qrDataUrl}
              alt="קוד QR לחיבור אפליקציית אוצר ספרים"
              className="w-52 h-52 object-contain block"
            />
          </div>

          <div className="space-y-2 text-xs text-[var(--otzar-text-muted)] flex-1">
            <div className="font-semibold text-[var(--otzar-text)] text-sm">
              {qrData.libraryName} ({qrData.projectId})
            </div>
            <ol className="list-decimal list-inside space-y-1 leading-relaxed">
              <li>פתח את אפליקציית <strong>אוצר ספרים</strong> בטלפון.</li>
              <li>עבור למסך <strong>הגדרות / חיבור לענן</strong>.</li>
              <li>לחץ על <strong>&quot;סרוק ברקוד (QR) מהמחשב&quot;</strong> וכוון למסך.</li>
            </ol>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-100/80 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 px-2 py-1 font-medium tabular-nums">
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>מוסתר אוטומטית בעוד {mm}:{ss} — אל תצלם או תשתף</span>
              </span>
              <button
                type="button"
                onClick={handleCopyCode}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-[var(--otzar-text)] hover:bg-[var(--otzar-surface)] cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? "הועתק!" : "העתק קוד"}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
