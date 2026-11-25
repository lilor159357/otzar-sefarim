import React, { useEffect, useState } from "react";
import { Trash2, RotateCcw, X, BookOpen, Bot, Loader2, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import type { RecycleBinData } from "../types.ts";
import { getAdminToken } from "../lib/adminSession.ts";

interface RecycleBinModalProps {
  onClose: () => void;
  onRestoredBook?: () => Promise<void> | void;
  onRestoredAi?: () => Promise<void> | void;
  onCountChanged?: () => Promise<void> | void;
}

export const RecycleBinModal: React.FC<RecycleBinModalProps> = ({
  onClose,
  onRestoredBook,
  onRestoredAi,
  onCountChanged,
}) => {
  const [data, setData] = useState<RecycleBinData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "books" | "ai">("all");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expandedJsonId, setExpandedJsonId] = useState<number | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadBin = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/recycle-bin");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "שגיאה בטעינת סל המחזור");
      setData(json);
    } catch (err: any) {
      setError(err?.message || "שגיאה בטעינת סל המחזור");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBin();
  }, []);

  const handleRestoreBook = async (barcode: string) => {
    setBusyKey("book-" + barcode);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch(`/api/recycle-bin/books/${encodeURIComponent(barcode)}/restore`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "שגיאה בשחזור הספר");
      setNotice(`הספר #${barcode} שוחזר למאגר בהצלחה (ויסונכרן אוטומטית לענן).`);
      await loadBin();
      await onRestoredBook?.();
      await onCountChanged?.();
    } catch (err: any) {
      setError(err?.message || "שגיאה בשחזור");
    } finally {
      setBusyKey(null);
    }
  };

  const handleRestoreAi = async (id: number) => {
    setBusyKey("ai-" + id);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch(`/api/recycle-bin/ai-queue/${id}/restore`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "שגיאה בהחזרה לתור ה-AI");
      setNotice(`פריט פענוח #${id} הוחזר לתור אישור ה-AI עם תמונותיו והנתונים שפוענחו.`);
      await loadBin();
      await onRestoredAi?.();
      await onCountChanged?.();
    } catch (err: any) {
      setError(err?.message || "שגיאה בהחזרה לתור");
    } finally {
      setBusyKey(null);
    }
  };

  const handlePermanentDeleteBook = async (barcode: string) => {
    setBusyKey("del-book-" + barcode);
    try {
      const res = await fetch(`/api/recycle-bin/books/${encodeURIComponent(barcode)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("שגיאה במחיקה לצמיתות");
      await loadBin();
      await onCountChanged?.();
    } catch (err: any) {
      setError(err?.message || "שגיאה במחיקה");
    } finally {
      setBusyKey(null);
    }
  };

  const handlePermanentDeleteAi = async (id: number) => {
    setBusyKey("del-ai-" + id);
    try {
      const res = await fetch(`/api/recycle-bin/ai-queue/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("שגיאה במחיקה לצמיתות");
      await loadBin();
      await onCountChanged?.();
    } catch (err: any) {
      setError(err?.message || "שגיאה במחיקה");
    } finally {
      setBusyKey(null);
    }
  };

  const handleEmptyAll = async () => {
    setBusyKey("empty-all");
    setError(null);
    try {
      const res = await fetch("/api/recycle-bin/empty", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "שגיאה בריקון סל המחזור");
      setConfirmEmpty(false);
      setNotice(`סל המחזור רוקן (${json.deletedBooks || 0} ספרים ו-${json.deletedAiItems || 0} סריקות AI נמחקו לצמיתות).`);
      await loadBin();
      await onCountChanged?.();
    } catch (err: any) {
      setError(err?.message || "שגיאה בריקון הסל");
    } finally {
      setBusyKey(null);
    }
  };

  const booksCount = data?.books.length ?? 0;
  const aiCount = data?.aiItems.length ?? 0;
  const totalCount = booksCount + aiCount;

  const showBooks = filter === "all" || filter === "books";
  const showAi = filter === "all" || filter === "ai";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-4xl rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-[var(--otzar-text)] overflow-hidden max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[var(--otzar-border-muted)] flex items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              <Trash2 className="w-5 h-5 text-[var(--otzar-accent)]" />
              <span>סל מחזור · שמירה ל-{data?.retentionDays ?? 30} יום</span>
            </h3>
            <p className="text-xs text-[var(--otzar-text-muted)] mt-0.5">
              ספרים שנמחקו וסריקות AI שנדחו נשמרים כאן למשך 30 יום יחד עם התמונות והפענוח המלא לפני מחיקה אוטומטית לצמיתות.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-[var(--otzar-surface-alt)] text-[var(--otzar-text-muted)] cursor-pointer"
            aria-label="סגור סל מחזור"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-3 border-b border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--otzar-bg)] border border-[var(--otzar-border-muted)]">
            {[
              { id: "all" as const, label: `הכל (${totalCount})` },
              { id: "books" as const, label: `ספרים שנמחקו (${booksCount})` },
              { id: "ai" as const, label: `פענוחי AI שנדחו (${aiCount})` },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`px-3 py-1 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                  filter === tab.id
                    ? "bg-[var(--otzar-accent)] text-white"
                    : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {totalCount > 0 && (
            confirmEmpty ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-red-700 dark:text-red-400 font-semibold flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  למחוק הכל לצמיתות ללא יכולת שחזור?
                </span>
                <button
                  type="button"
                  disabled={busyKey === "empty-all"}
                  onClick={handleEmptyAll}
                  className="px-3 py-1 rounded bg-red-600 text-white font-semibold cursor-pointer"
                >
                  {busyKey === "empty-all" ? "מרוקן..." : "כן, רוקן לצמיתות"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmEmpty(false)}
                  className="px-2.5 py-1 text-[var(--otzar-text-muted)] cursor-pointer"
                >
                  ביטול
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmEmpty(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/30 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                רוקן סל מחזור
              </button>
            )
          )}
        </div>

        <div className="p-6 overflow-y-auto space-y-4 text-sm">
          {notice && (
            <div className="p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-xs font-medium">
              {notice}
            </div>
          )}
          {error && (
            <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 text-xs">{error}</div>
          )}

          {loading ? (
            <div className="py-12 flex items-center justify-center gap-2 text-[var(--otzar-text-muted)]">
              <Loader2 className="w-4 h-4 animate-spin" />
              טוען פריטים מסל המחזור...
            </div>
          ) : totalCount === 0 ? (
            <div className="py-12 text-center text-[var(--otzar-text-muted)]">
              סל המחזור ריק. מחיקות ספרים ודחיות מתור ה-AI יישמרו כאן אוטומטית למשך 30 יום.
            </div>
          ) : (
            <div className="divide-y divide-[var(--otzar-border-muted)] rounded-xl border border-[var(--otzar-border-muted)] overflow-hidden">
              {showBooks &&
                (data?.books || []).map((b) => (
                  <div key={"book-" + b.barcode} className="p-4 flex flex-wrap items-center justify-between gap-3 bg-[var(--otzar-bg)]">
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--otzar-text-muted)]">
                        <span className="inline-flex items-center gap-1 font-semibold text-[var(--otzar-text)]">
                          <BookOpen className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />
                          ספר מהמאגר
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">#{b.barcode}</span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums font-medium text-amber-700 dark:text-amber-400">
                          נותרו {b.days_remaining} ימים
                        </span>
                        {b.images_count > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="tabular-nums">{b.images_count} תמונות שמורות</span>
                          </>
                        )}
                      </div>
                      <div className="font-bold">
                        {b.title}
                        {b.volume ? <span className="font-normal text-[var(--otzar-text-muted)]"> · {b.volume}</span> : null}
                      </div>
                      <div className="text-xs text-[var(--otzar-text-muted)]">
                        {[
                          b.set_name ? `סט: ${b.set_name}` : "",
                          b.sub_series ? `תת-סדרה: ${b.sub_series}` : "",
                          b.author,
                          b.coverage_range,
                          b.cabinet_code ? `ארון ${b.cabinet_code}${b.shelf_number ? ` מדף ${b.shelf_number}` : ""}` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ") || "ללא פרטים נוספים"}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={busyKey === "book-" + b.barcode}
                        onClick={() => handleRestoreBook(b.barcode)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-50"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        שחזר ספר למאגר
                      </button>
                      <button
                        type="button"
                        disabled={busyKey === "del-book-" + b.barcode}
                        onClick={() => handlePermanentDeleteBook(b.barcode)}
                        className="px-2.5 py-1.5 rounded-lg text-xs text-red-600 hover:bg-red-50 border border-red-200 cursor-pointer"
                        title="מחק לצמיתות"
                      >
                        מחק לצמיתות
                      </button>
                    </div>
                  </div>
                ))}

              {showAi &&
                (data?.aiItems || []).map((q) => {
                  const isExpanded = expandedJsonId === q.id;
                  const titleText = q.extracted?.title || q.extracted?.set_name || `סריקת AI #${q.id}`;
                  return (
                    <div key={"ai-" + q.id} className="p-4 space-y-2 bg-[var(--otzar-bg)]">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          {q.has_image && (
                            <img
                              src={`/api/ai-queue/image/${q.id}?adminToken=${encodeURIComponent(getAdminToken())}`}
                              alt={titleText}
                              className="w-11 h-14 object-cover rounded border border-[var(--otzar-border-muted)] shrink-0"
                            />
                          )}
                          <div className="space-y-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--otzar-text-muted)]">
                              <span className="inline-flex items-center gap-1 font-semibold text-[var(--otzar-text)]">
                                <Bot className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />
                                {q.is_shelf_set ? "סריקת סט מהמדף" : "פענוח AI"}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">#{q.id}</span>
                              <span aria-hidden="true">·</span>
                              <span className="tabular-nums font-medium text-amber-700 dark:text-amber-400">
                                נותרו {q.days_remaining} ימים
                              </span>
                              {q.image_count > 1 && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="tabular-nums">{q.image_count} תמונות</span>
                                </>
                              )}
                            </div>
                            <div className="font-bold truncate">{titleText}</div>
                            <div className="text-xs text-[var(--otzar-text-muted)] truncate">
                              {[
                                q.extracted?.set_name ? `סט: ${q.extracted.set_name}` : "",
                                q.extracted?.sub_series ? `תת-סדרה: ${q.extracted.sub_series}` : "",
                                q.extracted?.author,
                                q.extracted?.volume,
                                q.extracted?.coverage_range,
                              ]
                                .filter(Boolean)
                                .join(" · ") || "טרם פוענחו פרטים"}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          {q.extracted && (
                            <button
                              type="button"
                              onClick={() => setExpandedJsonId(isExpanded ? null : q.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer"
                            >
                              {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                              צפה בפענוח
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busyKey === "ai-" + q.id}
                            onClick={() => handleRestoreAi(q.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-50"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            החזר לתור אישור AI
                          </button>
                          <button
                            type="button"
                            disabled={busyKey === "del-ai-" + q.id}
                            onClick={() => handlePermanentDeleteAi(q.id)}
                            className="px-2.5 py-1.5 rounded-lg text-xs text-red-600 hover:bg-red-50 border border-red-200 cursor-pointer"
                          >
                            מחק לצמיתות
                          </button>
                        </div>
                      </div>

                      {isExpanded && q.extracted && (
                        <pre
                          dir="ltr"
                          className="p-3 rounded-lg bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] text-[11px] font-mono overflow-x-auto max-h-48 text-left"
                        >
                          {JSON.stringify(q.extracted, null, 2)}
                        </pre>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
