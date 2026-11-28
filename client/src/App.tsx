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
  Bot,
  Cloud,
  Smartphone,
  SlidersHorizontal,
  Type,
  Trash2,
  ListFilter,
  Plus,
} from "lucide-react";
import type { BookRow, CabinetRow, HealthData, ModuleKey, RoomDimensions, VolumeNotationRule } from "./types.ts";
import { parseVolumeNotationRules, torahNaturalVolumeRank } from "./lib/torahUtils.ts";
import { SearchModule } from "./components/SearchModule.tsx";
import { MapEditorModule } from "./components/MapEditorModule.tsx";
import { CirculationModule } from "./components/CirculationModule.tsx";
import { CatalogModule } from "./components/CatalogModule.tsx";
import { AiSettingsPanel } from "./components/AiSettingsPanel.tsx";
import { FirebaseSyncPanel } from "./components/FirebaseSyncPanel.tsx";
import { SetupTransferPanel } from "./components/SetupTransferPanel.tsx";
import { UpdaterPanel } from "./components/UpdaterPanel.tsx";
import { StringsEditorPanel } from "./components/StringsEditorPanel.tsx";
import { useStrings } from "./lib/stringsContext.tsx";
import { WhatsNewModal, type RecentUpdateInfo } from "./components/WhatsNewModal.tsx";
import { LabelsModule } from "./components/LabelsModule.tsx";
import { AdminPinModal } from "./components/AdminPinModal.tsx";
import { BugReportModal } from "./components/BugReportModal.tsx";
import { LocationModal } from "./components/LocationModal.tsx";
import { Bug } from "lucide-react";
import { installFetchAdminInterceptor, setAdminToken } from "./lib/adminSession.ts";

installFetchAdminInterceptor();

