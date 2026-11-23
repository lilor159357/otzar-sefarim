import React, { useEffect, useState } from "react";
import { RefreshCw, CheckCircle2, AlertCircle, DownloadCloud, GitBranch, ShieldCheck } from "lucide-react";

interface UpdateCommit {
  hash: string;
  message: string;
  date: string;
}

interface UpdaterStatus {
  version: string;
  gitAvailable: boolean;
  repoInitialized: boolean;
  branch: string;
  localHash: string;
  lastCommitMessage: string;
  lastCommitDate: string;
  remoteUrl: string;
  dirtyFiles: number;
  autoCheck: boolean;
  autoInstall: boolean;
  updateInProgress: boolean;
  lastCheck: {
    checkedAt: string | null;
    hasUpdate: boolean;
    behindCount: number;
    aheadCount: number;
    localHash: string;
    remoteHash: string;
    latestCommits: UpdateCommit[];
    error: string | null;
  };
}

interface UpdaterPanelProps {
  onUpdateStatusChange?: (behindCount: number) => void;
}

export const UpdaterPanel: React.FC<UpdaterPanelProps> = ({ onUpdateStatusChange }) => {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [remoteInput, setRemoteInput] = useState("");
  const [autoCheck, setAutoCheck] = useState(true);
  const [autoInstall, setAutoInstall] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [applying, setApplying] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);

  const loadStatus = async () => {
    try {
      const res = await fetch("/api/updater/status");
      if (!res.ok) return;
      const data: UpdaterStatus = await res.json();
      setStatus(data);
      setRemoteInput(data.remoteUrl || "");
      setAutoCheck(Boolean(data.autoCheck));
      setAutoInstall(Boolean(data.autoInstall));
      onUpdateStatusChange?.(data.lastCheck?.behindCount || 0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const handleSaveConfig = async (nextAutoCheck = autoCheck, nextAutoInstall = autoInstall) => {
    setSavingConfig(true);
    setMsg(null);
    try {
      const res = await fetch("/api/updater/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteUrl: remoteInput.trim(),
          autoCheck: nextAutoCheck,
          autoInstall: nextAutoInstall,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ type: "err", text: data.error || "שגיאה בשמירת הגדרות עדכון" });
        return;
      }
      await loadStatus();
      setMsg({ type: "ok", text: "הגדרות העדכון והחיבור נשמרו בהצלחה." });
    } catch {
      setMsg({ type: "err", text: "שגיאת תקשורת מול השרת המקומי" });
    } finally {
      setSavingConfig(false);
    }
  };

  const handleCheckNow = async () => {
    setChecking(true);
    setMsg(null);
    try {
      const res = await fetch("/api/updater/check", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ type: "err", text: data.error || "שגיאה בבדיקת עדכונים" });
        return;
      }
      await loadStatus();
      if (data.lastCheck?.error) {
        setMsg({ type: "err", text: data.lastCheck.error });
      } else if (data.lastCheck?.hasUpdate) {
        setMsg({ type: "info", text: `נמצא עדכון חדש (${data.lastCheck.behindCount} שינויים ממתינים להתקנה).` });
      } else {
        setMsg({ type: "ok", text: "התוכנה מעודכנת לגרסה האחרונה." });
      }
    } catch {
      setMsg({ type: "err", text: "שגיאת תקשורת בבדיקת העדכונים" });
    } finally {
      setChecking(false);
    }
  };

  const waitForServerRestartAndReload = () => {
    let attempts = 0;
    const timer = window.setInterval(async () => {
      attempts++;
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (res.ok) {
          window.clearInterval(timer);
          window.location.reload();
        }
      } catch {
        // server is still restarting
      }
      if (attempts >= 30) {
        window.clearInterval(timer);
        setApplying(false);
        setMsg({ type: "info", text: "העדכון הושלם. רענן את החלון ידנית אם הדף לא נטען." });
      }
    }, 1000);
  };

  const handleApplyUpdate = async () => {
    setApplying(true);
    setMsg({ type: "info", text: "מגבה מסד נתונים, מוריד עדכון ובונה את הממשק... נא להמתין." });
    try {
      const res = await fetch("/api/updater/apply", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setApplying(false);
        setMsg({ type: "err", text: data.error || "שגיאה בהתקנת העדכון" });
        return;
      }
      setMsg({ type: "ok", text: "העדכון הותקן והנתונים גובו! מפעיל מחדש את התוכנה..." });
      if (data.restarting) {
        window.setTimeout(waitForServerRestartAndReload, 1800);
      } else {
        await loadStatus();
        setApplying(false);
      }
    } catch {
      setApplying(false);
      setMsg({ type: "err", text: "שגיאה בהתקנת העדכון" });
    }
  };

  if (loading) {
    return (
      <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] text-sm text-[var(--otzar-text-muted)]">
        טוען פרטי גרסה ועדכונים...
      </div>
    );
  }

  const hasUpdate = Boolean(status?.lastCheck?.hasUpdate);
  const behindCount = status?.lastCheck?.behindCount || 0;

  return (
    <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold text-base">
          <RefreshCw className="w-4 h-4 text-[var(--otzar-accent)]" />
          <span>עדכוני תוכנה אוטומטיים וחיבור ל-GitHub</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--otzar-text-muted)]">
          <span className="px-2.5 py-1 rounded-md bg-[var(--otzar-surface)] border border-[var(--otzar-border-muted)] font-mono">
            גרסה {status?.version || "1.0.0"}
            {status?.localHash ? ` (${status.localHash})` : ""}
          </span>
          {status?.branch && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--otzar-border-muted)] font-mono">
              <GitBranch className="w-3 h-3" />
              {status.branch}
            </span>
          )}
        </div>
      </div>

      {!status?.gitAvailable && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-700 dark:text-amber-300">
          לא זוהה Git מותקן במחשב זה. יש להתקין Git כדי לאפשר בדיקה ועדכון אוטומטי מ-GitHub.
        </div>
      )}

      <div className="space-y-2 text-sm">
        <label className="block text-xs font-medium">כתובת מאגר GitHub לעדכונים (Repository URL)</label>
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            dir="ltr"
            value={remoteInput}
            onChange={(e) => setRemoteInput(e.target.value)}
            placeholder="https://github.com/username/otzar-sefarim.git"
            className="flex-1 min-w-[260px] px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs"
          />
          <button
            type="button"
            disabled={savingConfig || applying}
            onClick={() => handleSaveConfig()}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] cursor-pointer disabled:opacity-50"
          >
            {savingConfig ? "שומר..." : "שמור חיבור"}
          </button>
        </div>
        <p className="text-xs text-[var(--otzar-text-muted)] flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
          <span>מסד הנתונים (otzar.db), קוד ה-PIN ומפתחות ה-API מוגנים לחלוטין ואינם מושפעים בעדכון (בנוסף נשמר גיבוי אוטומטי לפני כל עדכון).</span>
        </p>
      </div>

      <div className="space-y-2 pt-1 text-sm">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoCheck}
            onChange={(e) => {
              const next = e.target.checked;
              setAutoCheck(next);
              void handleSaveConfig(next, autoInstall);
            }}
            className="accent-[var(--otzar-accent)] w-4 h-4"
          />
          <span>בדוק עדכונים אוטומטית בהפעלת התוכנה (כשיש אינטרנט)</span>
        </label>

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoInstall}
            onChange={(e) => {
              const next = e.target.checked;
              setAutoInstall(next);
              void handleSaveConfig(autoCheck, next);
            }}
            className="accent-[var(--otzar-accent)] w-4 h-4"
          />
          <span>הורד והתקן עדכונים אוטומטית בהפעלה כשנמצאת גרסה חדשה</span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 pt-1">
        <button
          type="button"
          disabled={checking || applying || !status?.remoteUrl}
          onClick={handleCheckNow}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${checking ? "animate-spin" : ""}`} />
          {checking ? "בודק עדכונים..." : "בדוק עדכונים כעת"}
        </button>

        {hasUpdate && (
          <button
            type="button"
            disabled={applying}
            onClick={handleApplyUpdate}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-50"
          >
            <DownloadCloud className="w-4 h-4" />
            {applying ? "מתקין ומפעיל מחדש..." : `עדכן כעת והפעל מחדש (${behindCount})`}
          </button>
        )}
      </div>

      {hasUpdate && status?.lastCheck?.latestCommits && status.lastCheck.latestCommits.length > 0 && (
        <div className="p-3 rounded-lg bg-[var(--otzar-surface)] border border-[var(--otzar-border-muted)] space-y-1.5 text-xs">
          <div className="font-semibold">שינויים בגרסה החדשה:</div>
          <ul className="space-y-1 list-disc list-inside text-[var(--otzar-text-muted)]">
            {status.lastCheck.latestCommits.map((c) => (
              <li key={c.hash}>
                <span className="font-mono text-[var(--otzar-text)]">{c.hash}</span> — {c.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {msg && (
        <div
          className={`flex items-center gap-2 p-2.5 rounded-lg text-xs font-medium border ${
            msg.type === "err"
              ? "bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400"
              : msg.type === "ok"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
              : "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300"
          }`}
        >
          {msg.type === "err" ? (
            <AlertCircle className="w-4 h-4 shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          )}
          <span>{msg.text}</span>
        </div>
      )}
    </div>
  );
};
