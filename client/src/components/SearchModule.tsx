import React, { useMemo, useRef, useState } from "react";
import { Search, MapPin, Plus, CheckCircle2, X, BookOpen, Pencil, Barcode } from "lucide-react";
import type { BookRow, CabinetRow, MapEntrance } from "../types.ts";
import { STATUS_LABELS } from "../types.ts";
import { LocationModal } from "./LocationModal.tsx";

interface SearchModuleProps {
  books: BookRow[];
  cabinets: CabinetRow[];
  entrance?: MapEntrance;
  loading: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  statusFilter: string;
  onStatusFilterChange: (s: string) => void;
  categoryFilter: string;
  onCategoryFilterChange: (c: string) => void;
  semanticMode?: boolean;
  onSemanticModeChange?: (v: boolean) => void;
  semanticNotice?: string | null;
  isAdmin?: boolean;
  onReload: () => Promise<void>;
}

export const SearchModule: React.FC<SearchModuleProps> = ({
  books,
  cabinets,
  entrance,
  loading,
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  categoryFilter,
  onCategoryFilterChange,
  semanticMode = false,
  onSemanticModeChange,
  semanticNotice,
  isAdmin = false,
  onReload,
}) => {
  const [selectedBarcode, setSelectedBarcode] = useState<string | null>(null);
  const [openInEditMode, setOpenInEditMode] = useState(false);
  const selectedBook = books.find((b) => b.barcode === selectedBarcode) || null;
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Quick Add state
  const [newTitle, setNewTitle] = useState("");
  const [newAuthor, setNewAuthor] = useState("");
  const [newCategory, setNewCategory] = useState("הלכה");
  const [newCabinetId, setNewCabinetId] = useState(() => (cabinets[0] ? String(cabinets[0].id) : ""));
  const [newShelf, setNewShelf] = useState("1");
  const [newCopies, setNewCopies] = useState("1");
  const [savingBook, setSavingBook] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const handleAssignOfficialBarcode = async (oldBarcode: string) => {
    setSaveNotice(null);
    const res = await fetch(`/api/books/${encodeURIComponent(oldBarcode)}/assign-official-barcode`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setSaveNotice(`הוקצה ברקוד רשמי ${data.newBarcode} והספר נוסף לתור הדפסת המדבקות.`);
      await onReload();
    } else {
      setSaveNotice(data.error || "שגיאה בהקצאת ברקוד רשמי");
    }
  };

  const categories = useMemo(() => {
    const set = new Set<string>();
    books.forEach((b) => {
      if (b.category) set.add(b.category);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "he"));
  }, [books]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && books.length === 1) {
      setOpenInEditMode(false);
      setSelectedBarcode(books[0].barcode);
    }
  };

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setSavingBook(true);
    setSaveNotice(null);
    try {
      const res = await fetch("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim(),
          author: newAuthor.trim(),
          category: newCategory.trim(),
          cabinet_id: newCabinetId ? Number(newCabinetId) : cabinets[0]?.id ?? null,
          shelf_number: newShelf ? Number(newShelf) : 1,
          copiesCount: Number(newCopies) || 1,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בשמירה");
      setNewTitle("");
      setNewAuthor("");
      setNewCopies("1");
      setSaveNotice("נוצרו ברקודים: " + data.barcodes.join(", "));
      await onReload();
    } finally {
      setSavingBook(false);
    }
  };

  return (
    <div className="space-y-5 max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">חיפוש ואיתור ספרים באוצר הספרים</h1>
          <p className="text-sm text-[var(--otzar-text-muted)] mt-0.5">
            תומך בראשי תיבות תורניים (שו״ע, רמב״ם, משנ״ב, ש״ס), כתיב מלא/חסר, סריקת ברקוד ואיתור במפה דו-ממדית.
          </p>
        </div>

        {isAdmin && (
          <button
            type="button"
            onClick={() => setShowQuickAdd((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-[var(--otzar-border)] bg-[var(--otzar-surface)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-soft)] cursor-pointer whitespace-nowrap shrink-0"
          >
            {showQuickAdd ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {showQuickAdd ? "סגור הוספה מהירה" : "הוספת ספר מהירה"}
          </button>
        )}
      </div>

      {/* Search & Filters Bar */}
      <div className="p-4 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] space-y-3">
        <div className="relative">
          <Search className="w-5 h-5 text-[var(--otzar-text-muted)] absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={searchInputRef}
            type="text"
            autoFocus
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="חפש לפי שם ספר, מחבר, ר״ת תורניים (שו״ע, משנ״ב, רמב״ם), נושא, כרך או סרוק ברקוד..."
            className="w-full pr-11 pl-10 py-3 text-base rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] focus:outline-none focus:border-[var(--otzar-accent)]"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                onSearchChange("");
                searchInputRef.current?.focus();
              }}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] cursor-pointer"
            >
              נקה
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Status segmented filter */}
          <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--otzar-bg)] border border-[var(--otzar-border-muted)]">
            {[
              { id: "all", label: "הכל" },
              { id: "available", label: "זמין בלבד" },
              { id: "borrowed", label: "מושאל" },
              { id: "reference_only", label: "לעיון בלבד" },
            ].map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => onStatusFilterChange(st.id)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  statusFilter === st.id
                    ? "bg-[var(--otzar-accent)] text-white"
                    : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                }`}
              >
                {st.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            {onSemanticModeChange && (
              <button
                type="button"
                onClick={() => onSemanticModeChange(!semanticMode)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium border cursor-pointer transition-colors ${
                  semanticMode
                    ? "bg-[var(--otzar-accent)] border-[var(--otzar-accent)] text-white"
                    : "bg-[var(--otzar-bg)] border-[var(--otzar-border-muted)] text-[var(--otzar-text-muted)] hover:border-[var(--otzar-accent)]"
                }`}
              >
                <BookOpen className="w-3.5 h-3.5" />
                חיפוש לפי הקשר ומשמעות
              </button>
            )}
            <select
              value={categoryFilter}
              onChange={(e) => onCategoryFilterChange(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs"
            >
              <option value="all">כל הקטגוריות</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>

            <span className="text-[var(--otzar-text-muted)] tabular-nums">
              מציג <strong className="text-[var(--otzar-text)]">{books.length}</strong> ספרים
            </span>
          </div>
        </div>
        {semanticNotice && (
          <div className="text-xs px-3 py-1.5 rounded-lg bg-[var(--otzar-surface)] border border-[var(--otzar-border)] text-[var(--otzar-text-muted)]">
            {semanticNotice}
          </div>
        )}
      </div>

      {isAdmin && showQuickAdd && (
        <form
          onSubmit={handleQuickAdd}
          className="p-4 rounded-xl border border-[var(--otzar-border)] bg-[var(--otzar-surface)] grid grid-cols-1 md:grid-cols-6 gap-3 items-end"
        >
          <div className="md:col-span-2">
            <label className="block text-xs font-medium mb-1">שם הספר</label>
            <input
              type="text"
              required
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="למשל: קצות החושן - חלק א׳"
              className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">מחבר</label>
            <input
              type="text"
              value={newAuthor}
              onChange={(e) => setNewAuthor(e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">ארון / מדף</label>
            <div className="flex gap-1.5">
              <select
                value={newCabinetId || cabinets[0]?.id || ""}
                onChange={(e) => setNewCabinetId(e.target.value)}
                className="flex-1 px-2 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              >
                {cabinets.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                max={20}
                value={newShelf}
                onChange={(e) => setNewShelf(e.target.value)}
                className="w-14 px-2 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">עותקים זהים</label>
            <input
              type="number"
              min={1}
              max={100}
              value={newCopies}
              onChange={(e) => setNewCopies(e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
            />
          </div>
          <div>
            <button
              type="submit"
              disabled={savingBook}
              className="w-full px-4 py-1.5 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
            >
              {savingBook ? "שומר..." : "שמור"}
            </button>
          </div>
        </form>
      )}

      {saveNotice && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-sm">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{saveNotice}</span>
        </div>
      )}

      {/* Results Table */}
      <div className="rounded-xl border border-[var(--otzar-border-muted)] overflow-hidden bg-[var(--otzar-bg)]">
        <table className="w-full text-sm text-right border-collapse">
          <thead className="bg-[var(--otzar-surface-alt)] border-b border-[var(--otzar-border-muted)] text-[var(--otzar-text-muted)] text-xs">
            <tr>
              <th className="py-2.5 px-4 font-semibold">ברקוד</th>
              <th className="py-2.5 px-4 font-semibold">שם הספר</th>
              <th className="py-2.5 px-4 font-semibold">מחבר</th>
              <th className="py-2.5 px-4 font-semibold">מיקום</th>
              <th className="py-2.5 px-4 font-semibold">זמינות</th>
              <th className="py-2.5 px-4 font-semibold text-left">מפה</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--otzar-border-muted)]">
            {loading ? (
              <tr>
                <td colSpan={6} className="py-10 text-center text-[var(--otzar-text-muted)]">
                  מחפש במאגר המקומי...
                </td>
              </tr>
            ) : books.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-10 text-center text-[var(--otzar-text-muted)]">
                  לא נמצאו ספרים התואמים לחיפוש &quot;{searchQuery}&quot;. נסה לקצר מילים או להחליף סינון.
                </td>
              </tr>
            ) : (
              books.map((b) => (
                <tr
                  key={b.barcode}
                  onClick={() => { setOpenInEditMode(false); setSelectedBarcode(b.barcode); }}
                  className="hover:bg-[var(--otzar-surface)] transition-colors cursor-pointer"
                >
                  <td className="py-3 px-4 font-mono tabular-nums font-medium">
                    <div>{b.barcode}</div>
                    {b.barcode_status === "pending_barcode" && (
                      <div className="text-[11px] font-sans text-amber-700 dark:text-amber-400 font-medium">ממתין לברקוד רשמי</div>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-semibold">
                      {b.title}
                      {b.volume ? <span className="text-[var(--otzar-text-muted)] font-normal"> · {b.volume}</span> : null}
                    </div>
                    <div className="text-xs text-[var(--otzar-text-muted)] mt-0.5 tabular-nums">
                      {b.set_name ? `סט: ${b.set_name} · ` : ""}
                      {b.category || "כללי"}
                      {b.edition ? ` · מהדורה: ${b.edition}` : ""}
                      {b.pub_year ? ` · שנת הוצאה: ${b.pub_year}` : ""}
                      {b.format_size ? ` · ${b.format_size}` : ""}
                      {b.thickness_mm != null && b.thickness_mm > 0 ? ` · ${b.thickness_mm} מ״מ` : ""}
                      {b.matchHint ? ` · התאמה: ${b.matchHint}` : ""}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-[var(--otzar-text-muted)]">{b.author || "—"}</td>
                  <td className="py-3 px-4 tabular-nums">
                    {b.cabinet_code ? `ארון ${b.cabinet_code} · מדף ${b.shelf_number ?? "-"}` : "לא שויך"}
                  </td>
                  <td className="py-3 px-4 font-semibold whitespace-nowrap">
                    <span
                      className={
                        b.status === "available"
                          ? "text-emerald-700 dark:text-emerald-400"
                          : b.status === "reference_only"
                          ? "text-amber-700 dark:text-amber-400"
                          : "text-red-700 dark:text-red-400"
                      }
                    >
                      {STATUS_LABELS[b.status] || b.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-left">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenInEditMode(false);
                          setSelectedBarcode(b.barcode);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border border-[var(--otzar-border)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-surface)] cursor-pointer whitespace-nowrap"
                      >
                        <MapPin className="w-3.5 h-3.5" />
                        אתר במפה
                      </button>
                      {isAdmin && b.barcode_status === "pending_barcode" && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleAssignOfficialBarcode(b.barcode);
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium border border-amber-400 text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 cursor-pointer whitespace-nowrap"
                          title="הקצה ברקוד סדרתי רשמי ושלח להדפסת מדבקות"
                        >
                          <Barcode className="w-3.5 h-3.5" />
                          הקצה ברקוד
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenInEditMode(true);
                            setSelectedBarcode(b.barcode);
                          }}
                          className="p-1.5 rounded-md border border-[var(--otzar-border-muted)] text-[var(--otzar-text-muted)] hover:text-[var(--otzar-accent)] hover:bg-[var(--otzar-surface)] cursor-pointer"
                          title="ערוך או מחק ספר"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selectedBook && (
        <LocationModal
          book={selectedBook}
          cabinets={cabinets}
          entrance={entrance}
          isAdmin={isAdmin}
          initialEditMode={isAdmin && openInEditMode}
          onBookUpdated={onReload}
          onSelectBarcode={(bc) => {
            setOpenInEditMode(false);
            setSelectedBarcode(bc);
          }}
          onClose={() => {
            setSelectedBarcode(null);
            setOpenInEditMode(false);
          }}
        />
      )}
    </div>
  );
};
