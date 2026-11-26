import React, { useEffect, useMemo, useRef, useState } from "react";

import {

  Search,

  MapPin,

  Plus,

  CheckCircle2,

  X,

  BookOpen,

  Pencil,

  Barcode,

  ArrowUpDown,
  ArrowUp,
  ArrowDown,

  Filter,

  Send,

  Layers,

  CheckSquare,

  RotateCcw,

  SlidersHorizontal,

  AlertCircle,

} from "lucide-react";

import type {

  BookRow,

  CabinetRow,

  MapEntrance,

  RoomDimensions,

  VolumeNotationRule,

} from "../types.ts";

import { FORMAT_SIZE_OPTIONS, STATUS_LABELS } from "../types.ts";

import { LocationModal } from "./LocationModal.tsx";

import { AutocompleteInput } from "./AutocompleteInput.tsx";

import { useStrings } from "../lib/stringsContext.tsx";

import {

  compareCatalogBooks,

  computeMissingSetSlots,

  shouldSuppressSingleVolumeLabel,

} from "../lib/torahUtils.ts";



interface SearchModuleProps {

  books: BookRow[];

  cabinets: CabinetRow[];

  entrance?: MapEntrance;

  roomDimensions?: RoomDimensions;

  volumeNotationRules?: VolumeNotationRule[];

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



const SORT_STORAGE_KEY = "otzar_desktop_search_sort_v1";



export const SearchModule: React.FC<SearchModuleProps> = ({

  books,

  cabinets,

  entrance,

  roomDimensions,

  volumeNotationRules,

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

  const { t } = useStrings();

  const [selectedBarcode, setSelectedBarcode] = useState<string | null>(null);

  const [openInEditMode, setOpenInEditMode] = useState(false);



  const [sortBy, setSortBy] = useState<string>(() => {

    try {

      return localStorage.getItem(SORT_STORAGE_KEY) || "torah_order";

    } catch {

      return "torah_order";

    }

  });

  useEffect(() => {

    try {

      localStorage.setItem(SORT_STORAGE_KEY, sortBy);

    } catch {}

  }, [sortBy]);



  // Sidebar Filters

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);

  const [cabinetFilter, setCabinetFilter] = useState<string>("all");

  const [shelfFilter, setShelfFilter] = useState<string>("all");

  const [setTypeFilter, setSetTypeFilter] = useState<string>("all");

  const [specificSetFilter, setSpecificSetFilter] = useState<string>("all");

  const [missingSetOnly, setMissingSetOnly] = useState<boolean>(false);

  const [authorFilter, setAuthorFilter] = useState<string>("all");

  const [publisherFilter, setPublisherFilter] = useState<string>("all");

  const [formatFilter, setFormatFilter] = useState<string>("all");

  const [ignoredMissingKeys, setIgnoredMissingKeys] = useState<Set<string>>(new Set());



  useEffect(() => {

    fetch("/api/settings")

      .then((r) => (r.ok ? r.json() : null))

      .then((d) => {

        if (d && Array.isArray(d.ignored_missing_volumes)) {

          setIgnoredMissingKeys(

            new Set(d.ignored_missing_volumes.map((x: unknown) => String(x || "").trim()).filter(Boolean))

          );

        }

      })

      .catch(() => {});

  }, [books.length]);



  const booksBySetMap = useMemo(() => {

    const map = new Map<string, BookRow[]>();

    for (const b of books) {

      const s = (b.set_name || "").trim();

      if (!s) continue;

      const arr = map.get(s) || [];

      arr.push(b);

      map.set(s, arr);

    }

    return map;

  }, [books]);



  const setsWithMissingSet = useMemo(() => {

    const setNamesWithGaps = new Set<string>();

    for (const [sName, list] of booksBySetMap.entries()) {

      const slots = computeMissingSetSlots(list, sName, ignoredMissingKeys);

      if (slots.some((sl) => !sl.ignored)) {

        setNamesWithGaps.add(sName);

      }

    }

    return setNamesWithGaps;

  }, [booksBySetMap, ignoredMissingKeys]);



  const setNames = useMemo(

    () => Array.from(booksBySetMap.keys()).sort((a, b) => a.localeCompare(b, "he")),

    [booksBySetMap]

  );



  const authorsList = useMemo(() => {

    const s = new Set<string>();

    books.forEach((b) => {

      const a = (b.author || "").trim();

      if (a) s.add(a);

    });

    return Array.from(s).sort((a, b) => a.localeCompare(b, "he"));

  }, [books]);



  const publishersList = useMemo(() => {

    const s = new Set<string>();

    books.forEach((b) => {

      const p = (b.publisher || "").trim();

      if (p) s.add(p);

    });

    return Array.from(s).sort((a, b) => a.localeCompare(b, "he"));

  }, [books]);



  const formatsList = useMemo(() => {

    const s = new Set<string>();

    books.forEach((b) => {

      const f = (b.format_size || "").trim();

      if (f) s.add(f);

    });

    return Array.from(s).sort((a, b) => a.localeCompare(b, "he"));

  }, [books]);



  const categories = useMemo(() => {

    const set = new Set<string>();

    books.forEach((b) => {

      if (b.category) set.add(b.category);

    });

    return Array.from(set).sort((a, b) => a.localeCompare(b, "he"));

  }, [books]);



  const selectedFilterCabinet = useMemo(

    () => (cabinetFilter !== "all" && cabinetFilter !== "unassigned" ? cabinets.find((c) => String(c.id) === cabinetFilter) || null : null),

    [cabinets, cabinetFilter]

  );



  const activeFilterCount = useMemo(() => {

    let n = 0;

    if (statusFilter !== "all") n++;

    if (categoryFilter !== "all") n++;

    if (cabinetFilter !== "all") n++;

    if (shelfFilter !== "all") n++;

    if (setTypeFilter !== "all") n++;

    if (specificSetFilter !== "all") n++;

    if (missingSetOnly) n++;

    if (authorFilter !== "all") n++;

    if (publisherFilter !== "all") n++;

    if (formatFilter !== "all") n++;

    return n;

  }, [

    statusFilter,

    categoryFilter,

    cabinetFilter,

    shelfFilter,

    setTypeFilter,

    specificSetFilter,

    missingSetOnly,

    authorFilter,

    publisherFilter,

    formatFilter,

  ]);



  const resetAllFilters = () => {

    onStatusFilterChange("all");

    onCategoryFilterChange("all");

    setCabinetFilter("all");

    setShelfFilter("all");

    setSetTypeFilter("all");

    setSpecificSetFilter("all");

    setMissingSetOnly(false);

    setAuthorFilter("all");

    setPublisherFilter("all");

    setFormatFilter("all");

  };



  const displayBooks = useMemo(() => {

    let list = [...books];



    if (cabinetFilter === "unassigned") {

      list = list.filter((b) => !b.cabinet_id);

    } else if (cabinetFilter !== "all") {

      list = list.filter((b) => String(b.cabinet_id) === cabinetFilter);

      if (shelfFilter !== "all") {

        list = list.filter((b) => String(b.shelf_number ?? "") === shelfFilter);

      }

    }



    if (setTypeFilter === "set_only") {

      list = list.filter((b) => Boolean(b.set_name?.trim()));

    } else if (setTypeFilter === "single_only") {

      list = list.filter((b) => !b.set_name?.trim());

    }



    if (specificSetFilter !== "all") {

      list = list.filter((b) => (b.set_name || "").trim() === specificSetFilter);

    }



    if (missingSetOnly) {

      list = list.filter((b) => {

        const s = (b.set_name || "").trim();

        return Boolean(s && setsWithMissingSet.has(s));

      });

    }



    if (authorFilter !== "all") {

      list = list.filter((b) => (b.author || "").trim() === authorFilter);

    }

    if (publisherFilter !== "all") {

      list = list.filter((b) => (b.publisher || "").trim() === publisherFilter);

    }

    if (formatFilter !== "all") {

      list = list.filter((b) => (b.format_size || "").trim() === formatFilter);

    }



    if (sortBy === "relevance" && searchQuery.trim()) {

      return list;

    }



    list.sort((a, b) => {

      switch (sortBy) {

        case "torah_order":

          return compareCatalogBooks(a, b, volumeNotationRules);

        case "title_asc":

          return (a.title || "").localeCompare(b.title || "", "he");

        case "title_desc":

          return (b.title || "").localeCompare(a.title || "", "he");

        case "author_asc":

          return (a.author || "").localeCompare(b.author || "", "he");

        case "publisher_asc":

          return (a.publisher || "").localeCompare(b.publisher || "", "he");

        case "year_desc":

          return (b.pub_year || "").localeCompare(a.pub_year || "", "he");

        case "year_asc":

          return (a.pub_year || "").localeCompare(b.pub_year || "", "he");

        case "barcode_asc":

          return (a.barcode || "").localeCompare(b.barcode || "");

        case "location_asc": {

          const cabA = a.cabinet_code || "תתת";

          const cabB = b.cabinet_code || "תתת";

          if (cabA !== cabB) return cabA.localeCompare(cabB, "he");

          const sA = a.shelf_number ?? 999;

          const sB = b.shelf_number ?? 999;

          if (sA !== sB) return sA - sB;

          return compareCatalogBooks(a, b, volumeNotationRules);

        }

        case "recent_desc":

          return (b.created_at || "").localeCompare(a.created_at || "");

        default:

          return compareCatalogBooks(a, b, volumeNotationRules);

      }

    });

    return list;

  }, [

    books,

    cabinetFilter,

    shelfFilter,

    setTypeFilter,

    specificSetFilter,

    missingSetOnly,

    setsWithMissingSet,

    authorFilter,

    publisherFilter,

    formatFilter,

    sortBy,

    searchQuery,

    volumeNotationRules,

  ]);



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

  const [saveError, setSaveError] = useState<string | null>(null);



  // Multi-select & Quick Shelf Assign & Bulk Edit

  const [selectedBarcodes, setSelectedBarcodes] = useState<string[]>([]);

  const lastClickedIndexRef = useRef<number | null>(null);

  const selectedSet = useMemo(() => new Set(selectedBarcodes), [selectedBarcodes]);



  const [quickShelfCabId, setQuickShelfCabId] = useState<string>(() => (cabinets[0] ? String(cabinets[0].id) : ""));

  const [quickShelfNum, setQuickShelfNum] = useState<number>(1);

  const [applyingBulk, setApplyingBulk] = useState(false);



  // Bulk Edit Modal State (selective opt-in per field)

  const [showBulkModal, setShowBulkModal] = useState(false);

  const [bulkEnabled, setBulkEnabled] = useState<Record<string, boolean>>({});

  const [bulkTitle, setBulkTitle] = useState("");

  const [bulkSetName, setBulkSetName] = useState("");

  const [bulkSubSeries, setBulkSubSeries] = useState("");

  const [bulkSetGlobalNum, setBulkSetGlobalNum] = useState("");

  const [bulkVolume, setBulkVolume] = useState("");

  const [bulkCoverage, setBulkCoverage] = useState("");

  const [bulkAuthor, setBulkAuthor] = useState("");

  const [bulkPublisher, setBulkPublisher] = useState("");

  const [bulkPubYear, setBulkPubYear] = useState("");

  const [bulkEdition, setBulkEdition] = useState("");

  const [bulkCategory, setBulkCategory] = useState("");

  const [bulkFormatSize, setBulkFormatSize] = useState("");

  const [bulkThicknessMm, setBulkThicknessMm] = useState("");

  const [bulkPagesCount, setBulkPagesCount] = useState("");

  const [bulkStatus, setBulkStatus] = useState<"available" | "reference_only" | "lost">("available");

  const [bulkCabinetId, setBulkCabinetId] = useState("");

  const [bulkShelfNumber, setBulkShelfNumber] = useState<number>(1);

  const [bulkTags, setBulkTags] = useState("");

  const [bulkTagsMode, setBulkTagsMode] = useState<"merge" | "replace">("merge");

  const [bulkNotes, setBulkNotes] = useState("");



  useEffect(() => {

    if (!quickShelfCabId && cabinets[0]) {

      setQuickShelfCabId(String(cabinets[0].id));

    }

  }, [cabinets, quickShelfCabId]);



  const quickShelfCabinet = cabinets.find((c) => String(c.id) === quickShelfCabId) || null;

  const quickShelfMax = quickShelfCabinet?.shelves_count || 10;



  const bulkCabinet = cabinets.find((c) => String(c.id) === bulkCabinetId) || null;

  const bulkShelfMax = bulkCabinet?.shelves_count || 15;



  // Prune selection if books vanish

  useEffect(() => {

    const valid = new Set(books.map((b) => b.barcode));

    setSelectedBarcodes((prev) => {

      const next = prev.filter((bc) => valid.has(bc));

      return next.length === prev.length ? prev : next;

    });

  }, [books]);



  const toggleRowSelection = (barcode: string, index: number, shiftKey: boolean) => {

    if (shiftKey && lastClickedIndexRef.current !== null && lastClickedIndexRef.current !== index) {

      const start = Math.min(lastClickedIndexRef.current, index);

      const end = Math.max(lastClickedIndexRef.current, index);

      const rangeBarcodes = displayBooks.slice(start, end + 1).map((b) => b.barcode);

      setSelectedBarcodes((prev) => Array.from(new Set([...prev, ...rangeBarcodes])));

    } else {

      setSelectedBarcodes((prev) =>

        prev.includes(barcode) ? prev.filter((x) => x !== barcode) : [...prev, barcode]

      );

    }

    lastClickedIndexRef.current = index;

  };



  const allDisplaySelected =

    displayBooks.length > 0 && displayBooks.every((b) => selectedSet.has(b.barcode));



  const toggleSelectAllInView = () => {

    if (allDisplaySelected) {

      const displaySet = new Set(displayBooks.map((b) => b.barcode));

      setSelectedBarcodes((prev) => prev.filter((bc) => !displaySet.has(bc)));

    } else {

      const allView = displayBooks.map((b) => b.barcode);

      setSelectedBarcodes((prev) => Array.from(new Set([...prev, ...allView])));

    }

  };



  const handleQuickAssignShelfBulk = async () => {

    if (!isAdmin || selectedBarcodes.length === 0 || !quickShelfCabId) return;

    setApplyingBulk(true);

    setSaveNotice(null);

    setSaveError(null);

    try {

      const cab = cabinets.find((c) => String(c.id) === quickShelfCabId);

      const res = await fetch("/api/books/bulk-update", {

        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({

          barcodes: selectedBarcodes,

          fields: {

            cabinet_id: Number(quickShelfCabId),

            shelf_number: quickShelfNum,

          },

        }),

      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(data.error || "שגיאה בשיבוץ למדף");

      setSaveNotice(

        `${data.updatedCount || selectedBarcodes.length} ספרים שובצו לארון ${cab?.code || ""} · מדף ${quickShelfNum}.${

          cab?.id ? "" : ""

        }`

      );

      await onReload();

    } catch (err: any) {

      setSaveError(err?.message || "שגיאה בשיבוץ למדף");

    } finally {

      setApplyingBulk(false);

    }

  };



  const handleBulkSendToQueue = async () => {

    if (!isAdmin || selectedBarcodes.length === 0) return;

    setApplyingBulk(true);

    setSaveNotice(null);

    setSaveError(null);

    try {

      const res = await fetch("/api/books/bulk-send-to-queue", {

        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({

          barcodes: selectedBarcodes,

          autoProcess: true,

        }),

      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(data.error || "שגיאה בשליחה לתור ה-AI");

      setSaveNotice(

        `${data.count || selectedBarcodes.length} ספרים נשלחו לתור קטלוג ה-AI לעיבוד ואישור מחדש (הברקוד ומצב המדבקה נשמרים).`

      );

      setSelectedBarcodes([]);

      await onReload();

    } catch (err: any) {

      setSaveError(err?.message || "שגיאה בשליחה לתור ה-AI");

    } finally {

      setApplyingBulk(false);

    }

  };



  const openBulkEditModal = () => {

    setBulkEnabled({});

    const firstSelected = books.find((b) => selectedSet.has(b.barcode));

    setBulkTitle("");

    setBulkSetName(firstSelected?.set_name || "");

    setBulkSubSeries(firstSelected?.sub_series || "");

    setBulkSetGlobalNum("");

    setBulkVolume("");

    setBulkCoverage("");

    setBulkAuthor(firstSelected?.author || "");

    setBulkPublisher(firstSelected?.publisher || "");

    setBulkPubYear(firstSelected?.pub_year || "");

    setBulkEdition(firstSelected?.edition || "");

    setBulkCategory(firstSelected?.category || "");

    setBulkFormatSize(firstSelected?.format_size || "");

    setBulkThicknessMm("");

    setBulkPagesCount("");

    setBulkStatus("available");

    setBulkCabinetId(firstSelected?.cabinet_id ? String(firstSelected.cabinet_id) : cabinets[0] ? String(cabinets[0].id) : "");

    setBulkShelfNumber(firstSelected?.shelf_number ?? 1);

    setBulkTags("");

    setBulkTagsMode("merge");

    setBulkNotes("");

    setShowBulkModal(true);

  };



  const enabledBulkFieldCount = Object.values(bulkEnabled).filter(Boolean).length;



  const handleBulkModalSubmit = async (e: React.FormEvent) => {

    e.preventDefault();

    if (selectedBarcodes.length === 0 || enabledBulkFieldCount === 0) return;



    const fields: Record<string, any> = {};

    if (bulkEnabled.title && bulkTitle.trim()) fields.title = bulkTitle.trim();

    if (bulkEnabled.set_name) fields.set_name = bulkSetName.trim();

    if (bulkEnabled.sub_series) fields.sub_series = bulkSubSeries.trim();

    if (bulkEnabled.set_global_number) {

      fields.set_global_number = bulkSetGlobalNum.trim() ? Number(bulkSetGlobalNum) : null;

    }

    if (bulkEnabled.volume) fields.volume = bulkVolume.trim();

    if (bulkEnabled.coverage_range) fields.coverage_range = bulkCoverage.trim();

    if (bulkEnabled.author) fields.author = bulkAuthor.trim();

    if (bulkEnabled.publisher) fields.publisher = bulkPublisher.trim();

    if (bulkEnabled.pub_year) fields.pub_year = bulkPubYear.trim();

    if (bulkEnabled.edition) fields.edition = bulkEdition.trim();

    if (bulkEnabled.category) fields.category = bulkCategory.trim();

    if (bulkEnabled.format_size) fields.format_size = bulkFormatSize.trim();

    if (bulkEnabled.thickness_mm) {

      fields.thickness_mm = bulkThicknessMm.trim() ? Number(bulkThicknessMm) : null;

    }

    if (bulkEnabled.pages_count) {

      fields.pages_count = bulkPagesCount.trim() ? Number(bulkPagesCount) : null;

    }

    if (bulkEnabled.status) fields.status = bulkStatus;

    if (bulkEnabled.location) {

      fields.cabinet_id = bulkCabinetId ? Number(bulkCabinetId) : null;

      fields.shelf_number = bulkCabinetId ? bulkShelfNumber : null;

    }

    if (bulkEnabled.tags) {

      fields.tags = bulkTags

        .split(",")

        .map((x) => x.trim())

        .filter(Boolean);

    }

    if (bulkEnabled.notes) fields.notes = bulkNotes.trim();



    if (Object.keys(fields).length === 0) {

      setSaveError("לא נבחר אף שדה תקין לעדכון");

      return;

    }



    setApplyingBulk(true);

    setSaveError(null);

    setSaveNotice(null);

    try {

      const res = await fetch("/api/books/bulk-update", {

        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({

          barcodes: selectedBarcodes,

          fields,

          tagsMode: bulkTagsMode,

        }),

      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(data.error || "שגיאה בעדכון קבוצתי");

      setShowBulkModal(false);

      setSaveNotice(

        `עודכנו ${Object.keys(fields).length} שדות על ${data.updatedCount || selectedBarcodes.length} ספרים נבחרים.`

      );

      await onReload();

    } catch (err: any) {

      setSaveError(err?.message || "שגיאה בעדכון קבוצתי");

    } finally {

      setApplyingBulk(false);

    }

  };



  const handleAssignOfficialBarcode = async (oldBarcode: string) => {

    setSaveNotice(null);

    setSaveError(null);

    const res = await fetch(`/api/books/${encodeURIComponent(oldBarcode)}/assign-official-barcode`, {

      method: "POST",

    });

    const data = await res.json().catch(() => ({}));

    if (res.ok) {

      setSaveNotice(`הוקצה ברקוד רשמי ${data.newBarcode} והספר נוסף לתור הדפסת המדבקות.`);

      await onReload();

    } else {

      setSaveError(data.error || "שגיאה בהקצאת ברקוד רשמי");

    }

  };



  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {

    if (e.key === "Enter" && displayBooks.length === 1) {

      setOpenInEditMode(false);

      setSelectedBarcode(displayBooks[0].barcode);

    }

  };



  const handleQuickAdd = async (e: React.FormEvent) => {

    e.preventDefault();

    if (!newTitle.trim()) return;

    setSavingBook(true);

    setSaveNotice(null);

    setSaveError(null);

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

    } catch (err: any) {

      setSaveError(err?.message || "שגיאה בהוספה");

    } finally {

      setSavingBook(false);

    }

  };



  return (

    <div className="space-y-4 max-w-7xl">

      <div className="flex flex-wrap items-center justify-between gap-4">

        <div>

          <h1 className="text-2xl font-bold tracking-tight">{t("search.pageTitle")}</h1>

          <p className="text-sm text-[var(--otzar-text-muted)] mt-0.5">{t("search.pageSubtitle")}</p>

        </div>



        <div className="flex items-center gap-2">

          <button

            type="button"

            onClick={() => setSidebarOpen((v) => !v)}

            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border cursor-pointer whitespace-nowrap ${

              sidebarOpen || activeFilterCount > 0

                ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)] text-[var(--otzar-accent)]"

                : "border-[var(--otzar-border)] bg-[var(--otzar-bg)] text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"

            }`}

          >

            <SlidersHorizontal className="w-3.5 h-3.5" />

            <span>סינון צדדי</span>

            {activeFilterCount > 0 && (

              <span className="px-1.5 py-0.5 rounded bg-[var(--otzar-accent)] text-white text-[10px] font-bold tabular-nums">

                {activeFilterCount}

              </span>

            )}

          </button>

          {isAdmin && (

            <button

              type="button"

              onClick={() => setShowQuickAdd((v) => !v)}

              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-[var(--otzar-border)] bg-[var(--otzar-surface)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-soft)] cursor-pointer whitespace-nowrap shrink-0"

            >

              {showQuickAdd ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}

              {showQuickAdd ? t("search.quickAddClose") : t("search.quickAddOpen")}

            </button>

          )}

        </div>

      </div>



      {/* Main Search & Top Sort Bar */}

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

            placeholder={t("search.placeholder")}

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

              {t("search.clearSearch")}

            </button>

          )}

        </div>



        <div className="flex flex-wrap items-center justify-between gap-3">

          {/* Status segmented filter */}

          <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--otzar-bg)] border border-[var(--otzar-border-muted)]">

            {[

              { id: "all", label: t("search.filterAll") },

              { id: "available", label: t("search.filterAvailable") },

              { id: "borrowed", label: t("search.filterBorrowed") },

              { id: "reference_only", label: t("search.filterReferenceOnly") },

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

                {t("search.semanticButton")}

              </button>

            )}



            <select

              value={categoryFilter}

              onChange={(e) => onCategoryFilterChange(e.target.value)}

              className="px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs"

            >

              <option value="all">{t("search.allCategories")}</option>

              {categories.map((cat) => (

                <option key={cat} value={cat}>

                  {cat}

                </option>

              ))}

            </select>



            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]">

              <ArrowUpDown className="w-3.5 h-3.5 text-[var(--otzar-accent)]" />

              <select

                value={sortBy}

                onChange={(e) => setSortBy(e.target.value)}

                className="bg-transparent text-xs font-medium focus:outline-none cursor-pointer"

                aria-label="מיון רשימת ספרים"

              >

                <option value="torah_order">סדר תורני וסטים (קנוני)</option>

                {searchQuery.trim() && <option value="relevance">התאמה לחיפוש</option>}

                <option value="location_asc">ארון ומדף (לסידור)</option>

                <option value="title_asc">שם ספר (א–ת)</option>

                <option value="title_desc">שם ספר (ת–א)</option>

                <option value="author_asc">מחבר (א–ת)</option>

                <option value="publisher_asc">הוצאה לאור (א–ת)</option>

                <option value="year_desc">שנת הוצאה (חדש ← ישן)</option>

                <option value="year_asc">שנת הוצאה (ישן ← חדש)</option>

                <option value="barcode_asc">ברקוד (סדר עולה)</option>

                <option value="recent_desc">נוספו לאחרונה</option>

              </select>

            </div>



            <span className="text-[var(--otzar-text-muted)] tabular-nums">

              {t("search.showingCount", { count: displayBooks.length })}

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

              placeholder="בעל קצות החושן"

              className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"

            />

          </div>

          <div>

            <label className="block text-xs font-medium mb-1">ארון</label>

            <select

              value={newCabinetId}

              onChange={(e) => setNewCabinetId(e.target.value)}

              className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"

            >

              {cabinets.map((c) => (

                <option key={c.id} value={c.id}>

                  ארון {c.code}

                </option>

              ))}

            </select>

          </div>

          <div>

            <label className="block text-xs font-medium mb-1">מדף</label>

            <input

              type="number"

              min={1}

              max={15}

              value={newShelf}

              onChange={(e) => setNewShelf(e.target.value)}

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

        <div className="flex items-center gap-2 p-3 rounded-lg border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 text-sm">

          <CheckCircle2 className="w-4 h-4 shrink-0" />

          <span>{saveNotice}</span>

        </div>

      )}

      {saveError && (

        <div className="flex items-center gap-2 p-3 rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800 text-red-800 dark:text-red-200 text-sm">

          <AlertCircle className="w-4 h-4 shrink-0" />

          <span>{saveError}</span>

        </div>

      )}



      {/* Dual-zone Workspace: RTL Filter Sidebar + Results Table */}

      <div className="flex flex-col lg:flex-row gap-4 items-start">

        {sidebarOpen && (

          <aside className="w-full lg:w-[252px] shrink-0 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] p-3.5 space-y-3 text-xs">

            <div className="flex items-center justify-between border-b border-[var(--otzar-border-muted)] pb-2">

              <div className="flex items-center gap-1.5 font-bold text-sm text-[var(--otzar-text)]">

                <Filter className="w-4 h-4 text-[var(--otzar-accent)]" />

                <span>מסננים</span>

              </div>

              {activeFilterCount > 0 && (

                <button

                  type="button"

                  onClick={resetAllFilters}

                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--otzar-accent)] hover:underline cursor-pointer"

                >

                  <RotateCcw className="w-3 h-3" />

                  אפס הכל

                </button>

              )}

            </div>



            {/* Cabinet & Specific Shelf */}

            <div className="space-y-1.5">

              <label className="block font-semibold text-[var(--otzar-text-muted)]">ארון ומיקום</label>

              <select

                value={cabinetFilter}

                onChange={(e) => {

                  setCabinetFilter(e.target.value);

                  setShelfFilter("all");

                }}

                className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"

              >

                <option value="all">כל הארונות</option>

                <option value="unassigned">ללא שיוך לארון</option>

                {cabinets.map((c) => (

                  <option key={c.id} value={String(c.id)}>

                    ארון {c.code}{c.main_subject ? ` · ${c.main_subject}` : ""}

                  </option>

                ))}

              </select>



              {selectedFilterCabinet && (

                <select

                  value={shelfFilter}

                  onChange={(e) => setShelfFilter(e.target.value)}

                  className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"

                >

                  <option value="all">כל המדפים בארון {selectedFilterCabinet.code}</option>

                  {Array.from({ length: selectedFilterCabinet.shelves_count || 6 }, (_, i) => i + 1).map((n) => (

                    <option key={n} value={String(n)}>

                      מדף {n}

                    </option>

                  ))}

                </select>

              )}

            </div>



            {/* Sets & Missing Volumes */}

            <div className="space-y-1.5 border-t border-[var(--otzar-border-muted)] pt-2.5">

              <label className="block font-semibold text-[var(--otzar-text-muted)]">סטים וסדרות</label>

              <select

                value={setTypeFilter}

                onChange={(e) => setSetTypeFilter(e.target.value)}

                className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"

              >

                <option value="all">הכל (סטים ובודדים)</option>

                <option value="set_only">שייכים לסט בלבד</option>

                <option value="single_only">ספרים בודדים (ללא סט)</option>

              </select>



              <select

                value={specificSetFilter}

                onChange={(e) => setSpecificSetFilter(e.target.value)}

                className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"

              >

                <option value="all">כל הסטים ({setNames.length})</option>

                {setNames.map((sn) => (

                  <option key={sn} value={sn}>

                    {sn} ({booksBySetMap.get(sn)?.length || 0})

                  </option>

                ))}

              </select>



              {setsWithMissingSet.size > 0 && (

                <label className="flex items-center gap-2 pt-1 cursor-pointer select-none text-amber-800 dark:text-amber-300 font-medium">

                  <input

                    type="checkbox"

                    checked={missingSetOnly}

                    onChange={(e) => setMissingSetOnly(e.target.checked)}

                    className="rounded accent-[var(--otzar-accent)]"

                  />

                  <span>רק סטים עם כרכים חסרים ({setsWithMissingSet.size})</span>

                </label>

              )}

            </div>



            {/* Author */}

            <div className="space-y-1.5 border-t border-[var(--otzar-border-muted)] pt-2.5">

              <label className="block font-semibold text-[var(--otzar-text-muted)]">מחבר / מפרש</label>

              <select

                value={authorFilter}

                onChange={(e) => setAuthorFilter(e.target.value)}

                className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"

              >

                <option value="all">כל המחברים</option>

                {authorsList.map((a) => (

                  <option key={a} value={a}>

                    {a}

                  </option>

                ))}

              </select>

            </div>



            {/* Publisher */}

            <div className="space-y-1.5 border-t border-[var(--otzar-border-muted)] pt-2.5">

              <label className="block font-semibold text-[var(--otzar-text-muted)]">הוצאה / מכון</label>

              <select

                value={publisherFilter}

                onChange={(e) => setPublisherFilter(e.target.value)}

                className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"

              >

                <option value="all">כל ההוצאות</option>

                {publishersList.map((p) => (

                  <option key={p} value={p}>

                    {p}

                  </option>

                ))}

              </select>

            </div>



            {/* Format */}

            <div className="space-y-1.5 border-t border-[var(--otzar-border-muted)] pt-2.5">

              <label className="block font-semibold text-[var(--otzar-text-muted)]">גודל / פורמט</label>

              <select

                value={formatFilter}

                onChange={(e) => setFormatFilter(e.target.value)}

                className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"

              >

                <option value="all">כל הפורמטים</option>

                {formatsList.map((f) => (

                  <option key={f} value={f}>

                    {f}

                  </option>

                ))}

              </select>

            </div>

          </aside>

        )}



        {/* Right/Left Main Table Workspace */}

        <div className="flex-1 min-w-0 w-full space-y-3">

          {/* Bulk Action Bar (visible when admin selects 1+ books) */}

          {isAdmin && selectedBarcodes.length > 0 && (

            <div className="p-3 rounded-xl border border-[var(--otzar-accent)]/50 bg-[var(--otzar-surface)] flex flex-wrap items-center justify-between gap-3 text-xs">

              <div className="flex items-center gap-2 font-bold text-[var(--otzar-accent)] tabular-nums">

                <CheckSquare className="w-4 h-4 shrink-0" />

                <span>נבחרו {selectedBarcodes.length} ספרים</span>

                <button

                  type="button"

                  onClick={() => setSelectedBarcodes([])}

                  className="text-[11px] font-normal text-[var(--otzar-text-muted)] hover:underline cursor-pointer mr-1"

                >

                  נקה בחירה

                </button>

              </div>



              <div className="flex flex-wrap items-center gap-2">

                {/* Quick Shelf Placement */}

                <div className="inline-flex flex-wrap items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]">

                  <span className="font-semibold text-[var(--otzar-text-muted)]">שבץ למדף:</span>

                  <select

                    value={quickShelfCabId}

                    onChange={(e) => {

                      setQuickShelfCabId(e.target.value);

                      setQuickShelfNum(1);

                    }}

                    className="bg-transparent border-none text-xs font-semibold focus:outline-none cursor-pointer"

                  >

                    {cabinets.map((c) => (

                      <option key={c.id} value={String(c.id)}>

                        ארון {c.code}

                      </option>

                    ))}

                  </select>

                  <select

                    value={quickShelfNum}

                    onChange={(e) => setQuickShelfNum(Number(e.target.value) || 1)}

                    className="bg-transparent border-none text-xs font-semibold tabular-nums focus:outline-none cursor-pointer"

                  >

                    {Array.from({ length: quickShelfMax }, (_, i) => i + 1).map((n) => (

                      <option key={n} value={n}>

                        מדף {n}

                      </option>

                    ))}

                  </select>

                  <button

                    type="button"

                    disabled={applyingBulk || !quickShelfCabId}

                    onClick={handleQuickAssignShelfBulk}

                    className="px-2.5 py-1 rounded bg-emerald-600 text-white font-bold hover:bg-emerald-700 cursor-pointer disabled:opacity-50"

                  >

                    {applyingBulk ? "משבץ..." : "החל מיקום"}

                  </button>

                </div>



                {/* Full Selective Bulk Edit */}

                <button

                  type="button"

                  disabled={applyingBulk}

                  onClick={openBulkEditModal}

                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold bg-[var(--otzar-accent)] text-white hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-50"

                >

                  <Layers className="w-3.5 h-3.5" />

                  <span>עריכה קבוצתית לכל השדות</span>

                </button>



                {/* Bulk Send Back to AI Queue */}

                <button

                  type="button"

                  disabled={applyingBulk}

                  onClick={handleBulkSendToQueue}

                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold border border-[var(--otzar-accent)] bg-[var(--otzar-bg)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer disabled:opacity-50"

                >

                  <Send className="w-3.5 h-3.5" />

                  <span>שלח נבחרים לתור AI</span>

                </button>

              </div>

            </div>

          )}



          {/* Results Table */}

          <div className="rounded-xl border border-[var(--otzar-border-muted)] overflow-hidden bg-[var(--otzar-bg)]">

            <table className="w-full text-sm text-right border-collapse">

              <thead className="bg-[var(--otzar-surface-alt)] border-b border-[var(--otzar-border-muted)] text-[var(--otzar-text-muted)] text-xs">

                <tr>

                  {isAdmin && (

                    <th className="py-2.5 px-3 w-10 text-center">

                      <input

                        type="checkbox"

                        checked={allDisplaySelected}

                        onChange={toggleSelectAllInView}

                        title="בחר הכל בתצוגה (Shift לבחירת טווח)"

                        className="rounded accent-[var(--otzar-accent)] cursor-pointer"

                      />

                    </th>

                  )}

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

                    <td colSpan={isAdmin ? 7 : 6} className="py-10 text-center text-[var(--otzar-text-muted)]">

                      מחפש במאגר המקומי...

                    </td>

                  </tr>

                ) : displayBooks.length === 0 ? (

                  <tr>

                    <td colSpan={isAdmin ? 7 : 6} className="py-10 text-center text-[var(--otzar-text-muted)]">

                      לא נמצאו ספרים התואמים לחיפוש &quot;{searchQuery}&quot;. נסה לקצר מילים או להחליף סינון.

                    </td>

                  </tr>

                ) : (

                  displayBooks.map((b, idx) => {

                    const isChecked = selectedSet.has(b.barcode);

                    const sameSet = b.set_name ? booksBySetMap.get(b.set_name.trim()) : undefined;

                    const showVol =

                      Boolean(b.volume) && !shouldSuppressSingleVolumeLabel(b, sameSet);

                    return (

                      <tr

                        key={b.barcode}

                        onClick={() => {

                          setOpenInEditMode(false);

                          setSelectedBarcode(b.barcode);

                        }}

                        className={`transition-colors cursor-pointer ${

                          isChecked

                            ? "bg-[var(--otzar-surface)]"

                            : "hover:bg-[var(--otzar-surface)]"

                        }`}

                      >

                        {isAdmin && (

                          <td

                            className="py-3 px-3 text-center"

                            onClick={(e) => {

                              e.stopPropagation();

                            }}

                          >

                            <input

                              type="checkbox"

                              checked={isChecked}

                              onClick={(e) => {

                                e.stopPropagation();

                                toggleRowSelection(b.barcode, idx, e.shiftKey);

                              }}

                              onChange={() => {}}

                              className="rounded accent-[var(--otzar-accent)] cursor-pointer"

                            />

                          </td>

                        )}

                        <td className="py-3 px-4 font-mono tabular-nums font-medium">

                          <div>{b.barcode}</div>

                          {b.barcode_status === "pending_barcode" && (

                            <div className="text-[11px] font-sans text-amber-700 dark:text-amber-400 font-medium">

                              ממתין לברקוד רשמי

                            </div>

                          )}

                        </td>

                        <td className="py-3 px-4">

                          <div className="font-semibold">

                            {b.title}

                            {showVol ? (

                              <span className="text-[var(--otzar-text-muted)] font-normal"> · {b.volume}</span>

                            ) : null}

                          </div>

                          <div className="text-xs text-[var(--otzar-text-muted)] mt-0.5 tabular-nums">

                            {b.set_name ? `סט: ${b.set_name} · ` : ""}

                            {b.sub_series ? `${b.sub_series} · ` : ""}

                            {b.category || "כללי"}

                            {b.coverage_range ? ` · ${b.coverage_range}` : ""}

                            {b.edition ? ` · מהדורה: ${b.edition}` : ""}

                            {b.pub_year ? ` · שנת הוצאה: ${b.pub_year}` : ""}

                            {b.format_size ? ` · ${b.format_size}` : ""}

                            {b.thickness_mm != null && b.thickness_mm > 0 ? ` · ${b.thickness_mm} מ״מ` : ""}

                            {b.matchHint ? (

                              <span className="text-[var(--otzar-accent)] font-medium"> · {b.matchHint}</span>

                            ) : null}

                          </div>

                        </td>

                        <td className="py-3 px-4 text-[var(--otzar-text-muted)]">{b.author || "—"}</td>

                        <td className="py-3 px-4 tabular-nums">

                          {b.cabinet_code

                            ? `ארון ${b.cabinet_code} · מדף ${b.shelf_number ?? "-"}`

                            : "לא שויך"}

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

                    );

                  })

                )}

              </tbody>

            </table>

          </div>

        </div>

      </div>



      {/* Selective Multi-Field Bulk Edit Modal */}

      {isAdmin && showBulkModal && (

        <div

          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"

          onClick={() => setShowBulkModal(false)}

        >

          <div

            className="w-full max-w-3xl max-h-[90vh] rounded-2xl bg-[var(--otzar-bg)] border border-[var(--otzar-border)] shadow-2xl overflow-hidden flex flex-col"

            onClick={(e) => e.stopPropagation()}

          >

            <div className="px-6 py-4 border-b border-[var(--otzar-border-muted)] bg-[var(--otzar-surface)] flex items-center justify-between">

              <div>

                <h2 className="text-lg font-bold">

                  עריכה קבוצתית סלקטיבית ({selectedBarcodes.length} ספרים נבחרים)

                </h2>

                <p className="text-xs text-[var(--otzar-text-muted)] mt-0.5">

                  סמן אך ורק את השדות שברצונך לשנות — כל שאר הערכים הייחודיים בספרים הנבחרים לא יידרסו.

                </p>

              </div>

              <button

                type="button"

                onClick={() => setShowBulkModal(false)}

                className="p-1.5 rounded-lg hover:bg-[var(--otzar-surface-alt)] text-[var(--otzar-text-muted)] cursor-pointer"

              >

                <X className="w-5 h-5" />

              </button>

            </div>



            <form onSubmit={handleBulkModalSubmit} className="p-6 overflow-y-auto space-y-4 text-xs">

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">

                {/* title */}

                <div className={`p-2.5 rounded-lg border ${bulkEnabled.title ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                  <label className="flex items-center gap-2 font-semibold mb-1.5 cursor-pointer">

                    <input

                      type="checkbox"

                      checked={Boolean(bulkEnabled.title)}

                      onChange={(e) => setBulkEnabled((p) => ({ ...p, title: e.target.checked }))}

                      className="rounded accent-[var(--otzar-accent)]"

                    />

                    <span>שם הספר</span>

                  </label>

                  <input

                    type="text"

                    disabled={!bulkEnabled.title}

                    value={bulkTitle}

                    onChange={(e) => setBulkTitle(e.target.value)}

                    placeholder="הקלד כותר חדש..."

                    className="w-full px-2.5 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] disabled:opacity-50"

                  />

                </div>



                {/* set_name */}

                <div className={`p-2.5 rounded-lg border ${bulkEnabled.set_name ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                  <label className="flex items-center gap-2 font-semibold mb-1.5 cursor-pointer">

                    <input

                      type="checkbox"

                      checked={Boolean(bulkEnabled.set_name)}

                      onChange={(e) => setBulkEnabled((p) => ({ ...p, set_name: e.target.checked }))}

                      className="rounded accent-[var(--otzar-accent)]"

                    />

                    <span>שם הסט / סדרה</span>

                  </label>

                  <AutocompleteInput

                    field="set_name"

                    value={bulkSetName}

                    onChange={setBulkSetName}

                    placeholder="שם סט (ריק ינתק מסט)"

                    inputClassName="!py-1.5 !text-xs !bg-[var(--otzar-bg)] !border-[var(--otzar-border-muted)]"

                  />

                </div>



                {/* sub_series */}

                <div className={`p-2.5 rounded-lg border ${bulkEnabled.sub_series ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                  <label className="flex items-center gap-2 font-semibold mb-1.5 cursor-pointer">

                    <input

                      type="checkbox"

                      checked={Boolean(bulkEnabled.sub_series)}

                      onChange={(e) => setBulkEnabled((p) => ({ ...p, sub_series: e.target.checked }))}

                      className="rounded accent-[var(--otzar-accent)]"

                    />

                    <span>תת-סדרה / מסכת</span>

                  </label>

                  <input

                    type="text"

                    disabled={!bulkEnabled.sub_series}

                    value={bulkSubSeries}

                    onChange={(e) => setBulkSubSeries(e.target.value)}

                    placeholder="למשל: מסכת שבת / אורח חיים"

                    className="w-full px-2.5 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] disabled:opacity-50"

                  />

                </div>



                {/* volume & set_global_number */}

                <div className="grid grid-cols-2 gap-2">

                  <div className={`p-2.5 rounded-lg border ${bulkEnabled.volume ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                    <label className="flex items-center gap-1.5 font-semibold mb-1.5 cursor-pointer">

                      <input

                        type="checkbox"

                        checked={Boolean(bulkEnabled.volume)}

                        onChange={(e) => setBulkEnabled((p) => ({ ...p, volume: e.target.checked }))}

                        className="rounded accent-[var(--otzar-accent)]"

                      />

                      <span>כרך / חלק</span>

                    </label>

                    <input

                      type="text"

                      disabled={!bulkEnabled.volume}

                      value={bulkVolume}

                      onChange={(e) => setBulkVolume(e.target.value)}

                      placeholder="כרך א׳ / ריק"

                      className="w-full px-2 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] disabled:opacity-50"

                    />

                  </div>

                  <div className={`p-2.5 rounded-lg border ${bulkEnabled.set_global_number ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                    <label className="flex items-center gap-1.5 font-semibold mb-1.5 cursor-pointer">

                      <input

                        type="checkbox"

                        checked={Boolean(bulkEnabled.set_global_number)}

                        onChange={(e) => setBulkEnabled((p) => ({ ...p, set_global_number: e.target.checked }))}

                        className="rounded accent-[var(--otzar-accent)]"

                      />

                      <span>מספר כללי</span>

                    </label>

                    <input

                      type="number"

                      min={1}

                      disabled={!bulkEnabled.set_global_number}

                      value={bulkSetGlobalNum}

                      onChange={(e) => setBulkSetGlobalNum(e.target.value)}

                      placeholder="1..N"

                      className="w-full px-2 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums disabled:opacity-50"

                    />

                  </div>

                </div>



                {/* author */}

                <div className={`p-2.5 rounded-lg border ${bulkEnabled.author ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                  <label className="flex items-center gap-2 font-semibold mb-1.5 cursor-pointer">

                    <input

                      type="checkbox"

                      checked={Boolean(bulkEnabled.author)}

                      onChange={(e) => setBulkEnabled((p) => ({ ...p, author: e.target.checked }))}

                      className="rounded accent-[var(--otzar-accent)]"

                    />

                    <span>מחבר / מפרש</span>

                  </label>

                  <AutocompleteInput

                    field="author"

                    value={bulkAuthor}

                    onChange={setBulkAuthor}

                    inputClassName="!py-1.5 !text-xs !bg-[var(--otzar-bg)] !border-[var(--otzar-border-muted)]"

                  />

                </div>



                {/* category */}

                <div className={`p-2.5 rounded-lg border ${bulkEnabled.category ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                  <label className="flex items-center gap-2 font-semibold mb-1.5 cursor-pointer">

                    <input

                      type="checkbox"

                      checked={Boolean(bulkEnabled.category)}

                      onChange={(e) => setBulkEnabled((p) => ({ ...p, category: e.target.checked }))}

                      className="rounded accent-[var(--otzar-accent)]"

                    />

                    <span>קטגוריה</span>

                  </label>

                  <AutocompleteInput

                    field="category"

                    value={bulkCategory}

                    onChange={setBulkCategory}

                    inputClassName="!py-1.5 !text-xs !bg-[var(--otzar-bg)] !border-[var(--otzar-border-muted)]"

                  />

                </div>



                {/* publisher */}

                <div className={`p-2.5 rounded-lg border ${bulkEnabled.publisher ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                  <label className="flex items-center gap-2 font-semibold mb-1.5 cursor-pointer">

                    <input

                      type="checkbox"

                      checked={Boolean(bulkEnabled.publisher)}

                      onChange={(e) => setBulkEnabled((p) => ({ ...p, publisher: e.target.checked }))}

                      className="rounded accent-[var(--otzar-accent)]"

                    />

                    <span>הוצאה לאור / מכון</span>

                  </label>

                  <AutocompleteInput

                    field="publisher"

                    value={bulkPublisher}

                    onChange={setBulkPublisher}

                    inputClassName="!py-1.5 !text-xs !bg-[var(--otzar-bg)] !border-[var(--otzar-border-muted)]"

                  />

                </div>



                {/* edition & pub_year */}

                <div className="grid grid-cols-2 gap-2">

                  <div className={`p-2.5 rounded-lg border ${bulkEnabled.edition ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                    <label className="flex items-center gap-1.5 font-semibold mb-1.5 cursor-pointer">

                      <input

                        type="checkbox"

                        checked={Boolean(bulkEnabled.edition)}

                        onChange={(e) => setBulkEnabled((p) => ({ ...p, edition: e.target.checked }))}

                        className="rounded accent-[var(--otzar-accent)]"

                      />

                      <span>מהדורה</span>

                    </label>

                    <input

                      type="text"

                      disabled={!bulkEnabled.edition}

                      value={bulkEdition}

                      onChange={(e) => setBulkEdition(e.target.value)}

                      className="w-full px-2 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] disabled:opacity-50"

                    />

                  </div>

                  <div className={`p-2.5 rounded-lg border ${bulkEnabled.pub_year ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                    <label className="flex items-center gap-1.5 font-semibold mb-1.5 cursor-pointer">

                      <input

                        type="checkbox"

                        checked={Boolean(bulkEnabled.pub_year)}

                        onChange={(e) => setBulkEnabled((p) => ({ ...p, pub_year: e.target.checked }))}

                        className="rounded accent-[var(--otzar-accent)]"

                      />

                      <span>שנת הוצאה</span>

                    </label>

                    <input

                      type="text"

                      disabled={!bulkEnabled.pub_year}

                      value={bulkPubYear}

                      onChange={(e) => setBulkPubYear(e.target.value)}

                      className="w-full px-2 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] disabled:opacity-50"

                    />

                  </div>

                </div>



                {/* coverage_range */}

                <div className={`p-2.5 rounded-lg border ${bulkEnabled.coverage_range ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                  <label className="flex items-center gap-2 font-semibold mb-1.5 cursor-pointer">

                    <input

                      type="checkbox"

                      checked={Boolean(bulkEnabled.coverage_range)}

                      onChange={(e) => setBulkEnabled((p) => ({ ...p, coverage_range: e.target.checked }))}

                      className="rounded accent-[var(--otzar-accent)]"

                    />

                    <span>טווח סימנים / דפים</span>

                  </label>

                  <input

                    type="text"

                    disabled={!bulkEnabled.coverage_range}

                    value={bulkCoverage}

                    onChange={(e) => setBulkCoverage(e.target.value)}

                    placeholder="למשל: סימנים א׳–ל״ד"

                    className="w-full px-2.5 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] disabled:opacity-50"

                  />

                </div>



                {/* format_size, thickness_mm, pages_count */}

                <div className="grid grid-cols-3 gap-2">

                  <div className={`p-2 rounded-lg border ${bulkEnabled.format_size ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                    <label className="flex items-center gap-1 font-semibold mb-1 cursor-pointer">

                      <input

                        type="checkbox"

                        checked={Boolean(bulkEnabled.format_size)}

                        onChange={(e) => setBulkEnabled((p) => ({ ...p, format_size: e.target.checked }))}

                        className="rounded accent-[var(--otzar-accent)]"

                      />

                      <span>פורמט</span>

                    </label>

                    <input

                      list="otzar-bulk-format-sizes"

                      disabled={!bulkEnabled.format_size}

                      value={bulkFormatSize}

                      onChange={(e) => setBulkFormatSize(e.target.value)}

                      className="w-full px-2 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] disabled:opacity-50"

                    />

                    <datalist id="otzar-bulk-format-sizes">

                      {FORMAT_SIZE_OPTIONS.map((opt) => (

                        <option key={opt} value={opt} />

                      ))}

                    </datalist>

                  </div>

                  <div className={`p-2 rounded-lg border ${bulkEnabled.thickness_mm ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                    <label className="flex items-center gap-1 font-semibold mb-1 cursor-pointer">

                      <input

                        type="checkbox"

                        checked={Boolean(bulkEnabled.thickness_mm)}

                        onChange={(e) => setBulkEnabled((p) => ({ ...p, thickness_mm: e.target.checked }))}

                        className="rounded accent-[var(--otzar-accent)]"

                      />

                      <span>עובי מ״מ</span>

                    </label>

                    <input

                      type="number"

                      min={1}

                      max={300}

                      step="0.5"

                      disabled={!bulkEnabled.thickness_mm}

                      value={bulkThicknessMm}

                      onChange={(e) => setBulkThicknessMm(e.target.value)}

                      className="w-full px-2 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums disabled:opacity-50"

                    />

                  </div>

                  <div className={`p-2 rounded-lg border ${bulkEnabled.pages_count ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                    <label className="flex items-center gap-1 font-semibold mb-1 cursor-pointer">

                      <input

                        type="checkbox"

                        checked={Boolean(bulkEnabled.pages_count)}

                        onChange={(e) => setBulkEnabled((p) => ({ ...p, pages_count: e.target.checked }))}

                        className="rounded accent-[var(--otzar-accent)]"

                      />

                      <span>עמודים</span>

                    </label>

                    <input

                      type="number"

                      min={1}

                      max={10000}

                      disabled={!bulkEnabled.pages_count}

                      value={bulkPagesCount}

                      onChange={(e) => setBulkPagesCount(e.target.value)}

                      className="w-full px-2 py-1 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums disabled:opacity-50"

                    />

                  </div>

                </div>



                {/* location */}

                <div className={`p-2.5 rounded-lg border ${bulkEnabled.location ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                  <label className="flex items-center gap-2 font-semibold mb-1.5 cursor-pointer">

                    <input

                      type="checkbox"

                      checked={Boolean(bulkEnabled.location)}

                      onChange={(e) => setBulkEnabled((p) => ({ ...p, location: e.target.checked }))}

                      className="rounded accent-[var(--otzar-accent)]"

                    />

                    <span>ארון ומדף במפה</span>

                  </label>

                  <div className="grid grid-cols-2 gap-2">

                    <select

                      disabled={!bulkEnabled.location}

                      value={bulkCabinetId}

                      onChange={(e) => {

                        setBulkCabinetId(e.target.value);

                        setBulkShelfNumber(1);

                      }}

                      className="px-2 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] disabled:opacity-50"

                    >

                      <option value="">לא שויך</option>

                      {cabinets.map((c) => (

                        <option key={c.id} value={String(c.id)}>

                          ארון {c.code}

                        </option>

                      ))}

                    </select>

                    <select

                      disabled={!bulkEnabled.location || !bulkCabinetId}

                      value={bulkShelfNumber}

                      onChange={(e) => setBulkShelfNumber(Number(e.target.value) || 1)}

                      className="px-2 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums disabled:opacity-50"

                    >

                      {Array.from({ length: bulkShelfMax }, (_, i) => i + 1).map((n) => (

                        <option key={n} value={n}>

                          מדף {n}

                        </option>

                      ))}

                    </select>

                  </div>

                </div>



                {/* status */}

                <div className={`p-2.5 rounded-lg border ${bulkEnabled.status ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                  <label className="flex items-center gap-2 font-semibold mb-1.5 cursor-pointer">

                    <input

                      type="checkbox"

                      checked={Boolean(bulkEnabled.status)}

                      onChange={(e) => setBulkEnabled((p) => ({ ...p, status: e.target.checked }))}

                      className="rounded accent-[var(--otzar-accent)]"

                    />

                    <span>סטטוס זמינות (ספרים מושאלים מוגנים מדריסה)</span>

                  </label>

                  <select

                    disabled={!bulkEnabled.status}

                    value={bulkStatus}

                    onChange={(e) => setBulkStatus(e.target.value as "available" | "reference_only" | "lost")}

                    className="w-full px-2.5 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] disabled:opacity-50"

                  >

                    <option value="available">זמין על המדף</option>

                    <option value="reference_only">לעיון בלבד</option>

                    <option value="lost">אבוד / חסר</option>

                  </select>

                </div>



                {/* tags */}

                <div className={`md:col-span-2 p-2.5 rounded-lg border ${bulkEnabled.tags ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">

                    <label className="flex items-center gap-2 font-semibold cursor-pointer">

                      <input

                        type="checkbox"

                        checked={Boolean(bulkEnabled.tags)}

                        onChange={(e) => setBulkEnabled((p) => ({ ...p, tags: e.target.checked }))}

                        className="rounded accent-[var(--otzar-accent)]"

                      />

                      <span>תגיות חיפוש (מופרדות בפסיקים)</span>

                    </label>

                    {bulkEnabled.tags && (

                      <div className="flex items-center gap-3">

                        <label className="inline-flex items-center gap-1 cursor-pointer">

                          <input

                            type="radio"

                            name="bulkTagsMode"

                            checked={bulkTagsMode === "merge"}

                            onChange={() => setBulkTagsMode("merge")}

                            className="accent-[var(--otzar-accent)]"

                          />

                          <span>מזג עם הקיימות</span>

                        </label>

                        <label className="inline-flex items-center gap-1 cursor-pointer">

                          <input

                            type="radio"

                            name="bulkTagsMode"

                            checked={bulkTagsMode === "replace"}

                            onChange={() => setBulkTagsMode("replace")}

                            className="accent-[var(--otzar-accent)]"

                          />

                          <span>החלף תגיות</span>

                        </label>

                      </div>

                    )}

                  </div>

                  <input

                    type="text"

                    disabled={!bulkEnabled.tags}

                    value={bulkTags}

                    onChange={(e) => setBulkTags(e.target.value)}

                    placeholder="למשל: ש״ס, מבואר, הלכה..."

                    className="w-full px-2.5 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] disabled:opacity-50"

                  />

                </div>



                {/* notes */}

                <div className={`md:col-span-2 p-2.5 rounded-lg border ${bulkEnabled.notes ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)]/40" : "border-[var(--otzar-border-muted)] opacity-75"}`}>

                  <label className="flex items-center gap-2 font-semibold mb-1.5 cursor-pointer">

                    <input

                      type="checkbox"

                      checked={Boolean(bulkEnabled.notes)}

                      onChange={(e) => setBulkEnabled((p) => ({ ...p, notes: e.target.checked }))}

                      className="rounded accent-[var(--otzar-accent)]"

                    />

                    <span>הערות</span>

                  </label>

                  <input

                    type="text"

                    disabled={!bulkEnabled.notes}

                    value={bulkNotes}

                    onChange={(e) => setBulkNotes(e.target.value)}

                    placeholder="הערה לכל הנבחרים..."

                    className="w-full px-2.5 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] disabled:opacity-50"

                  />

                </div>

              </div>



              <div className="pt-3 border-t border-[var(--otzar-border-muted)] flex items-center justify-between">

                <span className="text-[var(--otzar-text-muted)] tabular-nums">

                  {enabledBulkFieldCount === 0

                    ? "סמן לפחות שדה אחד כדי להחיל שינוי"

                    : `נבחרו ${enabledBulkFieldCount} שדות לעדכון`}

                </span>

                <div className="flex items-center gap-2">

                  <button

                    type="button"

                    onClick={() => setShowBulkModal(false)}

                    className="px-4 py-2 rounded-lg border border-[var(--otzar-border-muted)] cursor-pointer"

                  >

                    ביטול

                  </button>

                  <button

                    type="submit"

                    disabled={applyingBulk || enabledBulkFieldCount === 0}

                    className="px-5 py-2 rounded-lg bg-[var(--otzar-accent)] text-white font-bold hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-50"

                  >

                    {applyingBulk

                      ? "מעדכן..."

                      : `החל ${enabledBulkFieldCount} שדות על ${selectedBarcodes.length} ספרים`}

                  </button>

                </div>

              </div>

            </form>

          </div>

        </div>

      )}



      {selectedBook && (

        <LocationModal

          book={selectedBook}

          cabinets={cabinets}

          entrance={entrance}

          roomDimensions={roomDimensions}

          volumeNotationRules={volumeNotationRules}

          isAdmin={isAdmin}

          initialEditMode={isAdmin && openInEditMode}

          onBookUpdated={onReload}

          onSelectBarcode={(bc, editMode) => {

            setOpenInEditMode(Boolean(editMode));

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