const NAV_ITEMS: Array<{ key: ModuleKey; labelKey: "nav.searchTab" | "nav.circulationTab" | "nav.catalogAiTab" | "nav.labelsTab" | "nav.adminAndMapTab"; icon: React.ComponentType<{ className?: string }> }> = [
  { key: "search", labelKey: "nav.searchTab", icon: Search },
  { key: "circulation", labelKey: "nav.circulationTab", icon: ArrowLeftRight },
  { key: "catalog", labelKey: "nav.catalogAiTab", icon: PlusSquare },
  { key: "labels", labelKey: "nav.labelsTab", icon: Printer },
  { key: "admin", labelKey: "nav.adminAndMapTab", icon: Settings },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<ModuleKey>("search");
  const [visitedTabs, setVisitedTabs] = useState<Set<ModuleKey>>(() => new Set(["search"]));
  const [sessionResetKey, setSessionResetKey] = useState(0);
  const [catalogRefreshTick, setCatalogRefreshTick] = useState(0);
  const [quickEditBook, setQuickEditBook] = useState<{ book: BookRow; editMode: boolean } | null>(null);
  const [adminSubTab, setAdminSubTab] = useState<"settings" | "map">("settings");
  const [settingsTab, setSettingsTab] = useState<"general" | "ai" | "cloud" | "updates" | "strings" | "transfer" | "maintenance">("general");
  const { overrides: activeStringOverrides, t } = useStrings();
  const [generalSaveMsg, setGeneralSaveMsg] = useState<string | null>(null);
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
  const [showBugReportModal, setShowBugReportModal] = useState(false);
  const [newPin, setNewPin] = useState("");
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [updateBehindCount, setUpdateBehindCount] = useState(0);
  const [updateReadyToInstall, setUpdateReadyToInstall] = useState(false);
  const [updateAvailableVer, setUpdateAvailableVer] = useState<string | null>(null);
  const [installingBannerUpdate, setInstallingBannerUpdate] = useState(false);
  const [dismissUpdateBanner, setDismissUpdateBanner] = useState(false);
  const [recentUpdate, setRecentUpdate] = useState<RecentUpdateInfo | null>(null);
  const [editingVolumeRules, setEditingVolumeRules] = useState<VolumeNotationRule[] | null>(null);
  const [newVolSymbol, setNewVolSymbol] = useState("");
  const [newVolRank, setNewVolRank] = useState(1);
  const [newVolLabel, setNewVolLabel] = useState("");
  const [volumeRulesSaveMsg, setVolumeRulesSaveMsg] = useState<string | null>(null);
  const [testVolInput, setTestVolInput] = useState("");

  const roomDimensions: RoomDimensions | undefined = settings.room_dimensions;
  const volumeNotationRules: VolumeNotationRule[] = React.useMemo(() => {
    return parseVolumeNotationRules(settings.volume_notation_rules);
  }, [settings.volume_notation_rules]);

  useEffect(() => {
    if (editingVolumeRules === null && settings.volume_notation_rules) {
      setEditingVolumeRules(parseVolumeNotationRules(settings.volume_notation_rules));
    }
  }, [settings.volume_notation_rules]);

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
      setCatalogRefreshTick((t) => t + 1);
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
    fetch("/api/updater/recent-update", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: RecentUpdateInfo | null) => {
        if (d?.hasRecentUpdate) {
          setRecentUpdate(d);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setUpdateBehindCount(0);
      setUpdateReadyToInstall(false);
      setUpdateAvailableVer(null);
      return;
    }
    fetch("/api/updater/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.lastCheck?.behindCount > 0) {
          setUpdateBehindCount(Number(d.lastCheck.behindCount) || 0);
        }
        setUpdateReadyToInstall(Boolean(d?.isElectron && d?.desktop?.downloaded));
        setUpdateAvailableVer(d?.desktop?.availableVersion || null);
      })
      .catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const refreshSettingsAndCabinetsIfChanged = async () => {
    try {
      const [sRes, cRes] = await Promise.all([fetch("/api/settings"), fetch("/api/cabinets")]);
      if (sRes.ok) {
        const nextS = await sRes.json();
        setSettings((prev) => (JSON.stringify(prev) === JSON.stringify(nextS) ? prev : nextS));
      }
      if (cRes.ok) {
        const nextC = await cRes.json();
        setCabinets((prev) => (JSON.stringify(prev) === JSON.stringify(nextC) ? prev : nextC));
      }
    } catch {}
  };

  useEffect(() => {
    const bootTimer = setTimeout(() => {
      void refreshSettingsAndCabinetsIfChanged();
    }, 4500);
    return () => clearTimeout(bootTimer);
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

  const didMountTabRefresh = React.useRef(false);
  useEffect(() => {
    if (!didMountTabRefresh.current) {
      didMountTabRefresh.current = true;
      return;
    }
    if (effectiveTab === "search" || (effectiveTab === "admin" && adminSubTab === "map")) {
      void refreshSettingsAndCabinetsIfChanged();
    }
  }, [effectiveTab, adminSubTab]);

  useEffect(() => {
    setVisitedTabs((prev) => {
      if (prev.has(effectiveTab)) return prev;
      const next = new Set(prev);
      next.add(effectiveTab);
      return next;
    });
  }, [effectiveTab]);

  const handleOpenBookByBarcode = async (barcode: string, editMode = true) => {
    const clean = String(barcode || "").trim();
    if (!clean) return;
    const localFound = books.find((b) => b.barcode === clean);
    if (localFound) {
      setQuickEditBook({ book: localFound, editMode });
      return;
    }
    try {
      const res = await fetch(`/api/books?q=${encodeURIComponent(clean)}`);
      if (res.ok) {
        const list = (await res.json()) as BookRow[];
        const exact = Array.isArray(list) ? list.find((b) => b.barcode === clean) : undefined;
        if (exact) setQuickEditBook({ book: exact, editMode });
      }
    } catch {}
  };

  const activeNavItem = visibleNavItems.find((n) => n.key === effectiveTab);
  const activeNavLabel = activeNavItem ? t(activeNavItem.labelKey) : "";

  const handleAdminLogout = async () => {
    try {
      await fetch("/api/admin/logout", { method: "POST" });
    } catch {}
    setAdminToken("");
    setIsAdmin(false);
    setQuickEditBook(null);
    setSearchQuery("");
    setStatusFilter("all");
    setCategoryFilter("all");
    setSemanticMode(false);
    setSemanticNotice(null);
    try { localStorage.removeItem("otzar_desktop_search_sort_v1"); } catch {}
    setVisitedTabs(new Set(["search"]));
    setSessionResetKey((k) => k + 1);
    setActiveTab("search");
    await loadAll("", "all", "all", false);
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
            {settings.library_name || t("common.appName")}
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
                {t("nav.adminBadge")}
              </span>
              <button
                type="button"
                onClick={handleAdminLogout}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] text-[var(--otzar-text)] whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                {t("nav.adminLogoutButton")}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setShowBugReportModal(true)}
            title="דיווח על באג / תקלה"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-red-300 dark:border-red-900 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 hover:bg-red-100 transition-colors cursor-pointer shrink-0"
          >
            <Bug className="w-3.5 h-3.5" />
            <span>דווח תקלה</span>
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            {isFullscreen ? t("nav.exitFullscreen") : t("nav.enterFullscreen")}
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
                  onClick={() => {
                    setActiveTab(item.key);
                    if (item.key === "admin") setAdminSubTab("settings");
                  }}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    isActive
                      ? "bg-[var(--otzar-accent)] text-white"
                      : "text-[var(--otzar-text)] hover:bg-[var(--otzar-surface)]"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{t(item.labelKey)}</span>
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
                  {t("nav.dbSummaryTitle")}
                </span>
                <span className="tabular-nums font-medium text-emerald-700 dark:text-emerald-400">{health?.ok ? t("nav.dbSummaryActive") : "..."}</span>
              </div>
              <div className="flex justify-between tabular-nums">
                <span>{t("nav.dbSummaryBooks")}</span>
                <span className="font-semibold text-[var(--otzar-text)]">{health?.counts.books ?? 0}</span>
              </div>
              <div className="flex justify-between tabular-nums">
                <span>{t("nav.dbSummaryCabinets")}</span>
                <span className="font-semibold text-[var(--otzar-text)]">{health?.counts.cabinets ?? 0}</span>
              </div>
              <div className="flex justify-between tabular-nums">
                <span>{t("nav.dbSummaryBorrowed")}</span>
                <span className="font-semibold text-[var(--otzar-text)]">{health?.counts.activeLoans ?? 0}</span>
              </div>
              <div className="flex justify-between tabular-nums">
                <span>{t("nav.dbSummaryPrintQueue")}</span>
                <span className="font-semibold text-[var(--otzar-accent)]">{health?.counts.printQueue ?? 0}</span>
              </div>
              {(health?.counts.recycleBin ?? 0) > 0 && (
                <div className="flex justify-between tabular-nums">
                  <span className="flex items-center gap-1 text-[var(--otzar-accent)] font-medium">
                    <Trash2 className="w-3 h-3" />
                    סל מחזור (30 יום)
                  </span>
                  <span className="font-bold text-[var(--otzar-accent)]">{health?.counts.recycleBin ?? 0}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="border-t border-[var(--otzar-border-muted)] pt-3">
              <button
                type="button"
                onClick={() => setShowPinModal(true)}
                title={t("nav.adminLoginTitle")}
                className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] hover:bg-[var(--otzar-surface)] transition-colors cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>{t("nav.adminLoginButton")}</span>
              </button>
            </div>
          )}
        </aside>

        {/* Main Workspace */}
        <main
          className={
            effectiveTab === "search"
              ? "flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden p-6 gap-4"
              : "flex-1 min-w-0 overflow-y-auto p-6 space-y-6"
          }
        >
          {errorMsg && (
            <div className="shrink-0 p-3.5 rounded-lg border border-red-300 bg-red-50 text-red-800 text-sm">
              {errorMsg}
            </div>
          )}

          {isAdmin && updateBehindCount > 0 && !dismissUpdateBanner && !(effectiveTab === "admin" && adminSubTab === "settings") && (
            <div className="shrink-0 p-3 rounded-xl border border-[var(--otzar-accent)]/40 bg-[var(--otzar-surface)] flex flex-wrap items-center justify-between gap-2 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <RefreshCw className="w-4 h-4 text-[var(--otzar-accent)] shrink-0" />
                <span>
                  {updateReadyToInstall
                    ? updateAvailableVer
                      ? t("updater.bannerReadyWithVersion", { version: updateAvailableVer })
                      : t("updater.bannerReadyNoVersion")
                    : updateAvailableVer
                    ? t("updater.bannerAvailableVersion", { version: updateAvailableVer })
                    : t("updater.bannerBehindCommits", { count: updateBehindCount })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {updateReadyToInstall ? (
                  <button
                    type="button"
                    disabled={installingBannerUpdate}
                    onClick={async () => {
                      setInstallingBannerUpdate(true);
                      try {
                        const r = await fetch("/api/updater/install-now", { method: "POST" });
                        if (!r.ok) setInstallingBannerUpdate(false);
                      } catch {
                        setInstallingBannerUpdate(false);
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 cursor-pointer disabled:opacity-60 whitespace-nowrap shrink-0"
                  >
                    {installingBannerUpdate ? t("updater.bannerInstallingButton") : t("updater.bannerRestartInstallButton")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab("admin");
                      setAdminSubTab("settings");
                      setSettingsTab("updates");
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {t("updater.bannerOpenUpdatesButton")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDismissUpdateBanner(true)}
                  className="px-2.5 py-1.5 rounded-lg text-xs text-[var(--otzar-text-muted)] hover:bg-[var(--otzar-bg)] cursor-pointer whitespace-nowrap shrink-0"
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
              roomDimensions={roomDimensions}
              volumeNotationRules={volumeNotationRules}
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
                  onClick={() => setAdminSubTab("settings")}
                  className={`px-4 py-1.5 rounded-md text-sm font-medium cursor-pointer ${
                    adminSubTab === "settings" ? "bg-[var(--otzar-accent)] text-white" : "text-[var(--otzar-text-muted)]"
                  }`}
                >
                  הגדרות תצוגה ומערכת
                </button>
                <button
                  type="button"
                  onClick={() => setAdminSubTab("map")}
                  className={`px-4 py-1.5 rounded-md text-sm font-medium cursor-pointer ${
                    adminSubTab === "map" ? "bg-[var(--otzar-accent)] text-white" : "text-[var(--otzar-text-muted)]"
                  }`}
                >
                  עורך מפה דו-ממדית
                </button>
              </div>

              {adminSubTab === "map" ? (
                <MapEditorModule
                  cabinets={cabinets}
                  entrance={settings.map_entrance}
                  roomDimensions={roomDimensions}
                  onReload={() => loadAll(searchQuery, statusFilter, categoryFilter)}
                />
              ) : (
                <div className="space-y-5 max-w-4xl">
                  {/* 6 Horizontal Sub-Tabs for Display & System Settings */}
                  <div className="flex flex-wrap items-center gap-1.5 p-1.5 rounded-xl bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)]">
                    {[
                      { id: "general", label: t("settings.generalTab"), icon: SlidersHorizontal },
                      { id: "ai", label: t("settings.aiTab"), icon: Bot },
                      { id: "cloud", label: t("settings.syncTab"), icon: Cloud },
                      { id: "updates", label: t("settings.updaterTab"), icon: RefreshCw, badge: updateBehindCount > 0 ? updateBehindCount : 0 },
                      { id: "strings", label: t("settings.stringsTab"), icon: Type, badge: Object.keys(activeStringOverrides).length || 0 },
                      { id: "transfer", label: t("settings.transferTab"), icon: Smartphone },
                      { id: "maintenance", label: t("settings.maintenanceTab"), icon: ShieldCheck },
                    ].map((t) => {
                      const TabIcon = t.icon;
                      const active = settingsTab === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setSettingsTab(t.id as typeof settingsTab)}
                          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs sm:text-sm font-medium cursor-pointer transition-colors whitespace-nowrap ${
                            active
                              ? "bg-[var(--otzar-accent)] text-white shadow-xs"
                              : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] hover:bg-[var(--otzar-bg)]"
                          }`}
                        >
                          <TabIcon className="w-3.5 h-3.5 shrink-0" />
                          <span>{t.label}</span>
                          {t.badge ? (
                            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold tabular-nums ${active ? "bg-white/25 text-white" : "bg-[var(--otzar-accent)] text-white"}`}>
                              {t.badge}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>

                  {/* TAB 1: GENERAL & LIBRARY */}
                  {settingsTab === "general" && (
                    <div className="space-y-5 max-w-3xl">
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
                        <h2 className="font-semibold text-base">הגדרות כלליות, השאלה וברקודים</h2>
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
                          <div>
                            <label className="block text-xs font-medium mb-1">קידומת ברקוד (אופציונלי)</label>
                            <input
                              type="text"
                              dir="ltr"
                              placeholder="למשל: OTZ-"
                              value={settings.barcode_prefix ?? ""}
                              onChange={(e) => setSettings((p) => ({ ...p, barcode_prefix: e.target.value }))}
                              className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-1">מונה ברקוד אוטומטי הבא</label>
                            <input
                              type="number"
                              min={1}
                              dir="ltr"
                              value={settings.next_barcode || "100001"}
                              onChange={(e) => setSettings((p) => ({ ...p, next_barcode: e.target.value }))}
                              className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono tabular-nums"
                            />
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            onClick={async () => {
                              setGeneralSaveMsg(null);
                              await fetch("/api/settings", {
                                method: "PUT",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  library_name: settings.library_name || "אוצר ספרים",
                                  default_loan_days: String(settings.default_loan_days || "14"),
                                  barcode_prefix: String(settings.barcode_prefix ?? "").trim(),
                                  next_barcode: String(settings.next_barcode || "100001").trim(),
                                }),
                              });
                              await loadAll(searchQuery, statusFilter, categoryFilter);
                              setGeneralSaveMsg("הגדרות הספרייה והברקודים נשמרו בהצלחה.");
                            }}
                            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                          >
                            שמור הגדרות
                          </button>
                          <button
                            type="button"
                            onClick={() => setActiveTab("labels")}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] cursor-pointer"
                          >
                            <Printer className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />
                            הגדרות תבניות מדבקות A4 ({Number(settings.a4_template?.rows) || 8}×{Number(settings.a4_template?.cols) || 3})
                          </button>
                          {generalSaveMsg && (
                            <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{generalSaveMsg}</span>
                          )}
                        </div>
                      </div>

                      {/* Volume Notation Rules (חוקי המרת סימוני כרכים גמישים) */}
                      <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 font-semibold text-base">
                            <ListFilter className="w-4 h-4 text-[var(--otzar-accent)]" />
                            <span>חוקי המרת סימוני כרכים גמישים (Volume Notation Rules)</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const defaultRules = parseVolumeNotationRules(null);
                              setEditingVolumeRules(defaultRules);
                              setVolumeRulesSaveMsg("שוחזרו כללי ברירת המחדל. לחץ שמור חוקי כרכים כדי לעדכן.");
                            }}
                            className="text-xs text-[var(--otzar-accent)] hover:underline cursor-pointer"
                          >
                            שחזר חוקי ברירת מחדל
                          </button>
                        </div>
                        <p className="text-xs text-[var(--otzar-text-muted)]">
                          הגדרת זוגות המרה וסדר מיון לכרכים בסטים: כוכביות (*, **), ספרות רומיות (I, II, III), נקודות (•, ••), אותיות וסימונים חופשיים. המערכת מזהה וממיינת אוטומטית לפיהם במחשב ובנייד.
                        </p>

                        {/* Rules table */}
                        <div className="rounded-lg border border-[var(--otzar-border-muted)] overflow-hidden">
                          <table className="w-full text-xs text-right">
                            <thead className="bg-[var(--otzar-surface)] border-b border-[var(--otzar-border-muted)] text-[var(--otzar-text-muted)]">
                              <tr>
                                <th className="p-2 font-semibold">סימון / תו (Symbol)</th>
                                <th className="p-2 font-semibold">סדר מיון (Rank)</th>
                                <th className="p-2 font-semibold">תיאור / תווית</th>
                                <th className="p-2 font-semibold text-center w-12">הסר</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]">
                              {(editingVolumeRules || volumeNotationRules).map((rule, idx) => (
                                <tr key={idx} className="hover:bg-[var(--otzar-surface)]/50">
                                  <td className="p-2 font-mono font-bold text-sm text-[var(--otzar-accent)]" dir="ltr">
                                    {rule.symbol}
                                  </td>
                                  <td className="p-2 font-mono tabular-nums font-semibold">
                                    {rule.rank}
                                  </td>
                                  <td className="p-2 text-[var(--otzar-text-muted)]">
                                    {rule.label || "—"}
                                  </td>
                                  <td className="p-2 text-center">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const current = editingVolumeRules || [...volumeNotationRules];
                                        setEditingVolumeRules(current.filter((_, i) => i !== idx));
                                      }}
                                      className="p-1 text-red-600 hover:bg-red-50 rounded cursor-pointer"
                                      title="הסר חוק"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Add new rule row */}
                        <div className="p-3 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] space-y-2">
                          <div className="text-xs font-semibold">הוספת סימון חדש:</div>
                          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs">
                            <input
                              type="text"
                              value={newVolSymbol}
                              onChange={(e) => setNewVolSymbol(e.target.value)}
                              placeholder="סימון (למשל: **** או IV)"
                              className="sm:col-span-4 px-2.5 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono"
                              dir="ltr"
                            />
                            <input
                              type="number"
                              min={1}
                              max={999}
                              value={newVolRank}
                              onChange={(e) => setNewVolRank(Number(e.target.value) || 1)}
                              placeholder="סדר מיון (למשל: 4)"
                              className="sm:col-span-3 px-2.5 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono tabular-nums"
                            />
                            <input
                              type="text"
                              value={newVolLabel}
                              onChange={(e) => setNewVolLabel(e.target.value)}
                              placeholder="תיאור (למשל: חלק ד)"
                              className="sm:col-span-4 px-2.5 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                if (!newVolSymbol.trim()) return;
                                const current = editingVolumeRules ? [...editingVolumeRules] : [...volumeNotationRules];
                                current.push({
                                  symbol: newVolSymbol.trim(),
                                  rank: Math.max(1, newVolRank),
                                  label: newVolLabel.trim() || undefined,
                                });
                                current.sort((a, b) => a.rank - b.rank);
                                setEditingVolumeRules(current);
                                setNewVolSymbol("");
                                setNewVolRank(current.length + 1);
                                setNewVolLabel("");
                              }}
                              className="sm:col-span-1 inline-flex items-center justify-center p-1.5 rounded bg-[var(--otzar-accent)] text-white hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                              title="הוסף חוק"
                            >
                              <Plus className="w-4 h-4" />
                            </button>
                          </div>
                        </div>

                        {/* Test live preview */}
                        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                          <span className="text-[var(--otzar-text-muted)] font-medium">בדיקת פענוח סימון בלייב:</span>
                          <input
                            type="text"
                            value={testVolInput}
                            onChange={(e) => setTestVolInput(e.target.value)}
                            placeholder="הקלד סימון לבדיקה (למשל: ** או III או א-1)..."
                            className="px-2.5 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-mono text-xs w-56"
                            dir="ltr"
                          />
                          {testVolInput && (
                            <span className="text-[var(--otzar-accent)] font-semibold tabular-nums">
                              דירוג מחושב: {torahNaturalVolumeRank(testVolInput, editingVolumeRules || volumeNotationRules)}
                            </span>
                          )}
                        </div>

                        {/* Save rules button */}
                        <div className="flex flex-wrap items-center gap-3 pt-2">
                          <button
                            type="button"
                            onClick={async () => {
                              setVolumeRulesSaveMsg(null);
                              const rulesToSave = editingVolumeRules || volumeNotationRules;
                              const res = await fetch("/api/settings", {
                                method: "PUT",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  volume_notation_rules: rulesToSave,
                                }),
                              });
                              if (res.ok) {
                                await loadAll(searchQuery, statusFilter, categoryFilter);
                                setVolumeRulesSaveMsg("חוקי סימוני הכרכים נשמרו בהצלחה ויסונכרנו למובייל.");
                              } else {
                                setVolumeRulesSaveMsg("שגיאה בשמירת חוקי כרכים.");
                              }
                            }}
                            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                          >
                            שמור חוקי כרכים
                          </button>
                          {volumeRulesSaveMsg && (
                            <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                              {volumeRulesSaveMsg}
                            </span>
                          )}
                        </div>
                      </div>

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
                    </div>
                  )}

                  {/* TAB 2: AI */}
                  {settingsTab === "ai" && (
                    <div className="max-w-3xl">
                      <AiSettingsPanel
                        settings={settings}
                        setSettings={setSettings}
                        onReload={() => loadAll(searchQuery, statusFilter, categoryFilter, semanticMode)}
                      />
                    </div>
                  )}

                  {/* TAB 3: CLOUD FIREBASE */}
                  {settingsTab === "cloud" && (
                    <div className="max-w-3xl">
                      <FirebaseSyncPanel
                        onReload={() => loadAll(searchQuery, statusFilter, categoryFilter, semanticMode)}
                      />
                    </div>
                  )}

                  {/* TAB 4: SOFTWARE UPDATES */}
                  {settingsTab === "updates" && (
                    <div className="max-w-3xl">
                      <UpdaterPanel onUpdateStatusChange={setUpdateBehindCount} />
                    </div>
                  )}

                  {/* TAB 4.5: LIVE STRINGS EDITOR */}
                  {settingsTab === "strings" && (
                    <div className="max-w-3xl">
                      <StringsEditorPanel onRequireAdmin={() => setShowPinModal(true)} />
                    </div>
                  )}

                  {/* TAB 5: TRANSFER TO ANOTHER DEVICE */}
                  {settingsTab === "transfer" && (
                    <div className="max-w-3xl">
                      <SetupTransferPanel
                        section="transfer"
                        onReload={() => loadAll(searchQuery, statusFilter, categoryFilter, semanticMode)}
                      />
                    </div>
                  )}

                  {/* TAB 6: MAINTENANCE & RESET */}
                  {settingsTab === "maintenance" && (
                    <div className="space-y-5 max-w-3xl">
                      <SetupTransferPanel
                        section="reset"
                        onReload={() => loadAll(searchQuery, statusFilter, categoryFilter, semanticMode)}
                      />

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
              isActive={effectiveTab === "catalog"}
              refreshTick={catalogRefreshTick}
              cabinets={cabinets}
              nextBarcode={String(settings.next_barcode || "100007")}
              barcodePrefix={String(settings.barcode_prefix || "")}
              aiModel={String(settings.ai_model || "gemini-4-hydrogen")}
              hasApiKey={Boolean(settings.ai_api_key || settings.has_api_key)}
              volumeNotationRules={volumeNotationRules}
              recycleBinCount={health?.counts.recycleBin ?? 0}
              onOpenBookByBarcode={(bc, edit) => void handleOpenBookByBarcode(bc, Boolean(edit))}
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

      {recentUpdate?.hasRecentUpdate && (
        <WhatsNewModal
          info={recentUpdate}
          onAcknowledge={async () => {
            try {
              await fetch("/api/updater/ack-release-notes", { method: "POST" });
            } catch {}
            setRecentUpdate(null);
          }}
        />
      )}
      {quickEditBook && (
        <LocationModal
          book={books.find((b) => b.barcode === quickEditBook.book.barcode) || quickEditBook.book}
          cabinets={cabinets}
          entrance={settings.map_entrance}
          roomDimensions={roomDimensions}
          volumeNotationRules={volumeNotationRules}
          isAdmin={isAdmin}
          initialEditMode={quickEditBook.editMode}
          onSelectBarcode={(bc, edit) => void handleOpenBookByBarcode(bc, Boolean(edit))}
          onBookUpdated={async () => {
            await loadAll(searchQuery, statusFilter, categoryFilter, semanticMode);
          }}
          onClose={() => setQuickEditBook(null)}
        />
      )}
      <BugReportModal
        isOpen={showBugReportModal}
        onClose={() => setShowBugReportModal(false)}
        appVersion="v1.0.37"
        totalBooks={books.length}
        totalCabinets={cabinets.length}
      />
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
