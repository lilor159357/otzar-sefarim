import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Barcode,
  BookCheck,
  CalendarPlus,
  CheckCircle2,
  Clock,
  Download,
  FileSpreadsheet,
  MapPin,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  UserPlus,
  Users,
  AlertTriangle,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { BorrowerRow, LoanRow } from "../types.ts";
import { useStrings } from "../lib/stringsContext.tsx";

interface CirculationModuleProps {
  defaultLoanDays: number;
  isAdmin?: boolean;
  onReload: () => Promise<void>;
}

type CircSubTab = "checkout" | "return" | "active" | "borrowers";

interface BasketItem {
  barcode: string;
  title: string;
  author: string;
  volume: string;
  status: string;
  cabinet_code: string | null;
  shelf_number: number | null;
}

interface ReturnReceipt {
  barcode: string;
  title: string;
  volume: string;
  borrower_name: string | null;
  borrower_shiur?: string;
  cabinet_code: string | null;
  shelf_number: number | null;
  wasOverdue: boolean;
  note?: string;
  at: string;
}

interface ImportPreviewRow {
  rowNumber: number;
  full_name: string;
  shiur_group: string;
  phone: string;
  notes: string;
  valid: boolean;
  isDuplicate: boolean;
}

function formatHebDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("he-IL", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function playFeedbackTone(kind: "success" | "warn" | "error", muted: boolean) {
  if (muted) return;
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;

    if (kind === "success") {
      osc.type = "sine";
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.setValueAtTime(880, now + 0.08);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.23);
    } else if (kind === "warn") {
      osc.type = "triangle";
      osc.frequency.setValueAtTime(440, now);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.26);
    } else {
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.setValueAtTime(180, now + 0.12);
      gain.gain.setValueAtTime(0.07, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.31);
    }
  } catch {
    // ignore audio restrictions
  }
}

