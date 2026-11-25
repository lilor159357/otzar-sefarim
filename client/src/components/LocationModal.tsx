import React, { useEffect, useState, useRef } from "react";
import {
  X,
  MapPin,
  Layers,
  BookOpen,
  Pencil,
  Trash2,
  Save,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Library,
  Sparkles,
  Camera,
  RefreshCw,
  Image as ImageIcon,
  Check,
  Upload,
} from "lucide-react";
import type {
  BookRow,
  CabinetRow,
  MapEntrance,
  BookImageMeta,
  RoomDimensions,
  VolumeNotationRule,
} from "../types.ts";
import { FORMAT_SIZE_OPTIONS, STATUS_LABELS } from "../types.ts";
import { LibraryMap2D } from "./LibraryMap2D.tsx";
import { AutocompleteInput } from "./AutocompleteInput.tsx";
import {
  groupSetBySubSeries,
  type SetSubSeriesSection,
  type SetVolumeGroup,
} from "../lib/torahUtils.ts";
import { getAdminToken } from "../lib/adminSession.ts";

interface LocationModalProps {
  book: BookRow;
  cabinets: CabinetRow[];
  entrance?: MapEntrance;
  roomDimensions?: RoomDimensions;
  volumeNotationRules?: VolumeNotationRule[];
  isAdmin?: boolean;
  initialEditMode?: boolean;
  onBookUpdated?: () => Promise<void>;
  onSelectBarcode?: (barcode: string) => void;
  onClose: () => void;
}

