import React, { useEffect, useState } from "react";
import {
  Cloud,
  CloudOff,
  RefreshCw,
  UploadCloud,
  CheckCircle2,
  AlertTriangle,
  Eye,
  EyeOff,
  Copy,
  Check,
  BookOpen,
  Smartphone,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import type { FirebaseSyncStatus } from "../types.ts";
import { MobileQrPairingBox } from "./MobileQrPairingBox.tsx";

interface FirebaseSyncPanelProps {
  onReload: () => Promise<void>;
}

function tryExtractConfigSnippet(raw: string): Record<string, string> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const p = JSON.parse(trimmed);
    if (p && typeof p === "object") return p;
  } catch {}
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    const snippet = trimmed
      .slice(braceStart, braceEnd + 1)
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
      .replace(/,\s*([}\]])/g, "$1");
    try {
      const p = JSON.parse(snippet);
      if (p && typeof p === "object") return p;
    } catch {}
  }
  return null;
}

export const FirebaseSyncPanel: React.FC<FirebaseSyncPanelProps> = ({ onReload }) => {
  const [status, setStatus] = useState<FirebaseSyncStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [enabled, setEnabled] = useState(false);
  const [syncEmbeddings, setSyncEmbeddings] = useState(true);
  const [snippetInput, setSnippetInput] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [authDomain, setAuthDomain] = useState("");
  const [projectId, setProjectId] = useState("");
  const [appId, setAppId] = useState("");
  const [messagingSenderId, setMessagingSenderId] = useState("");
  const [storageBucket, setStorageBucket] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [createUserIfMissing, setCreateUserIfMissing] = useState(false);

  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [testingRelay, setTestingRelay] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const [showGuide, setShowGuide] = useState(false);
  const [rulesText, setRulesText] = useState("");
  const [copiedRules, setCopiedRules] = useState(false);

  const loadStatus = async (hydrateForm = false) => {
    try {
      const res = await fetch("/api/sync/status");
      if (!res.ok) return;
      const data: FirebaseSyncStatus = await res.json();
      setStatus(data);
      if (hydrateForm) {
        setEnabled(data.enabled);
        setSyncEmbeddings(data.syncEmbeddings);
        if (data.config) {
          setApiKey(data.config.apiKey || "");
          setAuthDomain(data.config.authDomain || "");
          setProjectId(data.config.projectId || "");
          setAppId(data.config.appId || "");
          setMessagingSenderId(data.config.messagingSenderId || "");
          setStorageBucket(data.config.storageBucket || "");
        }
        if (data.email) setEmail(data.email);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus(true);
    const t = setInterval(() => {
      void loadStatus(false);
    }, 6000);
    return () => clearInterval(t);
  }, []);

  const handleSnippetPaste = (val: string) => {
    setSnippetInput(val);
    const parsed = tryExtractConfigSnippet(val);
    if (parsed) {
      if (parsed.apiKey) setApiKey(String(parsed.apiKey));
      if (parsed.authDomain) setAuthDomain(String(parsed.authDomain));
      if (parsed.projectId) setProjectId(String(parsed.projectId));
      if (parsed.appId) setAppId(String(parsed.appId));
      if (parsed.messagingSenderId) setMessagingSenderId(String(parsed.messagingSenderId));
      if (parsed.storageBucket) setStorageBucket(String(parsed.storageBucket));
    }
  };

  const handleSaveAndConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      const configObj = {
        apiKey: apiKey.trim(),
        authDomain: authDomain.trim() || (projectId.trim() ? `${projectId.trim()}.firebaseapp.com` : ""),
        projectId: projectId.trim(),
        storageBucket: storageBucket.trim() || undefined,
        messagingSenderId: messagingSenderId.trim() || undefined,
        appId: appId.trim(),
      };
      const res = await fetch("/api/sync/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          syncEmbeddings,
          configInput: configObj,
          email: email.trim(),
          password: password || undefined,
          createUserIfMissing,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בשמירת הגדרות הענן");
      if (data.status) setStatus(data.status);
      setPassword("");
      setNotice({ ok: Boolean(data.ok), text: data.message || "הגדרות Firebase נשמרו" });
      await onReload();
    } catch (err: any) {
      setNotice({ ok: false, text: err?.message || "שגיאה בחיבור ל-Firebase" });
    } finally {
      setSaving(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setNotice(null);
    try {
      const res = await fetch("/api/sync/run", { method: "POST" });
      const data = await res.json();
      if (data.status) setStatus(data.status);
      if (!res.ok) throw new Error(data.error || "שגיאה בסנכרון");
      setNotice({
        ok: true,
        text: `הסנכרון הושלם: נשלחו ${data.pushed ?? 0} שינויים, נמשכו ${data.pulled ?? 0} עדכונים מהענן.`,
      });
      await onReload();
    } catch (err: any) {
      setNotice({ ok: false, text: err?.message || "שגיאה בסנכרון" });
    } finally {
      setSyncing(false);
    }
  };

  const handleSeedAll = async () => {
    setSeeding(true);
    setNotice(null);
    try {
      const res = await fetch("/api/sync/seed", { method: "POST" });
      const data = await res.json();
      if (data.status) setStatus(data.status);
      if (!res.ok) throw new Error(data.error || "שגיאה בהעלאה הראשונית");
      setNotice({
        ok: true,
        text: `העלאת המאגר הושלמה: ${data.pushed ?? 0} רשומות סונכרנו לענן (ארונות, ספרים, שואלים והשאלות).`,
      });
      await onReload();
    } catch (err: any) {
      setNotice({ ok: false, text: err?.message || "שגיאה בהעלאת המאגר" });
    } finally {
      setSeeding(false);
    }
  };

  const handleRelayTest = async () => {
    setTestingRelay(true);
    setNotice(null);
    try {
      const res = await fetch("/api/sync/test-relay", { method: "POST" });
      const data = await res.json();
      if (data.status) setStatus(data.status);
      if (!res.ok) throw new Error(data.error || "שגיאה בבדיקת תור הנייד");
      setNotice({
        ok: true,
        text: `בדיקת ה-Relay הצליחה! תמונת ניסוי נקלטה לתור האישור המקומי (#${data.localQueueId}) ונמחקה אוטומטית מהענן.`,
      });
      await onReload();
    } catch (err: any) {
      setNotice({ ok: false, text: err?.message || "בדיקת ה-Relay נכשלה" });
    } finally {
      setTestingRelay(false);
    }
  };

  const openGuide = async () => {
    const next = !showGuide;
    setShowGuide(next);
    if (next && !rulesText) {
      try {
        const res = await fetch("/api/sync/rules");
        if (res.ok) {
          const data = await res.json();
          setRulesText(data.rulesText || "");
        }
      } catch {}
    }
  };

  const copyRules = async () => {
    if (!rulesText) return;
    try {
      await navigator.clipboard.writeText(rulesText);
      setCopiedRules(true);
      setTimeout(() => setCopiedRules(false), 2000);
    } catch {}
  };

  const spark = status?.spark;
  const readsPct = spark ? Math.min(100, Math.round((spark.reads / spark.limits.reads) * 100)) : 0;
  const writesPct = spark ? Math.min(100, Math.round((spark.writes / spark.limits.writes) * 100)) : 0;
  const deletesPct = spark ? Math.min(100, Math.round((spark.deletes / spark.limits.deletes) * 100)) : 0;

  return (
    <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold text-base">
          {status?.connected ? (
            <Cloud className="w-4 h-4 text-emerald-600" />
          ) : (
            <CloudOff className="w-4 h-4 text-[var(--otzar-accent)]" />
          )}
          <span>סנכרון ענן ונייד (Firebase Firestore · אופליין-פירסט)</span>
        </div>

        <div className="flex items-center gap-2 text-xs">
          {loading ? (
            <span className="text-[var(--otzar-text-muted)]">טוען...</span>
          ) : status?.connected ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-400">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              מחובר ומאזין בזמן אמת ({status.projectId})
            </span>
          ) : status?.enabled && status?.offline ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              מצב אופליין — שינויים נשמרים בתור מקומי
            </span>
          ) : status?.enabled ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-red-600">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              לא מחובר
            </span>
          ) : (
            <span className="text-[var(--otzar-text-muted)]">כבוי (עבודה מקומית בלבד)</span>
          )}
        </div>
      </div>

      {/* Live Status & Spark Plan Usage Counters */}
      {status && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="p-3.5 rounded-lg bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] space-y-1.5">
            <div className="font-semibold text-[var(--otzar-text)]">מצב תור מקומי וסנכרון</div>
            <div className="flex justify-between tabular-nums">
              <span className="text-[var(--otzar-text-muted)]">שינויים ממתינים להעלאה (Outbox):</span>
              <span className="font-semibold">{status.pendingOutboxCount}</span>
            </div>
            <div className="flex justify-between tabular-nums">
              <span className="text-[var(--otzar-text-muted)]">תמונות שהתקבלו מהנייד לאישור:</span>
              <span className="font-semibold text-[var(--otzar-accent)]">{status.pendingRelayLocalCount}</span>
            </div>
            <div className="flex justify-between tabular-nums">
              <span className="text-[var(--otzar-text-muted)]">ספרים מהנייד ממתינים לברקוד רשמי:</span>
              <span className="font-semibold">{status.pendingBarcodeBooksCount}</span>
            </div>
            <div className="flex justify-between tabular-nums">
              <span className="text-[var(--otzar-text-muted)]">סנכרון אחרון:</span>
              <span>
                {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString("he-IL") : "טרם בוצע"}
              </span>
            </div>
          </div>

          {spark && (
            <div className="p-3.5 rounded-lg bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[var(--otzar-text)]">ניצול תוכנית חינם היום (Spark Plan)</span>
                <span className="font-mono text-[11px] text-[var(--otzar-text-muted)]">{spark.date}</span>
              </div>
              <div className="space-y-1 tabular-nums">
                <div className="flex justify-between">
                  <span className="text-[var(--otzar-text-muted)]">קריאות (Reads):</span>
                  <span>{spark.reads.toLocaleString()} / {spark.limits.reads.toLocaleString()} ({readsPct}%)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--otzar-text-muted)]">כתיבות (Writes):</span>
                  <span>{spark.writes.toLocaleString()} / {spark.limits.writes.toLocaleString()} ({writesPct}%)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--otzar-text-muted)]">מחיקות (Deletes · כולל ניקוי תמונות):</span>
                  <span>{spark.deletes.toLocaleString()} / {spark.limits.deletes.toLocaleString()} ({deletesPct}%)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--otzar-text-muted)]">סה״כ תמונות שנקלטו מהנייד ונמחקו מהענן:</span>
                  <span className="font-semibold text-emerald-700 dark:text-emerald-400">{spark.relayProcessed}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {status?.lastError && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{status.lastError}</span>
        </div>
      )}

      {notice && (
        <div
          className={`flex items-start gap-2 p-3 rounded-lg border text-xs font-medium ${
            notice.ok
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "border-red-300 bg-red-50 text-red-800"
          }`}
        >
          {notice.ok ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
          <span>{notice.text}</span>
        </div>
      )}

      {/* Action Buttons when configured */}
      {status?.configured && (
        <div className="flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            disabled={syncing || !enabled}
            onClick={handleSyncNow}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] disabled:opacity-50 cursor-pointer"
          >
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            סנכרן עכשיו (Delta Sync)
          </button>
          <button
            type="button"
            disabled={seeding || !enabled}
            onClick={handleSeedAll}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] disabled:opacity-50 cursor-pointer"
          >
            {seeding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />}
            {status.initialSeedDone ? "סנכרן והעלה כל המאגר לענן" : "העלאה ראשונית של כל המאגר לענן"}
          </button>
          <button
            type="button"
            disabled={testingRelay || !status.connected}
            onClick={handleRelayTest}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] disabled:opacity-50 cursor-pointer"
          >
            {testingRelay ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Smartphone className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />}
            בדוק קליטת תמונת ניסוי ומחיקה מהענן
          </button>
        </div>
      )}

      {/* Configuration Form */}
      <form onSubmit={handleSaveAndConnect} className="space-y-4 pt-2 border-t border-[var(--otzar-border-muted)] text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold text-sm">הגדרות חיבור לפרויקט Firebase</div>
          <button
            type="button"
            onClick={openGuide}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--otzar-accent)] hover:underline cursor-pointer"
          >
            <BookOpen className="w-3.5 h-3.5" />
            {showGuide ? "הסתר מדריך הקמה" : "מדריך שלב-אחר-שלב להקמת Firebase וכללי אבטחה"}
          </button>
        </div>

        {/* Collapsible Setup Guide */}
        {showGuide && (
          <div className="p-4 rounded-lg bg-[var(--otzar-surface)] border border-[var(--otzar-border)] space-y-3 text-xs leading-relaxed">
            <div className="font-semibold text-sm flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-[var(--otzar-accent)]" />
              <span>הקמת ענן חינמי ב-Firebase (תוכנית Spark, ללא כרטיס אשראי)</span>
            </div>
            <ol className="list-decimal list-inside space-y-1.5 text-[var(--otzar-text)]">
              <li>
                היכנס אל <span className="font-mono" dir="ltr">console.firebase.google.com</span> וצור פרויקט חדש (או בחר פרויקט קיים) בתוכנית החינמית <strong>Spark Plan</strong>.
              </li>
              <li>
                בתפריט הצד: לחץ על <strong>Build → Firestore Database</strong> ← <strong>Create database</strong> ← בחר אזור קרוב (למשל <span className="font-mono" dir="ltr">eur3</span> או <span className="font-mono" dir="ltr">europe-west1</span>) והתחל במצב Production.
              </li>
              <li>
                בתפריט הצד: לחץ על <strong>Build → Authentication</strong> ← <strong>Get started</strong> ← הפעל את שיטת ההתחברות <strong>Email/Password</strong> (ואת מתג <em>Email link</em> השאר כבוי). תוכל להקים את משתמש המנהל ב-Users או לסמן למטה &quot;צור משתמש מנהל חדש בפרויקט&quot;.
              </li>
              <li>
                בלשונית <strong>Rules</strong> של Firestore Database: הדבק את כללי האבטחה המוקשחים (מאפשרים גישה למשתמש המנהל המאומת בלבד ומגבילים את תור התמונות) ולחץ <strong>Publish</strong>:
                <div className="mt-2 space-y-1.5">
                  <button
                    type="button"
                    onClick={copyRules}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--otzar-border)] bg-[var(--otzar-bg)] font-medium hover:bg-[var(--otzar-surface-alt)] cursor-pointer"
                  >
                    {copiedRules ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />}
                    {copiedRules ? "הכללים הועתקו!" : "העתק כללי אבטחה (firestore.rules)"}
                  </button>
                  {rulesText && (
                    <pre
                      dir="ltr"
                      className="p-2.5 rounded-md bg-[var(--otzar-bg)] border border-[var(--otzar-border-muted)] font-mono text-[11px] overflow-x-auto max-h-44"
                    >
                      {rulesText}
                    </pre>
                  )}
                </div>
              </li>
              <li>
                בהגדרות הפרויקט (גלגל שיניים → <strong>Project settings</strong>) הוסף אפליקציית <strong>Web (&lt;/&gt;)</strong>, העתק את אובייקט ה-<span className="font-mono" dir="ltr">firebaseConfig</span> והדבק אותו בתיבה מטה.
              </li>
            </ol>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium mb-1">
            הדבקה מהירה של <span className="font-mono" dir="ltr">firebaseConfig</span> (אופציונלי — ממלא את השדות אוטומטית)
          </label>
          <textarea
            rows={2}
            dir="ltr"
            value={snippetInput}
            onChange={(e) => handleSnippetPaste(e.target.value)}
            placeholder={'const firebaseConfig = { apiKey: "...", authDomain: "...", projectId: "...", appId: "..." };'}
            className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">Project ID *</label>
            <input
              type="text"
              dir="ltr"
              required
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="otzar-library-12345"
              className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">API Key *</label>
            <input
              type="text"
              dir="ltr"
              required
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="AIzaSy..."
              className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">App ID *</label>
            <input
              type="text"
              dir="ltr"
              required
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder="1:123456:web:abcdef"
              className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Auth Domain</label>
            <input
              type="text"
              dir="ltr"
              value={authDomain}
              onChange={(e) => setAuthDomain(e.target.value)}
              placeholder={projectId ? `${projectId}.firebaseapp.com` : "project.firebaseapp.com"}
              className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">אימייל משתמש מנהל (Firebase Auth) *</label>
            <input
              type="email"
              dir="ltr"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@yeshiva.org"
              className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">
              סיסמה {status?.hasPassword ? "(שמורה במערכת — השאר ריק אם לא משתנה)" : "*"}
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                dir="ltr"
                required={!status?.hasPassword}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={status?.hasPassword ? "••••••••" : "לפחות 6 תווים"}
                className="w-full px-3 py-2 pl-9 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--otzar-text-muted)] cursor-pointer"
                title={showPassword ? "הסתר" : "הצג"}
              >
                {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-2 text-xs">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded border-[var(--otzar-border-muted)]"
            />
            <span>הפעל סנכרון דו-כיווני אוטומטי והאזנה חיה לתמונות מהנייד</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={syncEmbeddings}
              onChange={(e) => setSyncEmbeddings(e.target.checked)}
              className="rounded border-[var(--otzar-border-muted)]"
            />
            <span>סנכרן גם וקטורי חיפוש סמנטי (768 ממדים, בעדכונים בלבד)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={createUserIfMissing}
              onChange={(e) => setCreateUserIfMissing(e.target.checked)}
              className="rounded border-[var(--otzar-border-muted)]"
            />
            <span>צור את משתמש המנהל ב-Firebase Auth אוטומטית אם עדיין לא נוצר</span>
          </label>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] disabled:opacity-50 cursor-pointer"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}
          {saving ? "מאמת ומתחבר..." : "שמור הגדרות, אמת והתחבר לענן"}
        </button>
      </form>

      <MobileQrPairingBox />
    </div>
  );
};