export const CirculationModule: React.FC<CirculationModuleProps> = ({ defaultLoanDays, isAdmin = false, onReload }) => {
  const { t } = useStrings();
  const [subTab, setSubTab] = useState<CircSubTab>("checkout");
  const [muted, setMuted] = useState(false);

  // Borrowers & Loans Data
  const [borrowers, setBorrowers] = useState<BorrowerRow[]>([]);
  const [loans, setLoans] = useState<LoanRow[]>([]);
  const [loanFilterStatus, setLoanFilterStatus] = useState<"active" | "overdue" | "history">("active");
  const [loanQuery, setLoanQuery] = useState("");
  const [borrowerListQuery, setBorrowerListQuery] = useState("");

  // Checkout state
  const [borrowerSearch, setBorrowerSearch] = useState("");
  const [selectedBorrowerId, setSelectedBorrowerId] = useState<number | null>(null);
  const [checkoutBarcode, setCheckoutBarcode] = useState("");
  const [basket, setBasket] = useState<BasketItem[]>([]);
  const [loanDays, setLoanDays] = useState<number>(defaultLoanDays || 14);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutSuccess, setCheckoutSuccess] = useState<string | null>(null);
  const [refConfirmPending, setRefConfirmPending] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);

  // Quick add borrower inside checkout
  const [showQuickBorrower, setShowQuickBorrower] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickShiur, setQuickShiur] = useState("");
  const [quickPhone, setQuickPhone] = useState("");

  // Return state
  const [returnBarcode, setReturnBarcode] = useState("");
  const [returnError, setReturnError] = useState<string | null>(null);
  const [lastReturn, setLastReturn] = useState<ReturnReceipt | null>(null);
  const [recentReturns, setRecentReturns] = useState<ReturnReceipt[]>([]);

  // Borrowers CRUD + Import state
  const [editingBorrower, setEditingBorrower] = useState<BorrowerRow | null>(null);
  const [showBorrowerForm, setShowBorrowerForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formShiur, setFormShiur] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [borrowerFormErr, setBorrowerFormErr] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const [importPreview, setImportPreview] = useState<{
    filename: string;
    sheetName: string;
    totalRows: number;
    validRows: number;
    duplicateRows: number;
    rows: ImportPreviewRow[];
  } | null>(null);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const checkoutInputRef = useRef<HTMLInputElement>(null);
  const returnInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoanDays(defaultLoanDays || 14);
  }, [defaultLoanDays]);

  const loadBorrowers = async () => {
    const res = await fetch("/api/borrowers");
    if (res.ok) {
      setBorrowers(await res.json());
    }
  };

  const loadLoans = async (status = loanFilterStatus, q = loanQuery) => {
    const params = new URLSearchParams({ status, q });
    const res = await fetch("/api/loans?" + params.toString());
    if (res.ok) {
      setLoans(await res.json());
    }
  };

  useEffect(() => {
    loadBorrowers();
    loadLoans("active", "");
  }, []);

  useEffect(() => {
    if (subTab === "active") {
      loadLoans(loanFilterStatus, loanQuery);
    } else if (subTab === "return") {
      setTimeout(() => returnInputRef.current?.focus(), 60);
    } else if (subTab === "checkout" && selectedBorrowerId) {
      setTimeout(() => checkoutInputRef.current?.focus(), 60);
    }
  }, [subTab]);

  const selectedBorrower = borrowers.find((b) => b.id === selectedBorrowerId) || null;

  const filteredBorrowersForCheckout = borrowers.filter((b) => {
    const q = borrowerSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      b.full_name.toLowerCase().includes(q) ||
      b.shiur_group.toLowerCase().includes(q) ||
      b.phone.toLowerCase().includes(q)
    );
  });

  const filteredBorrowersTable = borrowers.filter((b) => {
    const q = borrowerListQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      b.full_name.toLowerCase().includes(q) ||
      b.shiur_group.toLowerCase().includes(q) ||
      b.phone.toLowerCase().includes(q) ||
      b.notes.toLowerCase().includes(q)
    );
  });

  const activeLoansCount = borrowers.reduce((acc, b) => acc + (b.active_loans_count || 0), 0);
  const overdueLoansCount = borrowers.reduce((acc, b) => acc + (b.overdue_loans_count || 0), 0);

  // Add barcode to checkout basket
  const handleScanCheckoutBarcode = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = checkoutBarcode.trim();
    if (!code) return;
    setCheckoutError(null);
    setCheckoutSuccess(null);
    setRefConfirmPending(null);

    if (basket.some((item) => item.barcode === code)) {
      playFeedbackTone("warn", muted);
      setCheckoutError(`ברקוד ${code} כבר נמצא ברשימת ההשאלה הנוכחית`);
      setCheckoutBarcode("");
      return;
    }

    try {
      const res = await fetch("/api/loans/lookup/" + encodeURIComponent(code));
      const data = await res.json();
      if (!res.ok) {
        playFeedbackTone("error", muted);
        setCheckoutError(data.error || "שגיאה באיתור הספר");
        setCheckoutBarcode("");
        return;
      }
      const bk = data.book;
      if (data.activeLoan || bk.status === "borrowed") {
        playFeedbackTone("error", muted);
        const who = data.activeLoan ? ` ל${data.activeLoan.borrower_name}` : "";
        setCheckoutError(`הספר "${bk.title}" (ברקוד ${bk.barcode}) מושאל כעת${who}`);
        setCheckoutBarcode("");
        return;
      }
      if (bk.status === "lost") {
        playFeedbackTone("error", muted);
        setCheckoutError(`הספר "${bk.title}" מסומן כאבוד/חסר במערכת`);
        setCheckoutBarcode("");
        return;
      }

      if (bk.status === "reference_only") {
        playFeedbackTone("warn", muted);
      } else {
        playFeedbackTone("success", muted);
      }

      setBasket((prev) => [
        ...prev,
        {
          barcode: bk.barcode,
          title: bk.title,
          author: bk.author || "",
          volume: bk.volume || "",
          status: bk.status,
          cabinet_code: bk.cabinet_code || null,
          shelf_number: bk.shelf_number ?? null,
        },
      ]);
      setCheckoutBarcode("");
      checkoutInputRef.current?.focus();
    } catch {
      playFeedbackTone("error", muted);
      setCheckoutError("כשל בתקשורת עם השרת המקומי");
    }
  };

  const handleConfirmCheckout = async (forceReferenceOverride = false) => {
    if (!selectedBorrowerId || basket.length === 0) return;
    setCheckingOut(true);
    setCheckoutError(null);
    setCheckoutSuccess(null);
    try {
      const res = await fetch("/api/loans/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          borrower_id: selectedBorrowerId,
          barcodes: basket.map((b) => b.barcode),
          loan_days: loanDays,
          forceReferenceOverride,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.requiresConfirmation) {
        playFeedbackTone("warn", muted);
        setRefConfirmPending(data.error);
        setCheckingOut(false);
        return;
      }
      if (!res.ok) {
        playFeedbackTone("error", muted);
        setCheckoutError(data.error || "שגיאה בביצוע ההשאלה");
        setCheckingOut(false);
        return;
      }

      playFeedbackTone("success", muted);
      setRefConfirmPending(null);
      setCheckoutSuccess(
        `הושאלו ${data.count} ספרים בהצלחה ל${data.borrower_name} (תאריך החזרה: ${formatHebDate(data.due_date)})`
      );
      setBasket([]);
      await Promise.all([loadBorrowers(), loadLoans(loanFilterStatus, loanQuery), onReload()]);
      setTimeout(() => checkoutInputRef.current?.focus(), 50);
    } catch {
      playFeedbackTone("error", muted);
      setCheckoutError("שגיאת רשת בביצוע ההשאלה");
    } finally {
      setCheckingOut(false);
    }
  };

  const handleQuickAddBorrower = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickName.trim()) return;
    const res = await fetch("/api/borrowers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: quickName, shiur_group: quickShiur, phone: quickPhone }),
    });
    if (res.ok) {
      const created: BorrowerRow = await res.json();
      await loadBorrowers();
      setSelectedBorrowerId(created.id);
      setShowQuickBorrower(false);
      setQuickName("");
      setQuickShiur("");
      setQuickPhone("");
      setTimeout(() => checkoutInputRef.current?.focus(), 60);
    }
  };

  // Return book by scan
  const handleScanReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = returnBarcode.trim();
    if (!code) return;
    await executeReturnBarcode(code);
    setReturnBarcode("");
    returnInputRef.current?.focus();
  };

  const executeReturnBarcode = async (barcode: string) => {
    setReturnError(null);
    try {
      const res = await fetch("/api/loans/return", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode }),
      });
      const data = await res.json();
      if (!res.ok) {
        playFeedbackTone("error", muted);
        setReturnError(data.error || "לא ניתן לקלוט החזרה");
        return;
      }
      playFeedbackTone("success", muted);
      const receipt: ReturnReceipt = {
        barcode: data.book.barcode,
        title: data.book.title,
        volume: data.book.volume || "",
        borrower_name: data.borrower_name,
        borrower_shiur: data.borrower_shiur,
        cabinet_code: data.book.cabinet_code || null,
        shelf_number: data.book.shelf_number ?? null,
        wasOverdue: Boolean(data.wasOverdue),
        note: data.note,
        at: new Date().toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }),
      };
      setLastReturn(receipt);
      setRecentReturns((prev) => [receipt, ...prev].slice(0, 15));
      await Promise.all([loadBorrowers(), loadLoans(loanFilterStatus, loanQuery), onReload()]);
    } catch {
      playFeedbackTone("error", muted);
      setReturnError("שגיאת תקשורת מול השרת");
    }
  };

  const handleExtendLoan = async (loanId: number) => {
    const res = await fetch(`/api/loans/${loanId}/extend`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: 7 }),
    });
    if (res.ok) {
      await Promise.all([loadBorrowers(), loadLoans(loanFilterStatus, loanQuery)]);
    }
  };

  // Borrowers CRUD handlers
  const openAddBorrower = () => {
    setEditingBorrower(null);
    setFormName("");
    setFormShiur("");
    setFormPhone("");
    setFormNotes("");
    setBorrowerFormErr(null);
    setShowBorrowerForm(true);
  };

  const openEditBorrower = (b: BorrowerRow) => {
    setEditingBorrower(b);
    setFormName(b.full_name);
    setFormShiur(b.shiur_group);
    setFormPhone(b.phone);
    setFormNotes(b.notes);
    setBorrowerFormErr(null);
    setShowBorrowerForm(true);
  };

  const handleSaveBorrower = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      setBorrowerFormErr("יש להזין שם מלא");
      return;
    }
    const url = editingBorrower ? `/api/borrowers/${editingBorrower.id}` : "/api/borrowers";
    const method = editingBorrower ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: formName,
        shiur_group: formShiur,
        phone: formPhone,
        notes: formNotes,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setBorrowerFormErr(data.error || "שגיאה בשמירת השואל");
      return;
    }
    setShowBorrowerForm(false);
    await Promise.all([loadBorrowers(), onReload()]);
  };

  const handleDeleteBorrower = async (id: number) => {
    const res = await fetch(`/api/borrowers/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) {
      setImportError(data.error || "לא ניתן למחוק שואל");
      setConfirmDeleteId(null);
      return;
    }
    setConfirmDeleteId(null);
    if (selectedBorrowerId === id) setSelectedBorrowerId(null);
    await Promise.all([loadBorrowers(), onReload()]);
  };

  // CSV/Excel Import
  const handleSelectImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    setImportMessage(null);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const resultStr = String(reader.result || "");
        const base64 = resultStr.includes(",") ? resultStr.split(",")[1] : resultStr;
        const res = await fetch("/api/borrowers/import/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentBase64: base64 }),
        });
        const data = await res.json();
        if (!res.ok) {
          setImportError(data.error || "שגיאה בפענוח הקובץ");
          return;
        }
        setImportPreview({ filename: file.name, ...data });
      } catch {
        setImportError("שגיאה בקריאת הקובץ");
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    };
    reader.readAsDataURL(file);
  };

  const handleConfirmImport = async () => {
    if (!importPreview) return;
    const res = await fetch("/api/borrowers/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: importPreview.rows, skipDuplicates }),
    });
    const data = await res.json();
    if (!res.ok) {
      setImportError(data.error || "שגיאה בייבוא");
      return;
    }
    setImportMessage(`יובאו ${data.inserted} שואלים בהצלחה (${data.skipped} דולגו).`);
    setImportPreview(null);
    await Promise.all([loadBorrowers(), onReload()]);
  };

  const handleDownloadSampleCsv = () => {
    const csv = "\uFEFFשם מלא,שיעור/קבוצה,טלפון,הערות\nמשה ישראלי,שיעור א׳,050-1112233,\nיוסף חיים מזרחי,שיעור ב׳,052-4445566,אחראי ארון ב׳\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "תבנית_שואלים_לדוגמה.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5 max-w-6xl">
      {/* Top Bar + Summary Metrics */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("circulation.pageTitle")}</h1>
          <p className="text-sm text-[var(--otzar-text-muted)]">
            {t("circulation.pageSubtitle")}
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-5 px-4 py-2 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-sm">
            <div>
              <span className="text-[var(--otzar-text-muted)]">{t("circulation.metricBorrowedNow")} </span>
              <span className="font-bold tabular-nums">{activeLoansCount}</span>
            </div>
            <div className="w-px h-4 bg-[var(--otzar-border-muted)]" />
            <div>
              <span className="text-[var(--otzar-text-muted)]">{t("circulation.metricOverdue")} </span>
              <span className={`font-bold tabular-nums ${overdueLoansCount > 0 ? "text-red-600" : ""}`}>
                {overdueLoansCount}
              </span>
            </div>
            <div className="w-px h-4 bg-[var(--otzar-border-muted)]" />
            <div>
              <span className="text-[var(--otzar-text-muted)]">{t("circulation.metricBorrowers")} </span>
              <span className="font-bold tabular-nums">{borrowers.length}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            title={muted ? t("circulation.soundMutedTitle") : t("circulation.soundActiveTitle")}
            className="p-2.5 rounded-lg border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer text-[var(--otzar-text-muted)]"
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4 text-[var(--otzar-accent)]" />}
          </button>
        </div>
      </div>

      {/* Navigation Sub-tabs */}
      <div className="flex flex-wrap gap-1 p-1 rounded-xl bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] w-fit">
        {[
          { id: "checkout", label: t("circulation.checkoutSubTab"), icon: ArrowLeftRight },
          { id: "return", label: t("circulation.returnSubTab"), icon: RotateCcw },
          { id: "active", label: t("circulation.activeSubTabCount", { count: activeLoansCount }), icon: Clock },
          ...(isAdmin ? [{ id: "borrowers", label: t("circulation.borrowersSubTab"), icon: Users }] : []),
        ].map((t) => {
          const Icon = t.icon;
          const active = subTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id as CircSubTab)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors ${
                active
                  ? "bg-[var(--otzar-accent)] text-white"
                  : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: CHECKOUT */}
      {subTab === "checkout" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Step 1: Select Borrower */}
          <div className="lg:col-span-5 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-base">1. בחירת שואל</h2>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setShowQuickBorrower((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--otzar-accent)] hover:underline cursor-pointer"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  שואל חדש מהיר
                </button>
              )}
            </div>

            {showQuickBorrower && (
              <form onSubmit={handleQuickAddBorrower} className="p-3 rounded-lg bg-[var(--otzar-surface)] border border-[var(--otzar-border)] space-y-2 text-sm">
                <input
                  type="text"
                  required
                  placeholder="שם מלא *"
                  value={quickName}
                  onChange={(e) => setQuickName(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="שיעור / קבוצה"
                    value={quickShiur}
                    onChange={(e) => setQuickShiur(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                  <input
                    type="text"
                    placeholder="טלפון"
                    value={quickPhone}
                    onChange={(e) => setQuickPhone(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setShowQuickBorrower(false)} className="px-2.5 py-1 text-xs cursor-pointer">
                    ביטול
                  </button>
                  <button type="submit" className="px-3 py-1 rounded-md text-xs font-semibold bg-[var(--otzar-accent)] text-white cursor-pointer">
                    הוסף ובחר
                  </button>
                </div>
              </form>
            )}

            <div className="relative">
              <Search className="w-4 h-4 text-[var(--otzar-text-muted)] absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={borrowerSearch}
                onChange={(e) => setBorrowerSearch(e.target.value)}
                placeholder="חפש שואל לפי שם או שיעור..."
                className="w-full pr-9 pl-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] text-sm focus:outline-none focus:border-[var(--otzar-accent)]"
              />
            </div>

            <div className="max-h-80 overflow-y-auto divide-y divide-[var(--otzar-border-muted)] border border-[var(--otzar-border-muted)] rounded-lg">
              {filteredBorrowersForCheckout.length === 0 ? (
                <div className="p-4 text-center text-sm text-[var(--otzar-text-muted)]">לא נמצאו שואלים תואמים</div>
              ) : (
                filteredBorrowersForCheckout.map((b) => {
                  const isSel = b.id === selectedBorrowerId;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => {
                        setSelectedBorrowerId(b.id);
                        setCheckoutError(null);
                        setCheckoutSuccess(null);
                        setTimeout(() => checkoutInputRef.current?.focus(), 40);
                      }}
                      className={`w-full text-right px-3.5 py-2.5 flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                        isSel ? "bg-[var(--otzar-surface)] border-r-4 border-r-[var(--otzar-accent)]" : "hover:bg-[var(--otzar-surface-alt)]"
                      }`}
                    >
                      <div>
                        <div className={`text-sm font-semibold ${isSel ? "text-[var(--otzar-accent)]" : ""}`}>{b.full_name}</div>
                        <div className="text-xs text-[var(--otzar-text-muted)]">
                          {b.shiur_group || "ללא שיעור"} {b.phone ? `· ${b.phone}` : ""}
                        </div>
                      </div>
                      {(b.active_loans_count || 0) > 0 && (
                        <div className={`text-xs font-semibold tabular-nums ${(b.overdue_loans_count || 0) > 0 ? "text-red-600" : "text-[var(--otzar-text-muted)]"}`}>
                          {b.active_loans_count} מושאלים
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Step 2: Scan Barcodes & Checkout Basket */}
          <div className="lg:col-span-7 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--otzar-border-muted)] pb-3">
              <div>
                <h2 className="font-bold text-base">2. סריקת ספרים להשאלה</h2>
                {selectedBorrower ? (
                  <p className="text-sm text-[var(--otzar-accent)] font-semibold">
                    נבחר: {selectedBorrower.full_name} {selectedBorrower.shiur_group ? `(${selectedBorrower.shiur_group})` : ""}
                  </p>
                ) : (
                  <p className="text-sm text-[var(--otzar-text-muted)]">בחר שואל מימין כדי להתחיל לסרוק ספרים.</p>
                )}
              </div>

              <div className="flex items-center gap-2 text-xs">
                <span className="text-[var(--otzar-text-muted)]">משך השאלה (ימים):</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={loanDays}
                  onChange={(e) => setLoanDays(Math.max(1, Number(e.target.value) || 14))}
                  className="w-16 px-2 py-1 rounded-md border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] text-center font-semibold tabular-nums"
                />
              </div>
            </div>

            <form onSubmit={handleScanCheckoutBarcode} className="flex gap-2">
              <div className="relative flex-1">
                <Barcode className="w-5 h-5 text-[var(--otzar-accent)] absolute right-3 top-1/2 -translate-y-1/2" />
                <input
                  ref={checkoutInputRef}
                  type="text"
                  disabled={!selectedBorrower}
                  value={checkoutBarcode}
                  onChange={(e) => setCheckoutBarcode(e.target.value)}
                  placeholder={selectedBorrower ? "סרוק ברקוד ספר או הקלד ולחץ Enter..." : "בחר שואל תחילה..."}
                  className="w-full pr-10 pl-3 py-2.5 rounded-lg border-2 border-[var(--otzar-border)] bg-[var(--otzar-bg)] text-base tabular-nums focus:outline-none focus:border-[var(--otzar-accent)] disabled:opacity-50"
                />
              </div>
              <button
                type="submit"
                disabled={!selectedBorrower || !checkoutBarcode.trim()}
                className="px-4 py-2.5 rounded-lg text-sm font-semibold bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] cursor-pointer disabled:opacity-40"
              >
                הוסף לסל
              </button>
            </form>

            {checkoutError && (
              <div className="flex items-center gap-2 p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 text-sm">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{checkoutError}</span>
              </div>
            )}

            {checkoutSuccess && (
              <div className="flex items-center gap-2 p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-sm font-medium">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{checkoutSuccess}</span>
              </div>
            )}

            {refConfirmPending && (
              <div className="p-4 rounded-lg border border-amber-400 bg-amber-50 text-amber-900 space-y-2.5 text-sm">
                <div className="flex items-center gap-2 font-bold">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>אישור השאלה חריגה</span>
                </div>
                <p>{refConfirmPending}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleConfirmCheckout(true)}
                    className="px-3.5 py-1.5 rounded-md text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 cursor-pointer"
                  >
                    אשר השאלה חריגה
                  </button>
                  <button
                    type="button"
                    onClick={() => setRefConfirmPending(null)}
                    className="px-3.5 py-1.5 rounded-md text-xs border border-amber-400 cursor-pointer"
                  >
                    ביטול
                  </button>
                </div>
              </div>
            )}

            {/* Basket List */}
            <div className="border border-[var(--otzar-border-muted)] rounded-lg divide-y divide-[var(--otzar-border-muted)] min-h-36">
              {basket.length === 0 ? (
                <div className="p-6 text-center text-sm text-[var(--otzar-text-muted)]">
                  עדיין לא נסרקו ספרים בסל ההשאלה. סרוק ברקוד למעלה כדי להוסיף.
                </div>
              ) : (
                basket.map((item) => (
                  <div key={item.barcode} className="p-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-sm flex items-center gap-2">
                        <span>{item.title}</span>
                        {item.volume && <span className="text-xs text-[var(--otzar-text-muted)]">({item.volume})</span>}
                        {item.status === "reference_only" && (
                          <span className="text-xs font-semibold text-amber-700">· לעיון בלבד</span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--otzar-text-muted)] tabular-nums">
                        ברקוד: {item.barcode} {item.cabinet_code ? `· ארון ${item.cabinet_code} מדף ${item.shelf_number ?? "—"}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setBasket((prev) => prev.filter((x) => x.barcode !== item.barcode))}
                      className="p-1.5 rounded-md text-red-600 hover:bg-red-50 cursor-pointer"
                      title="הסר מהרשימה"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-[var(--otzar-text-muted)]">
                תאריך החזרה צפוי: <strong className="tabular-nums text-[var(--otzar-text)]">{formatHebDate(new Date(Date.now() + loanDays * 86400000).toISOString())}</strong>
              </span>
              <button
                type="button"
                disabled={!selectedBorrower || basket.length === 0 || checkingOut}
                onClick={() => handleConfirmCheckout(false)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
              >
                <BookCheck className="w-4 h-4" />
                {checkingOut ? "שומר..." : `אשר השאלה (${basket.length} ספרים)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: QUICK RETURN */}
      {subTab === "return" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] p-5 space-y-4">
            <h2 className="font-bold text-base">סריקת ספר להחזרה</h2>
            <form onSubmit={handleScanReturn} className="flex gap-2">
              <div className="relative flex-1">
                <Barcode className="w-5 h-5 text-[var(--otzar-accent)] absolute right-3 top-1/2 -translate-y-1/2" />
                <input
                  ref={returnInputRef}
                  type="text"
                  value={returnBarcode}
                  onChange={(e) => setReturnBarcode(e.target.value)}
                  placeholder="סרוק ברקוד להחזרה מיידית ולחץ Enter..."
                  className="w-full pr-10 pl-3 py-3 rounded-lg border-2 border-[var(--otzar-border)] bg-[var(--otzar-bg)] text-base tabular-nums focus:outline-none focus:border-[var(--otzar-accent)]"
                />
              </div>
              <button
                type="submit"
                disabled={!returnBarcode.trim()}
                className="px-5 py-3 rounded-lg text-sm font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
              >
                קלוט החזרה
              </button>
            </form>

            {returnError && (
              <div className="flex items-center gap-2 p-3.5 rounded-lg border border-red-300 bg-red-50 text-red-800 text-sm">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{returnError}</span>
              </div>
            )}

            {lastReturn && (
              <div className="p-4 rounded-xl border-2 border-emerald-300 bg-emerald-50 text-emerald-950 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-bold text-base">
                    <CheckCircle2 className="w-5 h-5 text-emerald-700" />
                    <span>הספר הוחזר בהצלחה: {lastReturn.title}</span>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-emerald-800">{lastReturn.barcode}</span>
                </div>
                {lastReturn.borrower_name && (
                  <div className="text-sm">
                    הוחזר מאת: <strong>{lastReturn.borrower_name}</strong>{" "}
                    {lastReturn.borrower_shiur ? `(${lastReturn.borrower_shiur})` : ""}
                    {lastReturn.wasOverdue && <span className="text-red-700 font-semibold mr-2">· הוחזר באיחור</span>}
                  </div>
                )}
                {lastReturn.note && <div className="text-xs text-emerald-800">{lastReturn.note}</div>}
                <div className="pt-2 border-t border-emerald-200 flex items-center gap-2 text-sm font-bold text-emerald-900">
                  <MapPin className="w-4 h-4 text-[var(--otzar-accent)]" />
                  <span>
                    מיקום להחזרה במדף:{" "}
                    {lastReturn.cabinet_code
                      ? `ארון ${lastReturn.cabinet_code} · מדף ${lastReturn.shelf_number ?? "—"}`
                      : "לא משויך ארון במערכת"}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="lg:col-span-5 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] p-4 space-y-3">
            <h3 className="font-bold text-sm border-b border-[var(--otzar-border-muted)] pb-2">
              הוחזרו במשמרת זו ({recentReturns.length})
            </h3>
            {recentReturns.length === 0 ? (
              <p className="text-sm text-[var(--otzar-text-muted)]">טרם נסרקו החזרות במשמרת זו.</p>
            ) : (
              <div className="divide-y divide-[var(--otzar-border-muted)] max-h-80 overflow-y-auto">
                {recentReturns.map((r, i) => (
                  <div key={r.barcode + i} className="py-2.5 flex items-center justify-between gap-2 text-sm">
                    <div>
                      <div className="font-medium">{r.title}</div>
                      <div className="text-xs text-[var(--otzar-text-muted)] tabular-nums">
                        {r.barcode} {r.borrower_name ? `· ${r.borrower_name}` : ""}
                      </div>
                    </div>
                    <div className="text-xs font-semibold text-[var(--otzar-accent)] tabular-nums shrink-0">
                      {r.cabinet_code ? `ארון ${r.cabinet_code} / מדף ${r.shelf_number ?? "-"}` : r.at}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: ACTIVE & OVERDUE LOANS */}
      {subTab === "active" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-1.5">
              {[
                { id: "active", label: "מושאלים כעת" },
                { id: "overdue", label: "מאחרים בלבד" },
                { id: "history", label: "היסטוריית החזרות" },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    const st = f.id as "active" | "overdue" | "history";
                    setLoanFilterStatus(st);
                    loadLoans(st, loanQuery);
                  }}
                  className={`px-3.5 py-1.5 rounded-lg text-sm font-medium border cursor-pointer ${
                    loanFilterStatus === f.id
                      ? "bg-[var(--otzar-surface)] border-[var(--otzar-accent)] text-[var(--otzar-accent)]"
                      : "border-[var(--otzar-border-muted)] text-[var(--otzar-text-muted)]"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="relative w-72">
              <Search className="w-4 h-4 text-[var(--otzar-text-muted)] absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={loanQuery}
                onChange={(e) => {
                  setLoanQuery(e.target.value);
                  loadLoans(loanFilterStatus, e.target.value);
                }}
                placeholder="חפש ספר, שואל או ברקוד..."
                className="w-full pr-9 pl-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-sm"
              />
            </div>
          </div>

          <div className="rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead className="bg-[var(--otzar-surface-alt)] border-b border-[var(--otzar-border-muted)] text-xs text-[var(--otzar-text-muted)]">
                <tr>
                  <th className="py-3 px-4 font-semibold">ברקוד</th>
                  <th className="py-3 px-4 font-semibold">שם הספר</th>
                  <th className="py-3 px-4 font-semibold">שואל</th>
                  <th className="py-3 px-4 font-semibold">תאריך השאלה</th>
                  <th className="py-3 px-4 font-semibold">{loanFilterStatus === "history" ? "תאריך החזרה" : "להחזרה עד"}</th>
                  <th className="py-3 px-4 font-semibold">סטטוס</th>
                  {loanFilterStatus !== "history" && <th className="py-3 px-4 font-semibold">פעולות</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--otzar-border-muted)]">
                {loans.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-[var(--otzar-text-muted)]">
                      אין השאלות להצגה בחתך זה.
                    </td>
                  </tr>
                ) : (
                  loans.map((l) => (
                    <tr key={l.id} className="hover:bg-[var(--otzar-surface-alt)]">
                      <td className="py-3 px-4 font-mono tabular-nums text-xs">{l.book_barcode}</td>
                      <td className="py-3 px-4">
                        <div className="font-semibold">{l.book_title}</div>
                        <div className="text-xs text-[var(--otzar-text-muted)]">
                          {l.book_volume || ""} {l.cabinet_code ? `· ארון ${l.cabinet_code} מדף ${l.shelf_number ?? "-"}` : ""}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium">{l.borrower_name}</div>
                        <div className="text-xs text-[var(--otzar-text-muted)]">
                          {l.borrower_shiur} {l.borrower_phone ? `· ${l.borrower_phone}` : ""}
                        </div>
                      </td>
                      <td className="py-3 px-4 tabular-nums">{formatHebDate(l.loan_date)}</td>
                      <td className="py-3 px-4 tabular-nums">
                        {loanFilterStatus === "history" ? formatHebDate(l.return_date) : formatHebDate(l.due_date)}
                      </td>
                      <td className="py-3 px-4">
                        {l.return_date ? (
                          <span className="text-xs font-medium text-emerald-700">הוחזר</span>
                        ) : l.is_overdue ? (
                          <span className="text-xs font-bold text-red-600 tabular-nums">איחור {l.days_overdue} ימים</span>
                        ) : (
                          <span className="text-xs font-medium text-[var(--otzar-accent)]">בהשאלה</span>
                        )}
                      </td>
                      {loanFilterStatus !== "history" && (
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => executeReturnBarcode(l.book_barcode)}
                              className="px-2.5 py-1 rounded-md text-xs font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                            >
                              קלוט החזרה
                            </button>
                            <button
                              type="button"
                              onClick={() => handleExtendLoan(l.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] cursor-pointer"
                              title="הארך ב-7 ימים"
                            >
                              <CalendarPlus className="w-3.5 h-3.5" />
                              +7 ימים
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: BORROWERS & CSV/EXCEL IMPORT */}
      {isAdmin && subTab === "borrowers" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-72">
              <Search className="w-4 h-4 text-[var(--otzar-text-muted)] absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={borrowerListQuery}
                onChange={(e) => setBorrowerListQuery(e.target.value)}
                placeholder="חפש שואל, שיעור או טלפון..."
                className="w-full pr-9 pl-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-sm"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleDownloadSampleCsv}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                הורד תבנית לדוגמה (CSV)
              </button>

              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleSelectImportFile}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium border border-[var(--otzar-accent)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-surface)] cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4" />
                ייבוא מ-Excel / CSV
              </button>

              <button
                type="button"
                onClick={openAddBorrower}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                הוסף שואל
              </button>
            </div>
          </div>

          {importError && (
            <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 text-sm">{importError}</div>
          )}
          {importMessage && (
            <div className="p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-sm font-medium">
              {importMessage}
            </div>
          )}

          {/* Import Preview Panel */}
          {importPreview && (
            <div className="p-4 rounded-xl border-2 border-[var(--otzar-accent)] bg-[var(--otzar-surface)] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-bold text-base">תצוגה מקדימה לייבוא: {importPreview.filename}</h3>
                  <p className="text-xs text-[var(--otzar-text-muted)] tabular-nums">
                    זוהו {importPreview.validRows} שורות תקינות מתוך {importPreview.totalRows} · כפילויות אפשריות:{" "}
                    {importPreview.duplicateRows}
                  </p>
                </div>
                <label className="inline-flex items-center gap-2 text-xs font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={skipDuplicates}
                    onChange={(e) => setSkipDuplicates(e.target.checked)}
                    className="accent-[var(--otzar-accent)]"
                  />
                  דלג אוטומטית על שואלים שכבר קיימים במערכת
                </label>
              </div>

              <div className="max-h-56 overflow-y-auto rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]">
                <table className="w-full text-xs text-right">
                  <thead className="bg-[var(--otzar-surface-alt)] border-b border-[var(--otzar-border-muted)]">
                    <tr>
                      <th className="py-2 px-3">#</th>
                      <th className="py-2 px-3">שם מלא</th>
                      <th className="py-2 px-3">שיעור / קבוצה</th>
                      <th className="py-2 px-3">טלפון</th>
                      <th className="py-2 px-3">מצב</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--otzar-border-muted)]">
                    {importPreview.rows.slice(0, 80).map((r) => (
                      <tr key={r.rowNumber}>
                        <td className="py-1.5 px-3 tabular-nums text-[var(--otzar-text-muted)]">{r.rowNumber}</td>
                        <td className="py-1.5 px-3 font-medium">{r.full_name || "—"}</td>
                        <td className="py-1.5 px-3">{r.shiur_group}</td>
                        <td className="py-1.5 px-3 tabular-nums">{r.phone}</td>
                        <td className="py-1.5 px-3">
                          {!r.valid ? (
                            <span className="text-red-600">חסר שם</span>
                          ) : r.isDuplicate ? (
                            <span className="text-amber-700">כפיל</span>
                          ) : (
                            <span className="text-emerald-700">חדש</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setImportPreview(null)}
                  className="px-3.5 py-1.5 rounded-lg text-sm border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] cursor-pointer"
                >
                  ביטול
                </button>
                <button
                  type="button"
                  onClick={handleConfirmImport}
                  className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                >
                  אשר וייבא רשימה
                </button>
              </div>
            </div>
          )}

          {/* Add / Edit Borrower Inline Form */}
          {showBorrowerForm && (
            <form
              onSubmit={handleSaveBorrower}
              className="p-4 rounded-xl border border-[var(--otzar-border)] bg-[var(--otzar-surface)] grid grid-cols-1 md:grid-cols-4 gap-3 items-end"
            >
              <div>
                <label className="block text-xs font-medium mb-1">שם מלא *</label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">שיעור / קבוצה</label>
                <input
                  type="text"
                  value={formShiur}
                  onChange={(e) => setFormShiur(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">טלפון</label>
                <input
                  type="text"
                  value={formPhone}
                  onChange={(e) => setFormPhone(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">הערות</label>
                <input
                  type="text"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-sm"
                />
              </div>
              {borrowerFormErr && <div className="md:col-span-4 text-xs text-red-600">{borrowerFormErr}</div>}
              <div className="md:col-span-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowBorrowerForm(false)}
                  className="px-3 py-1.5 rounded-lg text-sm border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] cursor-pointer"
                >
                  ביטול
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                >
                  {editingBorrower ? "שמור שינויים" : "שמור שואל"}
                </button>
              </div>
            </form>
          )}

          {/* Borrowers Table */}
          <div className="rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead className="bg-[var(--otzar-surface-alt)] border-b border-[var(--otzar-border-muted)] text-xs text-[var(--otzar-text-muted)]">
                <tr>
                  <th className="py-3 px-4 font-semibold">שם מלא</th>
                  <th className="py-3 px-4 font-semibold">שיעור / קבוצה</th>
                  <th className="py-3 px-4 font-semibold">טלפון</th>
                  <th className="py-3 px-4 font-semibold">מושאלים כעת</th>
                  <th className="py-3 px-4 font-semibold">הערות</th>
                  <th className="py-3 px-4 font-semibold">פעולות</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--otzar-border-muted)]">
                {filteredBorrowersTable.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-[var(--otzar-text-muted)]">
                      לא נמצאו שואלים.
                    </td>
                  </tr>
                ) : (
                  filteredBorrowersTable.map((b) => (
                    <tr key={b.id} className="hover:bg-[var(--otzar-surface-alt)]">
                      <td className="py-3 px-4 font-semibold">{b.full_name}</td>
                      <td className="py-3 px-4">{b.shiur_group || "—"}</td>
                      <td className="py-3 px-4 tabular-nums">{b.phone || "—"}</td>
                      <td className="py-3 px-4 tabular-nums">
                        {(b.active_loans_count || 0) > 0 ? (
                          <span className={(b.overdue_loans_count || 0) > 0 ? "font-bold text-red-600" : "font-semibold text-[var(--otzar-accent)]"}>
                            {b.active_loans_count} {(b.overdue_loans_count || 0) > 0 ? `(${b.overdue_loans_count} באיחור)` : ""}
                          </span>
                        ) : (
                          <span className="text-[var(--otzar-text-muted)]">0</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-[var(--otzar-text-muted)]">{b.notes || "—"}</td>
                      <td className="py-3 px-4">
                        {confirmDeleteId === b.id ? (
                          <div className="flex items-center gap-2 text-xs">
                            <button
                              type="button"
                              onClick={() => handleDeleteBorrower(b.id)}
                              className="px-2 py-1 rounded bg-red-600 text-white font-semibold cursor-pointer"
                            >
                              אשר מחיקה
                            </button>
                            <button type="button" onClick={() => setConfirmDeleteId(null)} className="px-2 py-1 cursor-pointer">
                              ביטול
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedBorrowerId(b.id);
                                setSubTab("checkout");
                              }}
                              className="px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--otzar-surface)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-soft)] cursor-pointer"
                            >
                              השאל
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditBorrower(b)}
                              className="p-1.5 rounded-md hover:bg-[var(--otzar-surface)] text-[var(--otzar-text-muted)] cursor-pointer"
                              title="ערוך"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(b.id)}
                              className="p-1.5 rounded-md hover:bg-red-50 text-red-600 cursor-pointer"
                              title="מחק"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
