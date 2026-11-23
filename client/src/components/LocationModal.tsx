import React, { useEffect, useState } from "react";
import { X, MapPin, Layers, BookOpen, Pencil, Trash2, Save, CheckCircle2 } from "lucide-react";
import type { BookRow, CabinetRow, MapEntrance } from "../types.ts";
import { STATUS_LABELS } from "../types.ts";
import { LibraryMap2D } from "./LibraryMap2D.tsx";

interface LocationModalProps {
  book: BookRow;
  cabinets: CabinetRow[];
  entrance?: MapEntrance;
  isAdmin?: boolean;
  initialEditMode?: boolean;
  onBookUpdated?: () => Promise<void>;
  onClose: () => void;
}

export const LocationModal: React.FC<LocationModalProps> = ({
  book,
  cabinets,
  entrance,
  isAdmin = false,
  initialEditMode = false,
  onBookUpdated,
  onClose,
}) => {
  const [editing, setEditing] = useState(isAdmin && initialEditMode);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author || "");
  const [volume, setVolume] = useState(book.volume || "");
  const [publisher, setPublisher] = useState(book.publisher || "");
  const [pubYear, setPubYear] = useState(book.pub_year || "");
  const [edition, setEdition] = useState(book.edition || "");
  const [category, setCategory] = useState(book.category || "");
  const [tagsText, setTagsText] = useState((book.tagsList || []).join(", "));
  const [cabinetId, setCabinetId] = useState(book.cabinet_id ? String(book.cabinet_id) : "");
  const [shelfNumber, setShelfNumber] = useState(book.shelf_number ?? 1);
  const [status, setStatus] = useState<BookRow["status"]>(book.status);
  const [notes, setNotes] = useState(book.notes || "");

  useEffect(() => {
    setTitle(book.title);
    setAuthor(book.author || "");
    setVolume(book.volume || "");
    setPublisher(book.publisher || "");
    setPubYear(book.pub_year || "");
    setEdition(book.edition || "");
    setCategory(book.category || "");
    setTagsText((book.tagsList || []).join(", "));
    setCabinetId(book.cabinet_id ? String(book.cabinet_id) : "");
    setShelfNumber(book.shelf_number ?? 1);
    setStatus(book.status);
    setNotes(book.notes || "");
    setEditing(isAdmin && initialEditMode);
    setConfirmDelete(false);
    setErrMsg(null);
    setSavedNotice(null);
  }, [book.barcode, initialEditMode]);

  const activeCabId = editing ? (cabinetId ? Number(cabinetId) : null) : book.cabinet_id;
  const cabinet = cabinets.find((c) => c.id === activeCabId) || null;
  const totalShelves = cabinet?.shelves_count || book.cabinet_shelves_count || 5;
  const shelves = Array.from({ length: totalShelves }, (_, i) => i + 1);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setErrMsg("יש להזין שם ספר");
      return;
    }
    setSaving(true);
    setErrMsg(null);
    setSavedNotice(null);
    try {
      const res = await fetch("/api/books/" + encodeURIComponent(book.barcode), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          author: author.trim(),
          volume: volume.trim(),
          publisher: publisher.trim(),
          pub_year: pubYear.trim(),
          edition: edition.trim(),
          category: category.trim(),
          tags: tagsText
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          cabinet_id: cabinetId ? Number(cabinetId) : null,
          shelf_number: shelfNumber,
          status,
          notes: notes.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בעדכון הספר");
      setEditing(false);
      setSavedNotice("פרטי הספר עודכנו בהצלחה");
      if (onBookUpdated) await onBookUpdated();
    } catch (err: any) {
      setErrMsg(err?.message || "שגיאה בשמירה");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    setErrMsg(null);
    try {
      const res = await fetch("/api/books/" + encodeURIComponent(book.barcode), {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "לא ניתן למחוק ספר זה");
      }
      if (onBookUpdated) await onBookUpdated();
      onClose();
    } catch (err: any) {
      setErrMsg(err?.message || "שגיאה במחיקה");
      setSaving(false);
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
        className="w-full max-w-4xl rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-[var(--otzar-text)] overflow-hidden max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-[var(--otzar-border-muted)] flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-[var(--otzar-text-muted)]">
              <span className="font-mono tabular-nums font-semibold text-[var(--otzar-accent)]">#{book.barcode}</span>
              <span aria-hidden="true">·</span>
              <span>{book.category || "כללי"}</span>
              <span aria-hidden="true">·</span>
              <span
                className={
                  book.status === "available"
                    ? "text-emerald-700 dark:text-emerald-400 font-semibold"
                    : book.status === "reference_only"
                    ? "text-amber-700 dark:text-amber-400 font-semibold"
                    : "text-red-700 dark:text-red-400 font-semibold"
                }
              >
                {STATUS_LABELS[book.status] || book.status}
              </span>
            </div>
            <h2 className="text-xl font-bold">
              {book.title}
              {book.volume ? <span className="text-[var(--otzar-text-muted)] font-normal"> — {book.volume}</span> : null}
            </h2>
            <p className="text-sm text-[var(--otzar-text-muted)]">
              {book.author ? `מאת: ${book.author}` : "מחבר לא צוין"}
              {book.publisher ? ` · הוצאה: ${book.publisher}` : ""}
              {book.edition ? ` · מהדורה: ${book.edition}` : ""}
              {book.pub_year ? ` · שנת הוצאה: ${book.pub_year}` : ""}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isAdmin && (
              <button
                type="button"
                onClick={() => {
                  setEditing((v) => !v);
                  setConfirmDelete(false);
                  setErrMsg(null);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer ${
                  editing
                    ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)] text-[var(--otzar-accent)]"
                    : "border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)]"
                }`}
              >
                <Pencil className="w-3.5 h-3.5" />
                {editing ? "חזור לתצוגה" : "ערוך ספר"}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-[var(--otzar-surface-alt)] text-[var(--otzar-text-muted)] cursor-pointer"
              aria-label="סגור חלון"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto space-y-6">
          {savedNotice && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-sm font-medium">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{savedNotice}</span>
            </div>
          )}
          {errMsg && (
            <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 text-sm">{errMsg}</div>
          )}

          {editing ? (
            <form onSubmit={handleSave} className="space-y-4 text-sm">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium mb-1">שם הספר *</label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-semibold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">מחבר / מפרש</label>
                  <input
                    type="text"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">כרך / חלק / מסכת</label>
                  <input
                    type="text"
                    value={volume}
                    onChange={(e) => setVolume(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">קטגוריה</label>
                  <input
                    type="text"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">הוצאה / מכון</label>
                  <input
                    type="text"
                    value={publisher}
                    onChange={(e) => setPublisher(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">מהדורה (אופציונלי)</label>
                  <input
                    type="text"
                    value={edition}
                    onChange={(e) => setEdition(e.target.value)}
                    placeholder="למשל: מהדורה מתוקנת"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">שנת הוצאה (אופציונלי)</label>
                  <input
                    type="text"
                    value={pubYear}
                    onChange={(e) => setPubYear(e.target.value)}
                    placeholder="למשל: תשפ״ד / 2024"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium mb-1">תגיות חיפוש וכינויים (מופרדות בפסיקים)</label>
                  <input
                    type="text"
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">ארון במפה</label>
                  <select
                    value={cabinetId}
                    onChange={(e) => {
                      setCabinetId(e.target.value);
                      setShelfNumber(1);
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  >
                    <option value="">לא שויך לארון</option>
                    {cabinets.map((c) => (
                      <option key={c.id} value={c.id}>
                        ארון {c.code} ({c.main_subject})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">מדף (1–{totalShelves})</label>
                    <input
                      type="number"
                      min={1}
                      max={totalShelves}
                      value={shelfNumber}
                      onChange={(e) => setShelfNumber(Math.max(1, Number(e.target.value) || 1))}
                      className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">סטטוס</label>
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value as BookRow["status"])}
                      className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                    >
                      <option value="available">זמין על המדף</option>
                      <option value="borrowed">מושאל</option>
                      <option value="reference_only">לעיון בלבד</option>
                      <option value="lost">אבוד / חסר</option>
                    </select>
                  </div>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium mb-1">הערות</label>
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-[var(--otzar-border-muted)] flex flex-wrap items-center justify-between gap-3">
                {confirmDelete ? (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-red-700 font-semibold">למחוק את הספר לצמיתות?</span>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={handleDelete}
                      className="px-3 py-1.5 rounded-md bg-red-600 text-white font-semibold cursor-pointer"
                    >
                      כן, מחק
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(false)} className="px-2.5 py-1.5 cursor-pointer">
                      ביטול
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-red-600 hover:bg-red-50 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    מחק ספר מהמאגר
                  </button>
                )}

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="px-4 py-2 rounded-lg text-sm border border-[var(--otzar-border-muted)] cursor-pointer"
                  >
                    ביטול
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                  >
                    <Save className="w-4 h-4" />
                    {saving ? "שומר..." : "שמור שינויים"}
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <>
              {/* Primary Location Banner */}
              <div className="p-4 rounded-xl border border-[var(--otzar-border)] bg-[var(--otzar-surface)] flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <MapPin className="w-6 h-6 text-[var(--otzar-accent)] shrink-0" />
                  <div>
                    <div className="text-xs text-[var(--otzar-text-muted)]">מיקום הספר באוצר הספרים</div>
                    <div className="text-lg font-bold tabular-nums">
                      {cabinet
                        ? `אזור: ${cabinet.main_subject || "ראשי"}  |  ארון ${cabinet.code}  |  מדף ${book.shelf_number ?? "לא הוגדר"}`
                        : "הספר עדיין לא שויך לארון במפה"}
                    </div>
                  </div>
                </div>
                {book.notes && (
                  <div className="text-xs text-[var(--otzar-text-muted)] max-w-sm">
                    הערה: {book.notes}
                  </div>
                )}
              </div>

              {/* 2D Map + Vertical Shelf Diagram */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-stretch">
                <div className="lg:col-span-2 space-y-2">
                  <div className="flex items-center justify-between text-sm font-semibold">
                    <span className="flex items-center gap-1.5">
                      <BookOpen className="w-4 h-4 text-[var(--otzar-accent)]" />
                      מיקום הארון במפת הספרייה
                    </span>
                    {cabinet && (
                      <span className="text-xs text-[var(--otzar-accent)] font-semibold">
                        מודגש בכתום: ארון {cabinet.code}
                      </span>
                    )}
                  </div>
                  <LibraryMap2D cabinets={cabinets} highlightedCabinetId={cabinet?.id ?? null} entrance={entrance} />
                </div>

                {/* Vertical Shelf Diagram (Top to Bottom) */}
                <div className="space-y-2 flex flex-col">
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    <Layers className="w-4 h-4 text-[var(--otzar-accent)]" />
                    תרשים מדפים בארון {cabinet?.code || "—"} (מלמעלה למטה)
                  </div>
                  <div className="flex-1 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] p-3 flex flex-col justify-center gap-2">
                    {!cabinet ? (
                      <div className="text-center text-sm text-[var(--otzar-text-muted)] py-8">
                        לא הוגדר ארון לספר זה
                      </div>
                    ) : (
                      shelves.map((shelfNum) => {
                        const isTarget = book.shelf_number === shelfNum;
                        return (
                          <div
                            key={shelfNum}
                            className={`px-3.5 py-2.5 rounded-lg border flex items-center justify-between text-sm tabular-nums transition-colors ${
                              isTarget
                                ? "bg-[var(--otzar-accent)] border-[var(--otzar-accent-hover)] text-white font-bold"
                                : "bg-[var(--otzar-bg)] border-[var(--otzar-border-muted)] text-[var(--otzar-text-muted)]"
                            }`}
                          >
                            <span>מדף {shelfNum}</span>
                            {isTarget && <span className="text-xs">הספר נמצא כאן</span>}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>

              {book.tagsList?.length > 0 && (
                <div className="text-xs text-[var(--otzar-text-muted)] border-t border-[var(--otzar-border-muted)] pt-3">
                  <span className="font-semibold text-[var(--otzar-text)]">נושאים ותגיות חיפוש: </span>
                  {book.tagsList.join(" · ")}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
