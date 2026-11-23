import React, { useEffect, useState } from "react";
import {
  BookOpen,
  Search,
  ArrowLeftRight,
  PlusSquare,
  Printer,
  Settings,
  Maximize2,
  Minimize2,
  Database,
  Lock,
  ShieldCheck,
  Download,
  HardDrive,
  KeyRound,
  FileSpreadsheet,
  RefreshCw,
} from "lucide-react";
import type { BookRow, CabinetRow, HealthData, ModuleKey } from "./types.ts";
import { SearchModule } from "./components/SearchModule.tsx";
import { MapEditorModule } from "./components/MapEditorModule.tsx";
import { CirculationModule } from "./components/CirculationModule.tsx";
import { CatalogModule } from "./components/CatalogModule.tsx";
import { AiSettingsPanel } from "./components/AiSettingsPanel.tsx";
import { UpdaterPanel } from "./components/UpdaterPanel.tsx";
import { LabelsModule } from "./components/LabelsModule.tsx";
import { AdminPinModal } from "./components/AdminPinModal.tsx";
import { installFetchAdminInterceptor, setAdminToken } from "./lib/adminSession.ts";

installFetchAdminInterceptor();

const NAV_ITEMS: Array<{ key: ModuleKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: "search", label: "חיפוש ואיתור", icon: Search },
  { key: "circulation", label: "השאלה והחזרה", icon: ArrowLeftRight },
  { key: "catalog", label: "קטלוג ו-AI", icon: PlusSquare },
  { key: "labels", label: "הדפסת מדבקות", icon: Printer },
  { key: "admin", label: "מפה והגדרות", icon: Settings },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<ModuleKey>("search");
  const [adminSubTab, setAdminSubTab] = useState<"map" | "settings">("map");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [books, setBooks] = useState<BookRow[]>([]);
  const [cabinets, setCabinets] = useState<CabinetRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [semanticMode, setSemanticMode] = useState(false);
  const [semanticNotice, setSemanticNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [newPin, setNewPin] = useState("");
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [updateBehindCount, setUpdateBehindCount] = useState(0);
  const [dismissUpdateBanner, setDismissUpdateBanner] = useState(false);

  const applyTheme = (preset: string, mode: string) => {
    const root = document.documentElement;
    root.setAttribute("data-theme", preset);
    if (mode === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  };

  const loadAll = async (q = searchQuery, st = statusFilter, cat = categoryFilter, sem = semanticMode) => {
    try {
      setErrorMsg(null);
      const params = new URLSearchParams({ q, status: st, category: cat });
      if (sem && q.trim().length >= 2) {
        params.set("semantic", "1");
      }
      const [hRes, sRes, bRes, cRes] = await Promise.all([
        fetch("/api/health"),
        fetch("/api/settings"),
        fetch("/api/books?" + params.toString()),
        fetch("/api/cabinets"),
      ]);
      if (!hRes.ok || !bRes.ok) throw new Error("שגיאה בטעינת נתונים מהשרת המקומי");
      const semHeader = bRes.headers.get("X-Semantic-Status");
      if (sem && q.trim().length >= 2) {
        if (semHeader === "used") {
          setSemanticNotice("חיפוש מורחב לפי הקשר ומשמעות פעיל.");
        } else if (semHeader === "fallback:no_key") {
          setSemanticNotice("שירות החיפוש המורחב אינו מוגדר — מוצגות תוצאות החיפוש התורני המקומי.");
        } else if (semHeader === "fallback:no_vectors") {
          setSemanticNotice("טרם בוצע עדכון אינדקס חיפוש בהגדרות — מוצגות תוצאות החיפוש המקומי.");
        } else if (semHeader === "fallback:offline") {
          setSemanticNotice("אין חיבור רשת כעת — מוצגות תוצאות החיפוש המקומי.");
        } else {
          setSemanticNotice(null);
        }
      } else {
        setSemanticNotice(null);
      }
      const [hData, sData, bData, cData] = await Promise.all([
        hRes.json(),
        sRes.json(),
        bRes.json(),
        cRes.json(),
      ]);
      setHealth(hData);
      setSettings(sData);
      setBooks(bData);
      setCabinets(cData);
      applyTheme(sData.theme_preset || "otzar-orange", sData.theme_mode || "light");
    } catch (err: any) {
      setErrorMsg(err?.message || "כשל בחיבור למסד הנתונים המקומי");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/status");
        const data = await res.json();
        const adminActive = Boolean(data?.isAdmin);
        if (!adminActive) setAdminToken("");
        setIsAdmin(adminActive);
      } catch {
        setIsAdmin(false);
      } finally {
        loadAll("", "all", "all");
      }
    })();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === "KeyA" || e.key.toLowerCase() === "a")) {
        if (!isAdmin) {
          e.preventDefault();
          setShowPinModal(true);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) {
      setUpdateBehindCount(0);
      return;
    }
    fetch("/api/updater/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.lastCheck?.behindCount > 0) {
          setUpdateBehindCount(Number(d.lastCheck.behindCount) || 0);
        }
      })
      .catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {}
  };

  const updateThemeSetting = async (preset: string, mode: string) => {
    applyTheme(preset, mode);
    setSettings((prev) => ({ ...prev, theme_preset: preset, theme_mode: mode }));
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme_preset: preset, theme_mode: mode }),
    });
  };

  const visibleNavItems = isAdmin
    ? NAV_ITEMS
    : NAV_ITEMS.filter((n) => n.key === "search" || n.key === "circulation");

  const effectiveTab: ModuleKey =
    !isAdmin && activeTab !== "search" && activeTab !== "circulation"
      ? "search"
      : activeTab;

  const activeNavLabel = visibleNavItems.find((n) => n.key === effectiveTab)?.label || "";

  const handleAdminLogout = async () => {
    try {
      await fetch("/api/admin/logout", { method: "POST" });
    } catch {}
    setAdminToken("");
    setIsAdmin(false);
    setActiveTab("search");
    await loadAll(searchQuery, statusFilter, categoryFilter, semanticMode);
  };

  const downloadWithAuth = async (url: string, fallbackName: string) => {
    try {
      setBackupMsg(null);
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "שגיאה בהורדת הקובץ");
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 2000);
    } catch (e: any) {
      setBackupMsg(e?.message || "שגיאה בייצוא הנתונים");
    }
  };

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-[var(--otzar-bg)] text-[var(--otzar-text)]">
      {/* Top 3-zone header */}
      <header className="h-14 border-b border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] px-6 flex items-center justify-between gap-8 shrink-0">
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <BookOpen className="w-5 h-5 text-[var(--otzar-accent)]" />
          <span className="font-bold text-lg tracking-tight">
            {settings.library_name || "אוצר ספרים"}
          </span>
        </div>

        <div className="text-sm font-medium text-[var(--otzar-text-muted)] whitespace-nowrap truncate">
          {activeNavLabel}
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {isAdmin && (
            <>
              <span className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--otzar-surface)] text-[var(--otzar-accent)] border border-[var(--otzar-border)] whitespace-nowrap">
                <ShieldCheck className="w-3.5 h-3.5" />
                מצב מנהל
              </span>
              <button
                type="button"
                onClick={handleAdminLogout}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] text-[var(--otzar-text)] whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                נעל לעמדת משתמש
              </button>
            </>
          )}
          <button
            type="button"
            onClick={toggleFullscreen}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            {isFullscreen ? "יציאה ממסך מלא" : "מצב עמדה (מסך מלא)"}
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* RTL Sidebar */}
        <aside className="w-60 border-l border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] p-3.5 flex flex-col justify-between overflow-y-auto shrink-0">
          <nav className="space-y-1">
            {visibleNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = effectiveTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    isActive
                      ? "bg-[var(--otzar-accent)] text-white"
                      : "text-[var(--otzar-text)] hover:bg-[var(--otzar-surface)]"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Footer: DB Summary for Admin, Subtle Lock Button for Regular Users */}
          {isAdmin ? (
            <div className="border-t border-[var(--otzar-border-muted)] pt-4 space-y-2 text-xs text-[var(--otzar-text-muted)]">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-medium text-[var(--otzar-text)]">
                  <Database className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />
                  מאגר הספרייה
                </span>
                <span className="tabular-nums font-medium text-emerald-700 dark:text-emerald-400">{health?.ok ? "פעיל" : "..."}</span>
              </div>
              <div className="flex justify-between tabular-nums">
                <span>ספרים במאגר:</span>
                <span className="font-semibold text-[var(--otzar-text)]">{health?.counts.books ?? 0}</span>
              </div>
              <div className="flex justify-between tabular-nums">
                <span>ארונות:</span>
                <span className="font-semibold text-[var(--otzar-text)]">{health?.counts.cabinets ?? 0}</span>
              </div>
              <div className="flex justify-between tabular-nums">
                <span>מושאלים כעת:</span>
                <span className="font-semibold text-[var(--otzar-text)]">{health?.counts.activeLoans ?? 0}</span>
              </div>
              <div className="flex justify-between tabular-nums">
                <span>ממתינים למדבקה:</span>
                <span className="font-semibold text-[var(--otzar-accent)]">{health?.counts.printQueue ?? 0}</span>
              </div>
            </div>
          ) : (
            <div className="border-t border-[var(--otzar-border-muted)] pt-3">
              <button
                type="button"
                onClick={() => setShowPinModal(true)}
                title="כניסת מנהל (Ctrl+Shift+A)"
                className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] hover:bg-[var(--otzar-surface)] transition-colors cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>כניסת מנהל</span>
              </button>
            </div>
          )}
        </aside>

        {/* Main Workspace */}
        <main className="flex-1 min-w-0 overflow-y-auto p-6 space-y-6">
          {errorMsg && (
            <div className="p-3.5 rounded-lg border border-red-300 bg-red-50 text-red-800 text-sm">
              {errorMsg}
            </div>
          )}

          {isAdmin && updateBehindCount > 0 && !dismissUpdateBanner && !(effectiveTab === "admin" && adminSubTab === "settings") && (
            <div className="p-3 rounded-xl border border-[var(--otzar-accent)]/40 bg-[var(--otzar-surface)] flex flex-wrap items-center justify-between gap-2 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <RefreshCw className="w-4 h-4 text-[var(--otzar-accent)]" />
                <span>קיים עדכון תוכנה חדש מ-GitHub ({updateBehindCount} שינויים ממתינים).</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab("admin");
                    setAdminSubTab("settings");
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                >
                  פתח עדכונים
                </button>
                <button
                  type="button"
                  onClick={() => setDismissUpdateBanner(true)}
                  className="px-2.5 py-1.5 rounded-lg text-xs text-[var(--otzar-text-muted)] hover:bg-[var(--otzar-bg)] cursor-pointer"
                >
                  הסתר
                </button>
              </div>
            </div>
          )}

          {effectiveTab === "search" && (
            <SearchModule
              books={books}
              cabinets={cabinets}
              entrance={settings.map_entrance}
              loading={loading}
              searchQuery={searchQuery}
              onSearchChange={(q) => {
                setSearchQuery(q);
                loadAll(q, statusFilter, categoryFilter, semanticMode);
              }}
              statusFilter={statusFilter}
              onStatusFilterChange={(st) => {
                setStatusFilter(st);
                loadAll(searchQuery, statusFilter ? st : st, categoryFilter, semanticMode);
              }}
              categoryFilter={categoryFilter}
              onCategoryFilterChange={(cat) => {
                setCategoryFilter(cat);
                loadAll(searchQuery, statusFilter, cat, semanticMode);
              }}
              semanticMode={semanticMode}
              onSemanticModeChange={(v) => {
                setSemanticMode(v);
                loadAll(searchQuery, statusFilter, categoryFilter, v);
              }}
              semanticNotice={semanticNotice}
              isAdmin={isAdmin}
              onReload={() => loadAll(searchQuery, statusFilter, categoryFilter, semanticMode)}
            />
          )}

          {isAdmin && effectiveTab === "admin" && (
            <div className="space-y-6 max-w-6xl">
              <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] w-fit">
                <button
                  type="button"
                  onClick={() => setAdminSubTab("map")}
                  className={`px-4 py-1.5 rounded-md text-sm font-medium cursor-pointer ${
                    adminSubTab === "map" ? "bg-[var(--otzar-accent)] text-white" : "text-[var(--otzar-text-muted)]"
                  }`}
                >
                  עורך מפה דו-ממדית
                </button>
                <button
                  type="button"
                  onClick={() => setAdminSubTab("settings")}
                  className={`px-4 py-1.5 rounded-md text-sm font-medium cursor-pointer ${
                    adminSubTab === "settings" ? "bg-[var(--otzar-accent)] text-white" : "text-[var(--otzar-text-muted)]"
                  }`}
                >
                  הגדרות תצוגה ומערכת
                </button>
              </div>

              {adminSubTab === "map" ? (
                <MapEditorModule
                  cabinets={cabinets}
                  entrance={settings.map_entrance}
                  onReload={() => loadAll(searchQuery, statusFilter, categoryFilter)}
                />
              ) : (
                <div className="space-y-6 max-w-3xl">
                  <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] space-y-4">
                    <h2 className="font-semibold text-base">ערכת צבעים ומצב תאורה</h2>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { id: "otzar-orange", label: "כתום-לבן (אוצר החוכמה)" },
                        { id: "classic-blue", label: "כחול קלאסי" },
                        { id: "forest-green", label: "ירוק זית רגוע" },
                      ].map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => updateThemeSetting(p.id, settings.theme_mode || "light")}
                          className={`px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer ${
                            (settings.theme_preset || "otzar-orange") === p.id
                              ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)] text-[var(--otzar-accent)]"
                              : "border-[var(--otzar-border-muted)]"
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>

                    <div className="flex gap-2 pt-2">
                      {[
                        { id: "light", label: "מצב בהיר" },
                        { id: "dark", label: "מצב כהה" },
                      ].map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => updateThemeSetting(settings.theme_preset || "otzar-orange", m.id)}
                          className={`px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer ${
                            (settings.theme_mode || "light") === m.id
                              ? "border-[var(--otzar-accent)] bg-[var(--otzar-accent)] text-white"
                              : "border-[var(--otzar-border-muted)]"
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] space-y-4">
                    <h2 className="font-semibold text-base">הגדרות כלליות והשאלה</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div>
                        <label className="block text-xs font-medium mb-1">שם הספרייה / הישיבה</label>
                        <input
                          type="text"
                          value={settings.library_name || ""}
                          onChange={(e) => setSettings((p) => ({ ...p, library_name: e.target.value }))}
                          className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1">ימי השאלה כברירת מחדל</label>
                        <input
                          type="number"
                          min={1}
                          max={365}
                          value={settings.default_loan_days || "14"}
                          onChange={(e) => setSettings((p) => ({ ...p, default_loan_days: e.target.value }))}
                          className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await fetch("/api/settings", {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            library_name: settings.library_name || "אוצר ספרים",
                            default_loan_days: String(settings.default_loan_days || "14"),
                          }),
                        });
                        loadAll(searchQuery, statusFilter, categoryFilter);
                      }}
                      className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                    >
                      שמור הגדרות
                    </button>
                  </div>

                  <AiSettingsPanel
                    settings={settings}
                    setSettings={setSettings}
                    onReload={() => loadAll(searchQuery, statusFilter, categoryFilter, semanticMode)}
                  />

                  <UpdaterPanel onUpdateStatusChange={setUpdateBehindCount} />

                  {/* Admin PIN Change */}
                  <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] space-y-3">
                    <div className="flex items-center gap-2 font-semibold text-base">
                      <KeyRound className="w-4 h-4 text-[var(--otzar-accent)]" />
                      <span>אבטחת מנהל (קוד PIN)</span>
                    </div>
                    <p className="text-xs text-[var(--otzar-text-muted)]">
                      שינוי קוד ה-PIN הנדרש לפתיחת מצב מנהל (לפחות 4 תווים).
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <input
                        type="password"
                        dir="ltr"
                        value={newPin}
                        onChange={(e) => setNewPin(e.target.value)}
                        placeholder="קוד PIN חדש"
                        className="px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono w-48"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          setPinMsg(null);
                          if (newPin.trim().length < 4) {
                            setPinMsg("הקוד חייב להכיל לפחות 4 תווים.");
                            return;
                          }
                          const res = await fetch("/api/admin/pin", {
                            method: "PUT",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ newPin: newPin.trim() }),
                          });
                          const d = await res.json().catch(() => ({}));
                          if (!res.ok) {
                            setPinMsg(d.error || "שגיאה בעדכון קוד PIN");
                          } else {
                            setNewPin("");
                            setPinMsg("קוד ה-PIN עודכן בהצלחה.");
                          }
                        }}
                        className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                      >
                        עדכן קוד PIN
                      </button>
                    </div>
                    {pinMsg && <div className="text-xs text-[var(--otzar-accent)] font-medium">{pinMsg}</div>}
                  </div>

                  {/* Export & Local SQLite Backup */}
                  <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] space-y-3">
                    <div className="flex items-center gap-2 font-semibold text-base">
                      <HardDrive className="w-4 h-4 text-[var(--otzar-accent)]" />
                      <span>גיבוי וייצוא נתונים</span>
                    </div>
                    <div className="flex flex-wrap gap-2.5 text-sm">
                      <button
                        type="button"
                        onClick={() => downloadWithAuth("/api/export/books.xlsx", "otzar-sefarim-catalog.xlsx")}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] font-medium cursor-pointer"
                      >
                        <FileSpreadsheet className="w-4 h-4 text-[var(--otzar-accent)]" />
                        ייצוא קטלוג ל-Excel (.xlsx)
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadWithAuth("/api/export/books.csv", "otzar-sefarim-catalog.csv")}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] font-medium cursor-pointer"
                      >
                        <Download className="w-4 h-4 text-[var(--otzar-accent)]" />
                        ייצוא קטלוג ל-CSV (עברית)
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadWithAuth("/api/backup/download", "otzar-backup.db")}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] font-medium cursor-pointer"
                      >
                        <Database className="w-4 h-4 text-[var(--otzar-accent)]" />
                        הורד גיבוי מסד נתונים (.db)
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          setBackupMsg(null);
                          const res = await fetch("/api/backup/save-local", { method: "POST" });
                          const d = await res.json().catch(() => ({}));
                          if (!res.ok) {
                            setBackupMsg(d.error || "שגיאה בשמירת גיבוי מקומי");
                          } else {
                            setBackupMsg("הגיבוי נשמר בהצלחה בנתיב: " + d.path);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] font-semibold cursor-pointer"
                      >
                        <HardDrive className="w-4 h-4" />
                        שמור גיבוי מקומי בתיקיית data/backups
                      </button>
                    </div>
                    {backupMsg && <div className="text-xs text-[var(--otzar-accent)] font-medium" dir="auto">{backupMsg}</div>}
                  </div>

                  <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] text-sm space-y-1.5">
                    <div className="font-semibold">פרטי מסד הנתונים והסביבה המקומית</div>
                    <div className="text-[var(--otzar-text-muted)]">
                      סביבת הרצה:{" "}
                      <span className="text-[var(--otzar-text)]">
                        {health?.isElectron ? "תוכנת שולחן עבודה עצמאית (Desktop)" : "שרת מקומי בדפדפן"}
                      </span>
                      {health?.appVersion && (
                        <>
                          <span aria-hidden="true" className="mx-1.5">·</span>
                          <span className="font-mono tabular-nums text-[var(--otzar-text)]">v{health.appVersion}</span>
                        </>
                      )}
                    </div>
                    <div className="text-[var(--otzar-text-muted)]">דרייבר SQLite: <span className="font-mono text-[var(--otzar-text)]">{health?.driver}</span></div>
                    {health?.dataDir && (
                      <div className="text-[var(--otzar-text-muted)]">תיקיית נתונים: <span className="font-mono text-[var(--otzar-text)]" dir="ltr">{health.dataDir}</span></div>
                    )}
                    <div className="text-[var(--otzar-text-muted)]">נתיב קובץ מסד: <span className="font-mono text-[var(--otzar-text)]" dir="ltr">{health?.dbPath}</span></div>
                    {health?.migratedFrom && (
                      <div className="text-[var(--otzar-text-muted)]">
                        הועתקו נתונים קיימים מ: <span className="font-mono text-[var(--otzar-text)]" dir="ltr">{health.migratedFrom}</span>
                      </div>
                    )}
                    {health?.certSummary && health.certSummary.loadedCount > 0 && (
                      <div className="text-[var(--otzar-text-muted)]">
                        תעודות שורש Windows (תמיכת אתרוג/סינון):{" "}
                        <span className="tabular-nums text-[var(--otzar-text)]">{health.certSummary.loadedCount} נטענו</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {effectiveTab === "circulation" && (
            <CirculationModule
              defaultLoanDays={Number(settings.default_loan_days) || 14}
              isAdmin={isAdmin}
              onReload={() => loadAll(searchQuery, statusFilter, categoryFilter)}
            />
          )}

          {isAdmin && effectiveTab === "catalog" && (
            <CatalogModule
              cabinets={cabinets}
              nextBarcode={String(settings.next_barcode || "100007")}
              barcodePrefix={String(settings.barcode_prefix || "")}
              aiModel={String(settings.ai_model || "gemini-4-hydrogen")}
              hasApiKey={Boolean(settings.ai_api_key || settings.has_api_key)}
              onReload={() => loadAll(searchQuery, statusFilter, categoryFilter, semanticMode)}
            />
          )}

          {isAdmin && effectiveTab === "labels" && (
            <LabelsModule
              books={books}
              settings={settings}
              onReload={() => loadAll(searchQuery, statusFilter, categoryFilter, semanticMode)}
            />
          )}
        </main>
      </div>

      {showPinModal && (
        <AdminPinModal
          onSuccess={async (t) => {
            setAdminToken(t);
            setIsAdmin(true);
            setShowPinModal(false);
            await loadAll(searchQuery, statusFilter, categoryFilter, semanticMode);
          }}
          onClose={() => setShowPinModal(false)}
        />
      )}
    </div>
  );
}
