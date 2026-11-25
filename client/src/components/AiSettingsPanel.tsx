import React, { useEffect, useState } from "react";
import {
  SlidersHorizontal,
  PlugZap,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Trash2,
  Database,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  KeyRound,
} from "lucide-react";
import type { AiPoolKeyStatus } from "../types.ts";

interface AiSettingsPanelProps {
  settings: Record<string, string>;
  setSettings: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onReload: () => Promise<void>;
}

const PRESET_MODELS = [
  { id: "gemini-3.5-flash", label: "gemini-3.5-flash (יציב ומהיר — מומלץ)" },
  { id: "gemini-2.5-flash", label: "gemini-2.5-flash (גיבוי אמין)" },
  { id: "gemini-3.8-flash", label: "gemini-3.8-flash" },
  { id: "gemini-4-hydrogen", label: "gemini-4-hydrogen" },
  { id: "gemini-3.5-flash-lite", label: "gemini-3.5-flash-lite" },
];

const KEY_STATUS_LABELS: Record<AiPoolKeyStatus["status"], string> = {
  ready: "זמין",
  cooldown: "בהשהיה זמנית",
  invalid: "לא תקין",
  disabled: "מושבת",
};

export const AiSettingsPanel: React.FC<AiSettingsPanelProps> = ({ settings, setSettings, onReload }) => {
  const [poolKeys, setPoolKeys] = useState<AiPoolKeyStatus[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [savingKeys, setSavingKeys] = useState(false);

  const [newLabel, setNewLabel] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [showNewKey, setShowNewKey] = useState(false);
  const [testingKeyId, setTestingKeyId] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs?: number } | null>(null);
  const [savingAi, setSavingAi] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const [embStats, setEmbStats] = useState<{ totalBooks: number; indexedBooks: number; missingBooks: number } | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexMsg, setReindexMsg] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);

  const loadPoolKeys = async () => {
    setLoadingKeys(true);
    try {
      const res = await fetch("/api/ai/keys");
      if (res.ok) {
        const data = await res.json();
        setPoolKeys(Array.isArray(data.keys) ? data.keys : []);
      }
    } finally {
      setLoadingKeys(false);
    }
  };

  const loadEmbStats = async () => {
    const res = await fetch("/api/ai/embeddings-stats");
    if (res.ok) setEmbStats(await res.json());
  };

  useEffect(() => {
    loadPoolKeys();
    loadEmbStats();
  }, []);

  const persistPool = async (nextList: Array<{ id?: string; label: string; apiKey?: string; enabled: boolean }>) => {
    setSavingKeys(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/ai/keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: nextList }),
      });
      const data = await res.json();
      if (res.ok) {
        setPoolKeys(Array.isArray(data.keys) ? data.keys : []);
        await onReload();
      }
    } finally {
      setSavingKeys(false);
    }
  };

  const handleAddKeyToPool = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanedKey = newApiKey.trim();
    if (!cleanedKey) return;
    const payload = [
      ...poolKeys.map((k) => ({ id: k.id, label: k.label, enabled: k.enabled })),
      {
        label: newLabel.trim() || `חשבון ${poolKeys.length + 1}`,
        apiKey: cleanedKey,
        enabled: true,
      },
    ];
    await persistPool(payload);
    setNewLabel("");
    setNewApiKey("");
    setShowNewKey(false);
  };

  const handleToggleKeyEnabled = async (id: string) => {
    const payload = poolKeys.map((k) => ({
      id: k.id,
      label: k.label,
      enabled: k.id === id ? !k.enabled : k.enabled,
    }));
    await persistPool(payload);
  };

  const handleRemoveKey = async (id: string) => {
    const payload = poolKeys
      .filter((k) => k.id !== id)
      .map((k) => ({ id: k.id, label: k.label, enabled: k.enabled }));
    await persistPool(payload);
  };

  const handleTestSingleKey = async (id: string) => {
    setTestingKeyId(id);
    setTestResult(null);
    try {
      const res = await fetch(`/api/ai/keys/${encodeURIComponent(id)}/test`, { method: "POST" });
      const data = await res.json();
      setTestResult({ ok: Boolean(data.ok), message: data.message || "", latencyMs: data.latencyMs });
      if (Array.isArray(data.keys)) setPoolKeys(data.keys);
    } catch {
      setTestResult({ ok: false, message: "שגיאה בבדיקת המפתח" });
    } finally {
      setTestingKeyId(null);
    }
  };

  const saveAiSettings = async () => {
    setSavingAi(true);
    setSaveNotice(null);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ai_model: settings.ai_model || "gemini-3.5-flash",
          ai_auto_fallback: settings.ai_auto_fallback === "false" ? "false" : "true",
          embedding_model: settings.embedding_model || "gemini-embedding-001",
          ai_delay_ms: settings.ai_delay_ms || "4200",
        }),
      });
      await onReload();
      setSaveNotice("הגדרות מודל הפענוח והקצב נשמרו.");
    } finally {
      setSavingAi(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/ai/test", { method: "POST" });
      const data = await res.json();
      setTestResult({ ok: Boolean(data.ok), message: data.message || "", latencyMs: data.latencyMs });
      if (Array.isArray(data.keys)) setPoolKeys(data.keys);
    } catch {
      setTestResult({ ok: false, message: "שגיאת תקשורת מול השרת המקומי" });
    } finally {
      setTesting(false);
    }
  };

  const handleReindexMissing = async () => {
    setReindexing(true);
    setReindexMsg(null);
    try {
      const res = await fetch("/api/ai/reindex-embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forceAll: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        setReindexMsg(data.error || "שגיאה בבניית האינדקס");
      } else {
        setReindexMsg(`אינדוקס הסתיים: ${data.indexed} ספרים אונדקסו בהצלחה${data.failed ? ` (${data.failed} נכשלו)` : ""}.`);
        await loadEmbStats();
        await loadPoolKeys();
      }
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
      setCleanupMsg(`נמחקו ${data.deletedFiles} קבצי תמונה יתומים/שפג תוקפם (פונו ${data.freedKb} KB). תמונות פעילות לעריכה חוזרת וסל המחזור (30 יום) נשמרו.`);
    } finally {
      setCleaning(false);
    }
  };

  const activeReadyCount = poolKeys.filter((k) => k.enabled && k.status === "ready").length;

  return (
    <div className="space-y-5">
      {/* AI Key Roulette Pool */}
      <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-base flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-[var(--otzar-accent)]" />
              רולטת מפתחות AI (מחשבונות נפרדים — לפי עומס אחרון)
            </h2>
            <p className="text-xs text-[var(--otzar-text-muted)] mt-0.5">
              אין מפתח ראשי קבוע. בכל בקשה המערכת בוחרת במפתח הפנוי עם העומס הנמוך ביותר לאחרונה, ובשגיאת מכסה (429) מעבירה להשהיה של 60 שניות ועוברת מיידית למפתח הבא.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={loadPoolKeys}
              disabled={loadingKeys}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingKeys ? "animate-spin" : ""}`} />
              רענן מצב
            </button>
            <button
              type="button"
              disabled={testing || poolKeys.length === 0}
              onClick={handleTestConnection}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold border border-[var(--otzar-accent)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-surface)] cursor-pointer whitespace-nowrap disabled:opacity-40"
            >
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
              בדוק רולטה
            </button>
          </div>
        </div>

        {/* Add key form */}
        <form onSubmit={handleAddKeyToPool} className="grid grid-cols-1 md:grid-cols-12 gap-2.5 items-end">
          <div className="md:col-span-4">
            <label className="block text-xs font-medium mb-1">שם זיהוי / חשבון (אופציונלי)</label>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="למשל: חשבון ביהמ״ד 1"
              className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs"
            />
          </div>
          <div className="md:col-span-6">
            <label className="block text-xs font-medium mb-1">מפתח Gemini API מחשבון נפרד</label>
            <div className="relative">
              <input
                type={showNewKey ? "text" : "password"}
                dir="ltr"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                placeholder="AIza..."
                className="w-full px-3 py-2 pl-9 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => setShowNewKey((s) => !s)}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--otzar-text-muted)] cursor-pointer"
                title={showNewKey ? "הסתר" : "הצג"}
              >
                {showNewKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={savingKeys || !newApiKey.trim()}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40 whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              הוסף מפתח
            </button>
          </div>
        </form>

        {/* Keys table */}
        <div className="rounded-lg border border-[var(--otzar-border-muted)] overflow-hidden">
          {poolKeys.length === 0 ? (
            <div className="p-4 text-xs text-[var(--otzar-text-muted)] text-center">
              עדיין לא הוגדרו מפתחות AI. החיפוש הסדיר וההשאלות עובדים באופליין מלא; לפענוח שערי ספרים וחיפוש סמנטי הוסף מפתח אחד או יותר.
            </div>
          ) : (
            <div className="divide-y divide-[var(--otzar-border-muted)]">
              {poolKeys.map((k) => {
                const statusClass =
                  k.status === "ready"
                    ? "text-emerald-700 dark:text-emerald-400"
                    : k.status === "cooldown"
                    ? "text-amber-700 dark:text-amber-400"
                    : k.status === "invalid"
                    ? "text-red-700 dark:text-red-400"
                    : "text-[var(--otzar-text-muted)]";

                return (
                  <div key={k.id} className="px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-sm text-[var(--otzar-text)]">{k.label}</span>
                        <span aria-hidden="true" className="text-[var(--otzar-text-muted)]">·</span>
                        <span className="font-mono text-[var(--otzar-text-muted)]" dir="ltr">
                          {k.maskedKey}
                        </span>
                        <span aria-hidden="true" className="text-[var(--otzar-text-muted)]">·</span>
                        <span className={`font-semibold tabular-nums ${statusClass}`}>
                          {KEY_STATUS_LABELS[k.status]}
                          {k.status === "cooldown" && k.cooldownRemainingSec > 0 ? ` (${k.cooldownRemainingSec} שנ׳)` : ""}
                        </span>
                      </div>
                      <div className="text-[11px] text-[var(--otzar-text-muted)] tabular-nums flex flex-wrap items-center gap-2">
                        <span>בקשות בדקה האחרונה: {k.callsLast60s}</span>
                        <span aria-hidden="true">·</span>
                        <span>בעיבוד כעת: {k.activeInFlight}</span>
                        <span aria-hidden="true">·</span>
                        <span>סה״כ בקשות: {k.totalRequests}</span>
                        {k.lastError && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-red-600 dark:text-red-400 truncate max-w-md">{k.lastError}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={testingKeyId === k.id || !k.enabled}
                        onClick={() => handleTestSingleKey(k.id)}
                        className="px-2.5 py-1 rounded-md border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer disabled:opacity-40 whitespace-nowrap"
                      >
                        {testingKeyId === k.id ? "בודק..." : "בדיקה"}
                      </button>
                      <button
                        type="button"
                        disabled={savingKeys}
                        onClick={() => handleToggleKeyEnabled(k.id)}
                        className="px-2.5 py-1 rounded-md border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer whitespace-nowrap"
                      >
                        {k.enabled ? "השהה" : "הפעל"}
                      </button>
                      <button
                        type="button"
                        disabled={savingKeys}
                        onClick={() => handleRemoveKey(k.id)}
                        className="p-1.5 rounded-md text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer"
                        title="מחק מפתח מהרולטה"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {poolKeys.length > 0 && (
          <div className="text-xs text-[var(--otzar-text-muted)] tabular-nums">
            מפתחות זמינים כעת ברולטה: {activeReadyCount} מתוך {poolKeys.length}
          </div>
        )}

        {testResult && (
          <div
            className={`flex items-center gap-2 p-3 rounded-lg border text-xs ${
              testResult.ok
                ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                : "border-red-300 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300"
            }`}
          >
            {testResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            <span>
              {testResult.message}
              {testResult.latencyMs ? ` (${testResult.latencyMs}ms)` : ""}
            </span>
          </div>
        )}
      </div>

      {/* Gemini Vision & Model Settings */}
      <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-base flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-[var(--otzar-accent)]" />
            הגדרות מנוע פענוח ואינדוקס
          </h2>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-xs font-medium mb-1.5">מנוע פענוח שערים (ברירת מחדל או עריכה חופשית)</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {PRESET_MODELS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSettings((p) => ({ ...p, ai_model: m.id }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono border cursor-pointer whitespace-nowrap ${
                    (settings.ai_model || "gemini-3.5-flash") === m.id
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
              value={settings.ai_model || "gemini-3.5-flash"}
              onChange={(e) => setSettings((p) => ({ ...p, ai_model: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs"
            />
            <label className="mt-2.5 flex items-start gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.ai_auto_fallback !== "false"}
                onChange={(e) =>
                  setSettings((p) => ({ ...p, ai_auto_fallback: e.target.checked ? "true" : "false" }))
                }
                className="mt-0.5 rounded accent-[var(--otzar-accent)]"
              />
              <span>
                <strong>מעבר אוטומטי למודל גיבוי בזמן עומס שרת (שגיאת 503):</strong>{" "}
                <span className="text-[var(--otzar-text-muted)]">
                  חלוקת המפתחות פותרת מגבלת מכסה (429), ואילו בעומס 503 על מודל מסוים המערכת עוברת אוטומטית למודל גיבוי יציב (gemini-3.5-flash / gemini-2.5-flash) בלי לעצור את התור.
                </span>
              </span>

            <label className="mt-2.5 flex items-start gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.ai_internet_enrichment !== "false" && settings.ai_internet_enrichment !== "0"}
                onChange={(e) =>
                  setSettings((p) => ({ ...p, ai_internet_enrichment: e.target.checked ? "true" : "false" }))
                }
                className="mt-0.5 rounded accent-[var(--otzar-accent)]"
              />
              <span>
                <strong>השלמה ודיוק ביבליוגרפי מהאינטרנט (gemini-3.1-flash-lite + חיפוש גוגל):</strong>{" "}
                <span className="text-[var(--otzar-text-muted)]">
                  לאחר זיהוי ראשוני מהתמונה, המערכת מבצעת אימות מהיר ברשת להשלמת שם ספר תקני, שנת הוצאה ותיאור תוכן מדויק (אינו פוגע או חוסם במקרה של מגבלת מכסה).
                </span>
              </span>
            </label>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">מנוע אינדוקס חיפוש (768 ממדים)</label>
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

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={savingAi}
              onClick={saveAiSettings}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
            >
              {savingAi ? "שומר..." : "שמור הגדרות פענוח"}
            </button>
            {saveNotice && <span className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">{saveNotice}</span>}
          </div>
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
            <div className="font-semibold">ניקוי תמונות שפג תוקפן (מעל 30 יום)</div>
            <div className="text-xs text-[var(--otzar-text-muted)]">
              צילומי ספרים מאושרים וסל מחזור נשמרים אוטומטית ל-30 יום לצורך עריכה חוזרת בבינה ושחזור. הניקוי מסיר רק קבצים שפג תוקפם או יתומים.
            </div>
          </div>
          <button
            type="button"
            disabled={cleaning}
            onClick={handleCleanupImages}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold border border-red-300 text-red-700 hover:bg-red-50 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {cleaning ? "מנקה..." : "נקה תמונות שפג תוקפן"}
          </button>
        </div>

        {cleanupMsg && <div className="text-xs p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800">{cleanupMsg}</div>}
      </div>
    </div>
  );
};