export const LocationModal: React.FC<LocationModalProps> = ({
  book,
  cabinets,
  entrance,
  roomDimensions,
  volumeNotationRules,
  isAdmin = false,
  initialEditMode = false,
  onBookUpdated,
  onSelectBarcode,
  onClose,
}) => {
  const [editing, setEditing] = useState(isAdmin && initialEditMode);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const [title, setTitle] = useState(book.title);
  const [setName, setSetName] = useState(book.set_name || "");
  const [subSeries, setSubSeries] = useState(book.sub_series || "");
  const [setGlobalNumber, setSetGlobalNumber] = useState(
    book.set_global_number != null ? String(book.set_global_number) : ""
  );
  const [coverageRange, setCoverageRange] = useState(book.coverage_range || "");
  const [author, setAuthor] = useState(book.author || "");
  const [volume, setVolume] = useState(book.volume || "");
  const [publisher, setPublisher] = useState(book.publisher || "");
  const [pubYear, setPubYear] = useState(book.pub_year || "");
  const [edition, setEdition] = useState(book.edition || "");
  const [category, setCategory] = useState(book.category || "");
  const [tagsText, setTagsText] = useState((book.tagsList || []).join(", "));
  const [formatSize, setFormatSize] = useState(book.format_size || "");
  const [thicknessMm, setThicknessMm] = useState(book.thickness_mm != null ? String(book.thickness_mm) : "");
  const [pagesCount, setPagesCount] = useState(book.pages_count != null ? String(book.pages_count) : "");
  const [cabinetId, setCabinetId] = useState(book.cabinet_id ? String(book.cabinet_id) : "");
  const [shelfNumber, setShelfNumber] = useState(book.shelf_number ?? 1);
  const [status, setStatus] = useState<BookRow["status"]>(book.status);
  const [notes, setNotes] = useState(book.notes || "");
  const [setBooks, setSetBooks] = useState<BookRow[]>([]);
  const [loadingSet, setLoadingSet] = useState(false);
  const [expandedVol, setExpandedVol] = useState<string | null>(null);

  // 30-day saved images and AI Re-analysis
  const [savedImages, setSavedImages] = useState<BookImageMeta[]>([]);
  const [loadingImages, setLoadingImages] = useState(false);
  const [showAiReanalyze, setShowAiReanalyze] = useState(false);
  const [aiReanalyzing, setAiReanalyzing] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [saveExtraImages, setSaveExtraImages] = useState(true);
  const [extraFiles, setExtraFiles] = useState<Array<{ base64: string; mimeType: string; previewUrl: string }>>([]);
  const [proposedDiff, setProposedDiff] = useState<Array<{
    field: string;
    label: string;
    currentVal: string;
    proposedVal: string;
    selected: boolean;
  }> | null>(null);
  const [reanalyzeNotice, setReanalyzeNotice] = useState<string | null>(null);
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null);
  const extraFileInputRef = useRef<HTMLInputElement>(null);

  const loadSavedImages = async (barcode: string) => {
    try {
      setLoadingImages(true);
      const res = await fetch(`/api/books/${encodeURIComponent(barcode)}/images`);
      if (res.ok) {
        const data = await res.json();
        setSavedImages(Array.isArray(data.images) ? data.images : []);
      } else {
        setSavedImages([]);
      }
    } catch {
      setSavedImages([]);
    } finally {
      setLoadingImages(false);
    }
  };

  useEffect(() => {
    setTitle(book.title);
    setSetName(book.set_name || "");
    setSubSeries(book.sub_series || "");
    setSetGlobalNumber(book.set_global_number != null ? String(book.set_global_number) : "");
    setCoverageRange(book.coverage_range || "");
    setAuthor(book.author || "");
    setVolume(book.volume || "");
    setPublisher(book.publisher || "");
    setPubYear(book.pub_year || "");
    setEdition(book.edition || "");
    setCategory(book.category || "");
    setTagsText((book.tagsList || []).join(", "));
    setFormatSize(book.format_size || "");
    setThicknessMm(book.thickness_mm != null ? String(book.thickness_mm) : "");
    setPagesCount(book.pages_count != null ? String(book.pages_count) : "");
    setCabinetId(book.cabinet_id ? String(book.cabinet_id) : "");
    setShelfNumber(book.shelf_number ?? 1);
    setStatus(book.status);
    setNotes(book.notes || "");
    setEditing(isAdmin && initialEditMode);
    setConfirmDelete(false);
    setErrMsg(null);
    setSavedNotice(null);
    setExpandedVol((book.volume || "").trim() || null);
    setShowAiReanalyze(false);
    setProposedDiff(null);
    setReanalyzeNotice(null);
    setReanalyzeError(null);
    setExtraFiles([]);
    setAiPrompt("");
    loadSavedImages(book.barcode);
  }, [book.barcode, initialEditMode]);

  useEffect(() => {
    const sName = (book.set_name || "").trim();
    if (!sName) {
      setSetBooks([]);
      return;
    }
    let cancelled = false;
    setLoadingSet(true);
    fetch("/api/books/set/" + encodeURIComponent(sName))
      .then((r) => (r.ok ? r.json() : { books: [] }))
      .then((d) => {
        if (!cancelled) setSetBooks(Array.isArray(d?.books) ? d.books : []);
      })
      .catch(() => {
        if (!cancelled) setSetBooks([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingSet(false);
      });
    return () => {
      cancelled = true;
    };
  }, [book.set_name, book.barcode]);

  // Auto-pull set details in LocationModal edit mode
  const handlePullSetDetailsInEdit = async (targetSetName: string, overwrite = false) => {
    const q = targetSetName.trim();
    if (!q) return;
    try {
      const res = await fetch("/api/books/set-details?setName=" + encodeURIComponent(q));
      if (!res.ok) return;
      const data = await res.json();
      if (data.found && data.details) {
        const d = data.details;
        if (d.author) setAuthor((p) => (overwrite || !p.trim() ? d.author : p));
        if (d.publisher) setPublisher((p) => (overwrite || !p.trim() ? d.publisher : p));
        if (d.pub_year) setPubYear((p) => (overwrite || !p.trim() ? d.pub_year : p));
        if (d.edition) setEdition((p) => (overwrite || !p.trim() ? d.edition : p));
        if (d.category) setCategory((p) => (overwrite || !p.trim() || p === "ספרים" ? d.category : p));
        if (d.cabinet_id && (overwrite || !cabinetId)) setCabinetId(String(d.cabinet_id));
        if (d.shelf_number && overwrite) setShelfNumber(Number(d.shelf_number));
        if (Array.isArray(d.tags) && d.tags.length > 0) {
          setTagsText((prev) => {
            const cur = prev.split(",").map((x) => x.trim()).filter(Boolean);
            return Array.from(new Set([...d.tags, ...cur])).filter(Boolean).join(", ");
          });
        }
      }
    } catch {}
  };

  useEffect(() => {
    if (!editing) return;
    const q = setName.trim();
    if (!q || q === (book.set_name || "").trim()) return;
    const t = setTimeout(() => {
      void handlePullSetDetailsInEdit(q, false);
    }, 350);
    return () => clearTimeout(t);
  }, [setName, editing]);

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
          set_name: setName.trim(),
          sub_series: subSeries.trim() || null,
          set_global_number: setGlobalNumber.trim() ? Number(setGlobalNumber) : null,
          coverage_range: coverageRange.trim() || null,
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
          format_size: formatSize.trim(),
          thickness_mm: thicknessMm.trim() ? Number(thicknessMm) : null,
          pages_count: pagesCount.trim() ? Number(pagesCount) : null,
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

  const handleExtraFilesSelected = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    for (const f of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || "");
        const base64 = url.split(",")[1] || "";
        setExtraFiles((prev) => [
          ...prev,
          { base64, mimeType: f.type || "image/jpeg", previewUrl: url },
        ]);
      };
      reader.readAsDataURL(f);
    }
  };

  const handleAiReanalyze = async () => {
    try {
      setAiReanalyzing(true);
      setReanalyzeError(null);
      setReanalyzeNotice(null);
      setProposedDiff(null);

      const payload = {
        customPrompt: aiPrompt.trim(),
        extraImages: extraFiles.map((f) => ({
          imageBase64: f.base64,
          mimeType: f.mimeType,
        })),
        saveExtraImages,
      };

      const res = await fetch(`/api/books/${encodeURIComponent(book.barcode)}/ai-reanalyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בפענוח חוזר ע״י בינה");

      const prop = data.proposed || {};
      const fieldsToCheck: Array<{ field: string; label: string; cur: any; propVal: any }> = [
        { field: "title", label: "שם הספר", cur: title, propVal: prop.title },
        { field: "set_name", label: "שם הסט / סדרה", cur: setName, propVal: prop.set_name },
        { field: "sub_series", label: "תת-סדרה / מסכת", cur: subSeries, propVal: prop.sub_series },
        { field: "volume", label: "כרך / חלק", cur: volume, propVal: prop.volume },
        {
          field: "set_global_number",
          label: "מספר כרך כללי בסט",
          cur: setGlobalNumber,
          propVal: prop.set_global_number != null ? String(prop.set_global_number) : "",
        },
        { field: "coverage_range", label: "טווח סימנים / דפים", cur: coverageRange, propVal: prop.coverage_range },
        { field: "author", label: "מחבר", cur: author, propVal: prop.author },
        { field: "publisher", label: "הוצאה לאור", cur: publisher, propVal: prop.publisher },
        { field: "pub_year", label: "שנת הוצאה", cur: pubYear, propVal: prop.pub_year },
        { field: "edition", label: "מהדורה", cur: edition, propVal: prop.edition },
        { field: "category", label: "קטגוריה", cur: category, propVal: prop.category },
        { field: "format_size", label: "פורמט", cur: formatSize, propVal: prop.format_size },
        {
          field: "tags",
          label: "תגיות",
          cur: tagsText,
          propVal: Array.isArray(prop.tags) ? prop.tags.join(", ") : prop.tags,
        },
        { field: "notes", label: "הערות", cur: notes, propVal: prop.notes },
      ];

      const diffs = fieldsToCheck
        .filter((f) => {
          const c = String(f.cur || "").trim();
          const p = String(f.propVal || "").trim();
          return p && p !== c;
        })
        .map((f) => ({
          field: f.field,
          label: f.label,
          currentVal: String(f.cur || "").trim(),
          proposedVal: String(f.propVal || "").trim(),
          selected: true,
        }));

      if (diffs.length === 0) {
        setReanalyzeNotice("הבינה פענחה מחדש את התמונות — לא נמצאו שדות שונים מהערכים הנוכחיים.");
      } else {
        setProposedDiff(diffs);
        setReanalyzeNotice(`הבינה זיהתה ${diffs.length} הצעות עדכון. סמן את השינויים הרצויים ולחץ על 'החל שינויים'.`);
      }

      if (extraFiles.length > 0 && saveExtraImages) {
        loadSavedImages(book.barcode);
      }
    } catch (err: any) {
      setReanalyzeError(err?.message || "שגיאה בפענוח חוזר");
    } finally {
      setAiReanalyzing(false);
    }
  };

  const applyProposedDiff = () => {
    if (!proposedDiff) return;
    for (const d of proposedDiff) {
      if (!d.selected) continue;
      switch (d.field) {
        case "title":
          setTitle(d.proposedVal);
          break;
        case "set_name":
          setSetName(d.proposedVal);
          break;
        case "sub_series":
          setSubSeries(d.proposedVal);
          break;
        case "volume":
          setVolume(d.proposedVal);
          break;
        case "set_global_number":
          setSetGlobalNumber(d.proposedVal);
          break;
        case "coverage_range":
          setCoverageRange(d.proposedVal);
          break;
        case "author":
          setAuthor(d.proposedVal);
          break;
        case "publisher":
          setPublisher(d.proposedVal);
          break;
        case "pub_year":
          setPubYear(d.proposedVal);
          break;
        case "edition":
          setEdition(d.proposedVal);
          break;
        case "category":
          setCategory(d.proposedVal);
          break;
        case "format_size":
          setFormatSize(d.proposedVal);
          break;
        case "tags":
          setTagsText(d.proposedVal);
          break;
        case "notes":
          setNotes(d.proposedVal);
          break;
      }
    }
    setEditing(true);
    setShowAiReanalyze(false);
    setProposedDiff(null);
    setSavedNotice("הצעות הבינה הוחלו על טופס העריכה. לחץ 'שמור שינויים' כדי לשמור במאגר.");
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
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--otzar-text-muted)]">
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
              {book.format_size ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>פורמט: {book.format_size}</span>
                </>
              ) : null}
              {book.thickness_mm != null && book.thickness_mm > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">עובי: {book.thickness_mm} מ״מ</span>
                </>
              ) : null}
              {book.pages_count != null && book.pages_count > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{book.pages_count} עמ׳</span>
                </>
              ) : null}
            </div>
            <h2 className="text-xl font-bold">
              {book.title}
              {book.volume ? <span className="text-[var(--otzar-text-muted)] font-normal"> — {book.volume}</span> : null}
            </h2>
            <p className="text-sm text-[var(--otzar-text-muted)]">
              {book.set_name ? `סט: ${book.set_name} · ` : ""}
              {book.sub_series ? `תת-סדרה: ${book.sub_series} · ` : ""}
              {book.coverage_range ? `כיסוי: ${book.coverage_range} · ` : ""}
              {book.set_global_number != null ? `כרך כללי: #${book.set_global_number} · ` : ""}
              {book.author ? `מאת: ${book.author}` : "מחבר לא צוין"}
              {book.publisher ? ` · הוצאה: ${book.publisher}` : ""}
              {book.edition ? ` · מהדורה: ${book.edition}` : ""}
              {book.pub_year ? ` · שנת הוצאה: ${book.pub_year}` : ""}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => setShowAiReanalyze((v) => !v)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer ${
                    showAiReanalyze
                      ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)] text-[var(--otzar-accent)]"
                      : "border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)]"
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />
                  <span>ערוך מחדש ע״י בינה</span>
                </button>
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
              </>
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

          {/* AI RE-ANALYZE PANEL */}
          {showAiReanalyze && (
            <div className="p-4 rounded-xl border-2 border-[var(--otzar-accent)]/30 bg-[var(--otzar-surface)] space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold text-sm">
                  <Sparkles className="w-4 h-4 text-[var(--otzar-accent)]" />
                  <span>עריכה מחדש ע״י בינה (AI Re-analyze)</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAiReanalyze(false)}
                  className="text-xs text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] cursor-pointer"
                >
                  סגור פאנל
                </button>
              </div>

              {/* 30-day Saved Images Strip */}
              <div className="space-y-1.5">
                <div className="text-xs font-semibold flex items-center justify-between text-[var(--otzar-text-muted)]">
                  <span>תמונות שמורות במחשב (נשמרות אוטומטית ל-30 יום לצורך פענוח חוזר):</span>
                  <span className="tabular-nums">
                    {loadingImages ? "טוען..." : `${savedImages.length} תמונות זמינות`}
                  </span>
                </div>
                {savedImages.length > 0 ? (
                  <div className="flex items-center gap-2 overflow-x-auto py-1">
                    {savedImages.map((img) => (
                      <div
                        key={img.id}
                        className="relative group rounded-lg border border-[var(--otzar-border)] overflow-hidden bg-black/5 shrink-0"
                      >
                        <img
                          src={`/api/books/${encodeURIComponent(book.barcode)}/images/${img.id}?adminToken=${encodeURIComponent(getAdminToken())}`}
                          alt="צילום ספר שמור"
                          className="w-16 h-20 object-cover"
                        />
                        <div className="absolute inset-x-0 bottom-0 bg-black/70 text-white text-[9px] p-0.5 text-center tabular-nums">
                          נשארו {img.days_remaining} יום
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-[var(--otzar-text-muted)] italic">
                    לא נשמרו צילומים עבור ספר זה (הספר נוסף ידנית או שחלפו 30 יום מיום הפענוח). ניתן להעלות צילומים חדשים להלן.
                  </div>
                )}
              </div>

              {/* Upload Extra / Alternative Images */}
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-[var(--otzar-text-muted)]">
                  העלאת צילומים נוספים (דפי שער, שדרה, דף תוכן או כריכה חלופית):
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="file"
                    ref={extraFileInputRef}
                    multiple
                    accept="image/*"
                    onChange={(e) => handleExtraFilesSelected(e.target.files)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => extraFileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)] text-xs font-medium cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />
                    בחר קבצי תמונה נוספים
                  </button>
                  {extraFiles.length > 0 && (
                    <span className="text-xs text-[var(--otzar-accent)] font-semibold tabular-nums">
                      {extraFiles.length} תמונות חדשות צורפו
                    </span>
                  )}
                  {extraFiles.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setExtraFiles([])}
                      className="text-xs text-red-600 hover:underline cursor-pointer"
                    >
                      נקה תמונות חדשות
                    </button>
                  )}
                </div>
                {extraFiles.length > 0 && (
                  <div className="flex items-center gap-2 overflow-x-auto py-1">
                    {extraFiles.map((f, i) => (
                      <img
                        key={i}
                        src={f.previewUrl}
                        alt="תמונה חדשה"
                        className="w-14 h-18 object-cover rounded border border-[var(--otzar-border)]"
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Custom Prompt & Options */}
              <div className="space-y-2">
                <label className="block text-xs font-semibold">
                  הוראות מותאמות אישית לבינה (למשל: &quot;שים לב שזה כרך ב ולא א&quot;, &quot;זהה את טווח הסימנים המדויק&quot;, &quot;שם המחבר הנכון הוא...&quot;):
                </label>
                <input
                  type="text"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="הוראות מיוחדות ל-Gemini (אופציונלי)..."
                  className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs"
                />
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={saveExtraImages}
                      onChange={(e) => setSaveExtraImages(e.target.checked)}
                      className="accent-[var(--otzar-accent)]"
                    />
                    <span>שמור תמונות חדשות אלו מקומית ל-30 יום לצורך עריכות עתידיות</span>
                  </label>
                  <button
                    type="button"
                    disabled={aiReanalyzing || (savedImages.length === 0 && extraFiles.length === 0)}
                    onClick={handleAiReanalyze}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-50"
                  >
                    {aiReanalyzing ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>מפענח מחדש ע״י Gemini...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>בצע פענוח חוזר עכשיו</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {reanalyzeNotice && (
                <div className="p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-xs">
                  {reanalyzeNotice}
                </div>
              )}
              {reanalyzeError && (
                <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 text-xs">
                  {reanalyzeError}
                </div>
              )}

              {/* Proposed Diff Table */}
              {proposedDiff && proposedDiff.length > 0 && (
                <div className="rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] p-3 space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-bold">
                    <span>השוואת נתונים: קודם מול הצעת הבינה</span>
                    <button
                      type="button"
                      onClick={() =>
                        setProposedDiff((prev) =>
                          prev ? prev.map((d) => ({ ...d, selected: !prev.every((x) => x.selected) })) : null
                        )
                      }
                      className="text-[var(--otzar-accent)] hover:underline cursor-pointer"
                    >
                      בחר / בטל הכל
                    </button>
                  </div>
                  <div className="divide-y divide-[var(--otzar-border-muted)] text-xs">
                    {proposedDiff.map((d, idx) => (
                      <div key={d.field} className="py-2 flex items-center justify-between gap-3">
                        <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                          <input
                            type="checkbox"
                            checked={d.selected}
                            onChange={(e) =>
                              setProposedDiff((prev) =>
                                prev ? prev.map((x, i) => (i === idx ? { ...x, selected: e.target.checked } : x)) : null
                              )
                            }
                            className="accent-[var(--otzar-accent)]"
                          />
                          <span className="font-semibold text-[var(--otzar-text)] w-28 shrink-0">{d.label}:</span>
                          <span className="text-[var(--otzar-text-muted)] line-through truncate max-w-[140px]">
                            {d.currentVal || "(ריק)"}
                          </span>
                          <span className="text-[var(--otzar-accent)] font-bold truncate max-w-[200px]">
                            ← {d.proposedVal}
                          </span>
                        </label>
                      </div>
                    ))}
                  </div>
                  <div className="pt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={applyProposedDiff}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 cursor-pointer"
                    >
                      <Check className="w-4 h-4" />
                      החל שינויים מסומנים על טופס העריכה
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {editing ? (
            <form onSubmit={handleSave} className="space-y-4 text-sm">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-medium mb-1">שם הספר *</label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-semibold"
                  />
                </div>
                <AutocompleteInput
                  label="שם הסט / סדרה (אופציונלי)"
                  field="set_name"
                  value={setName}
                  onChange={setSetName}
                  placeholder="למשל: משנה ברורה / שולחן ערוך"
                  inputClassName="!bg-[var(--otzar-bg)] !border-[var(--otzar-border-muted)]"
                />
                <AutocompleteInput
                  label="תת-סדרה / מסכת / חלק ראשי בסט (אופציונלי)"
                  field="sub_series"
                  value={subSeries}
                  onChange={setSubSeries}
                  placeholder="למשל: אורח חיים / מסכת שבת"
                  inputClassName="!bg-[var(--otzar-bg)] !border-[var(--otzar-border-muted)]"
                />
                <div>
                  <label className="block text-xs font-medium mb-1">כרך / חלק / פורמט סימון</label>
                  <input
                    type="text"
                    value={volume}
                    onChange={(e) => setVolume(e.target.value)}
                    placeholder="למשל: חלק א׳ / ** / III / •"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">מספר כרך כללי בסדרה (אופציונלי)</label>
                  <input
                    type="number"
                    min={1}
                    value={setGlobalNumber}
                    onChange={(e) => setSetGlobalNumber(e.target.value)}
                    placeholder="למשל: 3 מתוך 50"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">טווח סימנים / דפים / פרקים (אופציונלי)</label>
                  <input
                    type="text"
                    value={coverageRange}
                    onChange={(e) => setCoverageRange(e.target.value)}
                    placeholder="למשל: סימנים א-קכז / דפים ב-מה / פרקים א-י"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
                <AutocompleteInput
                  label="מחבר / מפרש"
                  field="author"
                  value={author}
                  onChange={setAuthor}
                  inputClassName="!bg-[var(--otzar-bg)] !border-[var(--otzar-border-muted)]"
                />
                <AutocompleteInput
                  label="קטגוריה"
                  field="category"
                  value={category}
                  onChange={setCategory}
                  inputClassName="!bg-[var(--otzar-bg)] !border-[var(--otzar-border-muted)]"
                />
                <AutocompleteInput
                  label="הוצאה / מכון"
                  field="publisher"
                  value={publisher}
                  onChange={setPublisher}
                  inputClassName="!bg-[var(--otzar-bg)] !border-[var(--otzar-border-muted)]"
                />
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

                {/* Shelving dimensions */}
                <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">גודל / פורמט (למידוף)</label>
                    <input
                      list="otzar-format-sizes-modal"
                      value={formatSize}
                      onChange={(e) => setFormatSize(e.target.value)}
                      placeholder="רגיל / גדול / כיס"
                      className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                    />
                    <datalist id="otzar-format-sizes-modal">
                      {FORMAT_SIZE_OPTIONS.map((opt) => (
                        <option key={opt} value={opt} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">עובי שדרה (מ״מ)</label>
                    <input
                      type="number"
                      min={1}
                      max={300}
                      step="0.5"
                      value={thicknessMm}
                      onChange={(e) => setThicknessMm(e.target.value)}
                      placeholder="למשל: 32"
                      className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">מספר עמודים (אופציונלי)</label>
                    <input
                      type="number"
                      min={1}
                      max={10000}
                      value={pagesCount}
                      onChange={(e) => setPagesCount(e.target.value)}
                      placeholder="למשל: 420"
                      className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                    />
                  </div>
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
                    <span className="text-red-700 font-semibold">
                      הספר יועבר לסל המחזור ל-30 יום (וניתן לשחזרו בכל עת). להמשיך?
                    </span>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={handleDelete}
                      className="px-3 py-1.5 rounded-md bg-red-600 text-white font-semibold cursor-pointer"
                    >
                      כן, העבר לסל מחזור
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
                    מחק ספר מהמאגר (סל מחזור)
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
                  <LibraryMap2D
                    cabinets={cabinets}
                    highlightedCabinetId={cabinet?.id ?? null}
                    entrance={entrance}
                    roomDimensions={roomDimensions}
                  />
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

              {/* Set / Multi-Volume Section with Flexible Nested Sub-Series & Torah Sort */}
              {book.set_name && (
                <div className="rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] p-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      <Library className="w-4 h-4 text-[var(--otzar-accent)]" />
                      כרכים נוספים בסט &quot;{book.set_name}&quot;
                    </span>
                    <span className="text-xs text-[var(--otzar-text-muted)] tabular-nums">
                      {loadingSet ? "טוען..." : `${setBooks.length} עותקים בסך הכל`}
                    </span>
                  </div>
                  {!loadingSet && setBooks.length > 0 && (
                    <div className="rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] overflow-hidden divide-y divide-[var(--otzar-border-muted)]">
                      {groupSetBySubSeries(setBooks, volumeNotationRules).map((section: SetSubSeriesSection) => (
                        <div key={section.subSeriesLabel || "__default"} className="divide-y divide-[var(--otzar-border-muted)]">
                          {section.subSeriesLabel ? (
                            <div className="px-3.5 py-2 bg-[var(--otzar-surface)] text-xs font-bold text-[var(--otzar-accent)] flex items-center justify-between">
                              <span>תת-סדרה: {section.subSeriesLabel}</span>
                              <span className="text-[var(--otzar-text-muted)] font-normal tabular-nums">
                                {section.totalBooks} עותקים
                              </span>
                            </div>
                          ) : null}

                          {section.volumes.map((grp: SetVolumeGroup) => {
                            const isExpanded = expandedVol === grp.volumeLabel;
                            const isCurrentVol = grp.books.some((x) => x.barcode === book.barcode);
                            return (
                              <div key={grp.volumeLabel} className="text-xs">
                                <button
                                  type="button"
                                  onClick={() => setExpandedVol(isExpanded ? null : grp.volumeLabel)}
                                  className={`w-full px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-right hover:bg-[var(--otzar-surface)] cursor-pointer ${
                                    isCurrentVol ? "bg-[var(--otzar-surface)]/70" : ""
                                  }`}
                                >
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-bold text-sm text-[var(--otzar-text)]">
                                      {grp.volumeLabel}
                                      {grp.minGlobalNumber != null ? (
                                        <span className="text-xs font-normal text-[var(--otzar-text-muted)] mr-1">
                                          (#{grp.minGlobalNumber})
                                        </span>
                                      ) : null}
                                    </span>
                                    {grp.coverageSummary && (
                                      <>
                                        <span aria-hidden="true">·</span>
                                        <span className="text-[var(--otzar-accent)] font-medium">
                                          {grp.coverageSummary}
                                        </span>
                                      </>
                                    )}
                                    <span aria-hidden="true">·</span>
                                    <span className="font-medium tabular-nums">
                                      {grp.totalCopies} {grp.totalCopies === 1 ? "עותק" : "עותקים"} (
                                      <span className="text-emerald-700 dark:text-emerald-400">
                                        {grp.availableCount} זמינים
                                      </span>
                                      {grp.borrowedCount > 0 ? (
                                        <>
                                          {", "}
                                          <span className="text-red-700 dark:text-red-400">
                                            {grp.borrowedCount} מושאל
                                          </span>
                                        </>
                                      ) : null}
                                      )
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span className="text-[var(--otzar-text-muted)]">{grp.locationSummary}</span>
                                  </div>
                                  {isExpanded ? (
                                    <ChevronUp className="w-4 h-4 text-[var(--otzar-text-muted)]" />
                                  ) : (
                                    <ChevronDown className="w-4 h-4 text-[var(--otzar-text-muted)]" />
                                  )}
                                </button>
                                {isExpanded && (
                                  <div className="px-3.5 pb-2.5 pt-1 bg-[var(--otzar-surface-alt)]/50 space-y-1 border-t border-[var(--otzar-border-muted)]">
                                    {grp.books.map((copy) => {
                                      const isThis = copy.barcode === book.barcode;
                                      return (
                                        <div
                                          key={copy.barcode}
                                          className="flex flex-wrap items-center justify-between gap-2 py-1"
                                        >
                                          <div className="flex items-center gap-2">
                                            <span className="font-mono font-semibold text-[var(--otzar-accent)] tabular-nums">
                                              #{copy.barcode}
                                            </span>
                                            <span
                                              className={
                                                copy.status === "available"
                                                  ? "text-emerald-700 dark:text-emerald-400 font-medium"
                                                  : copy.status === "reference_only"
                                                  ? "text-amber-700 dark:text-amber-400 font-medium"
                                                  : "text-red-700 dark:text-red-400 font-medium"
                                              }
                                            >
                                              {STATUS_LABELS[copy.status] || copy.status}
                                            </span>
                                            <span className="text-[var(--otzar-text-muted)]">
                                              {copy.cabinet_code
                                                ? `ארון ${copy.cabinet_code} מדף ${copy.shelf_number ?? "-"}`
                                                : "לא שויך"}
                                            </span>
                                            {copy.coverage_range && (
                                              <span className="text-[var(--otzar-accent)] font-medium">
                                                ({copy.coverage_range})
                                              </span>
                                            )}
                                            {isThis && (
                                              <span className="text-[11px] font-semibold text-[var(--otzar-accent)]">
                                                (עותק מוצג)
                                              </span>
                                            )}
                                          </div>
                                          {!isThis && onSelectBarcode && (
                                            <button
                                              type="button"
                                              onClick={() => onSelectBarcode(copy.barcode)}
                                              className="px-2 py-0.5 rounded border border-[var(--otzar-border)] bg-[var(--otzar-bg)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-surface)] cursor-pointer"
                                            >
                                              הצג עותק
                                            </button>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

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
