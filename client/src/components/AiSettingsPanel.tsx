import React, { useEffect, useState } from "react";
import { CheckCircle2, Database, Eye, EyeOff, Loader2, PlugZap, RefreshCw, SlidersHorizontal, Trash2, AlertTriangle } from "lucide-react";

interface AiSettingsPanelProps {
  settings: Record<string, any>;
  setSettings: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  onReload: () => Promise<void>;
}

const PRESET_MODELS = [
  { id: "gemini-4-hydrogen", label: "gemini-4-hydrogen (ברירת מחדל)" },
  { id: "gemini-3.8-flash", label: "gemini-3.8-flash" },
  { id: "gemini-3.5-flash-lite", label: "gemini-3.5-flash-lite" },
];

export const AiSettingsPanel: React.FC<AiSettingsPanelProps> = ({ settings, setSettings, onReload }) => {
  const [showKey, setShowKey] = useState(false);
  const [savingAi, setSavingAi] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs?: number } | null>(null);

  const [embStats, setEmbStats] = useState<{ totalBooks: number; indexedBooks: number; missingBooks: number } | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexMsg, setReindexMsg] = useState<string | null>(null);

  const [cleaning, setCleaning] = useState(false);
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);

  const loadStats = async () => {
    const res = await fetch("/api/ai/embeddings-stats");
    if (res.ok) setEmbStats(await res.json());
  };

  useEffect(() => {
    loadStats();
  }, []);

  const saveAiSettings = async () => {
    setSavingAi(true);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ai_api_key: String(settings.ai_api_key || "").trim(),
          ai_model: String(settings.ai_model || "gemini-4-hydrogen").trim() || "gemini-4-hydrogen",
          embedding_model: String(settings.embedding_model || "gemini-embedding-001").trim() || "gemini-embedding-001",
          ai_delay_ms: String(settings.ai_delay_ms || "4200"),
        }),
      });
      await onReload();
    } finally {
      setSavingAi(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    await saveAiSettings();
    try {
      const res = await fetch("/api/ai/test", { method: "POST" });
      const data = await res.json();
      setTestResult(data);
    } catch {
      setTestResult({ ok: false, message: "כשל בפנייה לשרת המקומי" });
    } finally {
      setTesting(false);
    }
  };

  const handleReindexMissing = async () => {
    setReindexing(true);
    setReindexMsg(null);
    await saveAiSettings();
    try {
      const res = await fetch("/api/ai/reindex-embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forceAll: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        setReindexMsg(data.error || "שגיאה באינדוקס");
      } else {
        setReindexMsg(
          `אוינדקסו ${data.indexed} ספרים בהצלחה (${data.failed} נכשלו). סה״כ מאונדקסים: ${data.indexedBooks}/${data.totalBooks}.${
            data.lastError ? " הערה: " + data.lastError : ""
          }`
        );
        await loadStats();
      }
    } catch {
      setReindexMsg("כשל בתקשורת עם השרת");
    } finally {
      setReindexing(false);
    }
  };

  const handleCleanupImages = async () => {
    setCleaning(true);
    setCleanupMsg(null);
    try {
      const res = await fetch("/api/ai/cleanup-images", { method: "POST" });
      const data = await res.json();
      setCleanupMsg(`נמחקו ${data.deletedFiles} תמונות של ספרים מאושרים/דחויים (פונו ${data.freedKb} KB).`);
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Gemini Vision & Model Settings */}
      <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-base flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-[var(--otzar-accent)]" />
            פענוח שערי ספרים וחיפוש מורחב (אופציונלי)
          </h2>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-xs font-medium mb-1">מפתח חיבור לשירות הפענוח (Gemini API — אופציונלי)</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey ? "text" : "password"}
                  dir="ltr"
                  value={settings.ai_api_key || ""}
                  onChange={(e) => setSettings((p) => ({ ...p, ai_api_key: e.target.value }))}
                  placeholder="AIza..."
                  className="w-full px-3 py-2 pl-9 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--otzar-text-muted)] cursor-pointer"
                  title={showKey ? "הסתר" : "הצג"}
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <button
                type="button"
                disabled={testing}
                onClick={handleTestConnection}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-[var(--otzar-accent)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-surface)] cursor-pointer whitespace-nowrap"
              >
                {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
                בדיקת חיבור
              </button>
            </div>
          </div>

          {testResult && (
            <div
              className={`flex items-center gap-2 p-3 rounded-lg border text-xs ${
                testResult.ok
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : "border-red-300 bg-red-50 text-red-800"
              }`}
            >
              {testResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
              <span>
                {testResult.message}
                {testResult.latencyMs ? ` (${testResult.latencyMs}ms)` : ""}
              </span>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium mb-1.5">מנוע פענוח שערים (ברירת מחדל או עריכה חופשית)</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {PRESET_MODELS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSettings((p) => ({ ...p, ai_model: m.id }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono border cursor-pointer ${
                    (settings.ai_model || "gemini-4-hydrogen") === m.id
                      ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)] text-[var(--otzar-accent)] font-semibold"
                      : "border-[var(--otzar-border-muted)]"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <input
              type="text"
              dir="ltr"
              value={settings.ai_model || "gemini-4-hydrogen"}
              onChange={(e) => setSettings((p) => ({ ...p, ai_model: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">מנוע אינדוקס חיפוש</label>
              <input
                type="text"
                dir="ltr"
                value={settings.embedding_model || "gemini-embedding-001"}
                onChange={(e) => setSettings((p) => ({ ...p, embedding_model: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">השהיה בין תמונות בתור (מילישניות)</label>
              <input
                type="number"
                min={500}
                max={30000}
                step={200}
                value={settings.ai_delay_ms || "4200"}
                onChange={(e) => setSettings((p) => ({ ...p, ai_delay_ms: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums text-xs"
              />
            </div>
          </div>

          <button
            type="button"
            disabled={savingAi}
            onClick={saveAiSettings}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
          >
            {savingAi ? "שומר..." : "שמור הגדרות פענוח"}
          </button>
        </div>
      </div>

      {/* Semantic Embeddings Indexer + Image Disk Cleanup */}
      <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] space-y-4">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <Database className="w-4 h-4 text-[var(--otzar-accent)]" />
          תחזוקת אינדקס חיפוש וקבצי סריקה
        </h2>

        <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-lg bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] text-sm">
          <div>
            <div className="font-semibold">אינדקס חיפוש מורחב לפי הקשר ומשמעות</div>
            <div className="text-xs text-[var(--otzar-text-muted)] tabular-nums">
              {embStats
                ? `מאונדקסים: ${embStats.indexedBooks} מתוך ${embStats.totalBooks} ספרים (חסרים: ${embStats.missingBooks})`
                : "טוען נתונים..."}
            </div>
          </div>
          <button
            type="button"
            disabled={reindexing || (embStats?.missingBooks ?? 0) === 0}
            onClick={handleReindexMissing}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
          >
            {reindexing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {reindexing ? "מעדכן אינדקס..." : "עדכן אינדקס לספרים חסרים"}
          </button>
        </div>

        {reindexMsg && <div className="text-xs p-3 rounded-lg bg-[var(--otzar-surface)] border border-[var(--otzar-border)]">{reindexMsg}</div>}

        <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-lg bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] text-sm">
          <div>
            <div className="font-semibold">ניקוי קבצי תמונות שכבר טופלו</div>
            <div className="text-xs text-[var(--otzar-text-muted)]">
              מוחק מהדיסק את צילומי השערים של ספרים שכבר אושרו או נדחו כדי לחסוך מקום במחשב.
            </div>
          </div>
          <button
            type="button"
            disabled={cleaning}
            onClick={handleCleanupImages}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold border border-red-300 text-red-700 hover:bg-red-50 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {cleaning ? "מנקה..." : "ניקוי תמונות של ספרים שאושרו"}
          </button>
        </div>

        {cleanupMsg && <div className="text-xs p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800">{cleanupMsg}</div>}
      </div>
    </div>
  );
};
