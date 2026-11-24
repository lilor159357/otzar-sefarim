import React, { useMemo, useState } from "react";
import {
  Check,
  Cloud,
  CloudOff,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  X,
} from "lucide-react";
import {
  STRING_NAMESPACE_LABELS,
  type StringKey,
  type StringNamespace,
} from "../../../shared/strings/dictionary.ts";
import {
  ALL_STRING_KEYS,
  extractPlaceholders,
  validateOverrideEntry,
} from "../../../shared/strings/engine.ts";
import { useStrings } from "../lib/stringsContext.tsx";

interface StringsEditorPanelProps {
  onRequireAdmin?: () => void;
}

type StatusFilter = "all" | "overridden" | "pending_build";

export const StringsEditorPanel: React.FC<StringsEditorPanelProps> = ({ onRequireAdmin }) => {
  const {
    t,
    resolved,
    defaults,
    overrides,
    localOverrides,
    cloudOverrides,
    cloudConnected,
    reloadStrings,
  } = useStrings();

  const [query, setQuery] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState<"all" | StringNamespace>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    key?: string;
    message: string;
  } | null>(null);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ALL_STRING_KEYS.filter((key) => {
      const ns = key.split(".")[0] as StringNamespace;
      if (namespaceFilter !== "all" && ns !== namespaceFilter) return false;

      const isOverridden = Object.prototype.hasOwnProperty.call(overrides, key);
      const cloudRec = cloudOverrides[key];
      const localRec = localOverrides[key];
      const isPendingBuild = Boolean(
        (cloudRec && (!cloudRec.promoted_desktop || !cloudRec.promoted_mobile)) ||
          (localRec && !cloudRec)
      );

      if (statusFilter === "overridden" && !isOverridden) return false;
      if (statusFilter === "pending_build" && !isPendingBuild) return false;

      if (!q) return true;
      const currentVal = (resolved[key] || "").toLowerCase();
      const defaultVal = (defaults[key] || "").toLowerCase();
      const nsLabel = (STRING_NAMESPACE_LABELS[ns] || "").toLowerCase();
      return (
        key.toLowerCase().includes(q) ||
        currentVal.includes(q) ||
        defaultVal.includes(q) ||
        nsLabel.includes(q)
      );
    });
  }, [query, namespaceFilter, statusFilter, overrides, cloudOverrides, localOverrides, resolved, defaults]);

  const handleRefresh = async () => {
    setReloading(true);
    setFeedback(null);
    try {
      await fetch("/api/strings/reload", { method: "POST" });
      await reloadStrings();
    } finally {
      setReloading(false);
    }
  };

  const handleSave = async (key: StringKey) => {
    const currentText = drafts[key] ?? resolved[key] ?? defaults[key];
    const check = validateOverrideEntry(key, currentText);
    if (!check.valid) {
      const missingPrefix = "missing_param:";
      const msg = check.reason.startsWith(missingPrefix)
        ? t("errors.overrideMissingParam", {
            key,
            param: `{${check.reason.slice(missingPrefix.length)}}`,
          })
        : t("errors.overrideInvalidJson");
      setFeedback({ type: "error", key, message: msg });
      return;
    }

    setBusyKey(key);
    setFeedback(null);
    try {
      const res = await fetch("/api/strings/override", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: check.value }),
      });
      if (res.status === 401) {
        onRequireAdmin?.();
        setFeedback({ type: "error", key, message: t("errors.adminRequired") });
        return;
      }
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setFeedback({ type: "error", key, message: data.error || t("common.unknownError") });
        return;
      }
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      await reloadStrings();
      setFeedback({ type: "success", key, message: t("settings.stringsSaveSuccess") });
    } catch {
      setFeedback({ type: "error", key, message: t("errors.networkTimeout") });
    } finally {
      setBusyKey(null);
    }
  };

  const handleReset = async (key: StringKey) => {
    setBusyKey(key);
    setFeedback(null);
    try {
      const res = await fetch(`/api/strings/override/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      if (res.status === 401) {
        onRequireAdmin?.();
        setFeedback({ type: "error", key, message: t("errors.adminRequired") });
        return;
      }
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setFeedback({ type: "error", key, message: data.error || t("common.unknownError") });
        return;
      }
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      await reloadStrings();
      setFeedback({ type: "success", key, message: t("settings.stringsResetSuccess") });
    } catch {
      setFeedback({ type: "error", key, message: t("errors.networkTimeout") });
    } finally {
      setBusyKey(null);
    }
  };

  const insertParam = (key: StringKey, paramName: string) => {
    const cur = drafts[key] ?? resolved[key] ?? defaults[key];
    const token = `{${paramName}}`;
    if (cur.includes(token)) return;
    setDrafts((prev) => ({
      ...prev,
      [key]: `${cur.trimEnd()} ${token}`,
    }));
  };

  return (
    <div className="space-y-4">
      <div className="p-5 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-[var(--otzar-text)]">
              {t("settings.stringsEditorTitle")}
            </h2>
            <p className="text-xs text-[var(--otzar-text-muted)] mt-0.5 leading-relaxed">
              {t("settings.stringsEditorSubtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={reloading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface)] hover:bg-[var(--otzar-surface-alt)] text-[var(--otzar-text)] transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${reloading ? "animate-spin" : ""}`} />
            <span>{t("common.refresh")}</span>
          </button>
        </div>

        {/* Cloud sync indicator */}
        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs border ${
            cloudConnected
              ? "bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/60 text-emerald-800 dark:text-emerald-200"
              : "bg-amber-50/70 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-200"
          }`}
        >
          {cloudConnected ? (
            <Cloud className="w-4 h-4 shrink-0" />
          ) : (
            <CloudOff className="w-4 h-4 shrink-0" />
          )}
          <span>
            {cloudConnected
              ? t("settings.stringsCloudSyncedNotice")
              : t("settings.stringsLocalOnlyNotice")}
          </span>
        </div>

        {/* Search & Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <div className="sm:col-span-2 relative">
            <Search className="w-4 h-4 text-[var(--otzar-text-muted)] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.stringsSearchPlaceholder")}
              className="w-full pr-9 pl-8 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface)] text-sm text-[var(--otzar-text)] focus:outline-none focus:ring-2 focus:ring-[var(--otzar-accent)]/40"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("common.close")}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <select
            value={namespaceFilter}
            onChange={(e) => setNamespaceFilter(e.target.value as "all" | StringNamespace)}
            className="px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface)] text-sm text-[var(--otzar-text)] focus:outline-none focus:ring-2 focus:ring-[var(--otzar-accent)]/40"
          >
            <option value="all">{t("settings.stringsFilterAll")}</option>
            {(Object.keys(STRING_NAMESPACE_LABELS) as StringNamespace[]).map((ns) => (
              <option key={ns} value={ns}>
                {STRING_NAMESPACE_LABELS[ns]}
              </option>
            ))}
          </select>
        </div>

        {/* Status pills & counter */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: "all", label: t("settings.stringsFilterAll") },
                { id: "overridden", label: t("settings.stringsFilterOverridden") },
                { id: "pending_build", label: t("settings.stringsFilterPendingBuild") },
              ] as const
            ).map((f) => {
              const active = statusFilter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setStatusFilter(f.id)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                    active
                      ? "bg-[var(--otzar-accent)] text-white"
                      : "bg-[var(--otzar-surface)] text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] border border-[var(--otzar-border-muted)]"
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-[var(--otzar-text-muted)] tabular-nums">
            {t("settings.stringsCountSummary", {
              shown: items.length,
              total: ALL_STRING_KEYS.length,
            })}
          </span>
        </div>
      </div>

      {/* Feedback banner */}
      {feedback && (
        <div
          className={`flex items-center justify-between gap-2 px-4 py-2.5 rounded-xl border text-xs font-medium ${
            feedback.type === "success"
              ? "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200"
              : "bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200"
          }`}
        >
          <div className="flex items-center gap-2">
            {feedback.type === "success" ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            )}
            <span>{feedback.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="p-0.5 hover:opacity-75 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Cards list */}
      {items.length === 0 ? (
        <div className="p-8 rounded-xl border border-dashed border-[var(--otzar-border-muted)] text-center text-sm text-[var(--otzar-text-muted)]">
          {t("settings.stringsEmptyMatch")}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((key) => {
            const ns = key.split(".")[0] as StringNamespace;
            const defaultVal = defaults[key];
            const currentResolved = resolved[key] ?? defaultVal;
            const draftVal = drafts[key] ?? currentResolved;
            const isDirty = draftVal !== currentResolved;
            const isOverridden = Object.prototype.hasOwnProperty.call(overrides, key);
            const cloudRec = cloudOverrides[key];
            const localRec = localOverrides[key];
            const requiredParams = extractPlaceholders(defaultVal);
            const validation = validateOverrideEntry(key, draftVal);
            const isBusy = busyKey === key;

            let validationMsg: string | null = null;
            if (!validation.valid) {
              const missingPrefix = "missing_param:";
              validationMsg = validation.reason.startsWith(missingPrefix)
                ? t("errors.overrideMissingParam", {
                    key,
                    param: `{${validation.reason.slice(missingPrefix.length)}}`,
                  })
                : t("errors.overrideInvalidJson");
            }

            return (
              <div
                key={key}
                className={`p-4 rounded-xl border transition-colors space-y-2.5 ${
                  isOverridden
                    ? "border-[var(--otzar-accent)]/40 bg-[var(--otzar-surface)]"
                    : "border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-[var(--otzar-surface-alt)] text-[var(--otzar-text-muted)]">
                      {STRING_NAMESPACE_LABELS[ns]}
                    </span>
                    <code
                      className="text-xs font-mono text-[var(--otzar-text-muted)] select-all"
                      dir="ltr"
                    >
                      {key}
                    </code>
                  </div>

                  {/* Promotion status chips */}
                  {(isOverridden || cloudRec || localRec) && (
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-medium ${
                          cloudRec?.promoted_desktop
                            ? "bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300"
                            : "bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300"
                        }`}
                      >
                        {cloudRec?.promoted_desktop ? (
                          <Check className="w-3 h-3" />
                        ) : (
                          <Sparkles className="w-3 h-3" />
                        )}
                        <span>
                          {cloudRec?.promoted_desktop
                            ? t("settings.stringsDesktopPromoted")
                            : t("settings.stringsDesktopPending")}
                        </span>
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-medium ${
                          cloudRec?.promoted_mobile
                            ? "bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300"
                            : "bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300"
                        }`}
                      >
                        {cloudRec?.promoted_mobile ? (
                          <Check className="w-3 h-3" />
                        ) : (
                          <Sparkles className="w-3 h-3" />
                        )}
                        <span>
                          {cloudRec?.promoted_mobile
                            ? t("settings.stringsMobilePromoted")
                            : t("settings.stringsMobilePending")}
                        </span>
                      </span>
                    </div>
                  )}
                </div>

                {/* Original code text */}
                {isOverridden && (
                  <div className="text-xs text-[var(--otzar-text-muted)] bg-[var(--otzar-bg)] px-2.5 py-1.5 rounded-lg border border-[var(--otzar-border-muted)]">
                    <span className="font-semibold ml-1">{t("settings.stringsOriginalValueLabel")}</span>
                    <span>{defaultVal}</span>
                  </div>
                )}

                {/* Editable input */}
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={draftVal}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [key]: e.target.value,
                      }))
                    }
                    dir="rtl"
                    className="flex-1 px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-sm text-[var(--otzar-text)] focus:outline-none focus:ring-2 focus:ring-[var(--otzar-accent)]/40"
                  />

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleSave(key)}
                      disabled={isBusy || !isDirty || !validation.valid}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>{isBusy ? t("common.saving") : t("common.save")}</span>
                    </button>

                    {(isOverridden || isDirty) && (
                      <button
                        type="button"
                        onClick={() => {
                          if (isOverridden) {
                            void handleReset(key);
                          } else {
                            setDrafts((prev) => {
                              const next = { ...prev };
                              delete next[key];
                              return next;
                            });
                          }
                        }}
                        disabled={isBusy}
                        className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs font-medium border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] hover:bg-[var(--otzar-surface-alt)] text-[var(--otzar-text)] transition-colors cursor-pointer disabled:opacity-40"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>{t("settings.stringsResetButton")}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Required parameter helpers & validation error */}
                {(requiredParams.length > 0 || validationMsg) && (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    {requiredParams.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 text-[var(--otzar-text-muted)]">
                        <span>{t("settings.stringsParamsHint")}</span>
                        {requiredParams.map((p) => {
                          const token = `{${p}}`;
                          const present = draftVal.includes(token);
                          return (
                            <button
                              key={p}
                              type="button"
                              onClick={() => insertParam(key, p)}
                              dir="ltr"
                              className={`px-1.5 py-0.5 rounded font-mono border cursor-pointer transition-colors ${
                                present
                                  ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
                                  : "border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
                              }`}
                            >
                              {token}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {validationMsg && (
                      <span className="text-red-600 dark:text-red-400 font-medium">
                        {validationMsg}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};