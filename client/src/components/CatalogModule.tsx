import React, { useEffect, useRef, useState } from "react";
import {
  Barcode,
  Camera,
  CheckCircle2,
  FolderOpen,
  ImagePlus,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  Save,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
  AlertTriangle,
} from "lucide-react";
import type { AiQueueItem, CabinetRow } from "../types.ts";
import { getAdminToken } from "../lib/adminSession.ts";

interface CatalogModuleProps {
  cabinets: CabinetRow[];
  nextBarcode: string;
  barcodePrefix: string;
  aiModel: string;
  hasApiKey: boolean;
  onReload: () => Promise<void>;
}

type CatalogSubTab = "manual" | "ai-scan" | "ai-review";

const CATEGORY_SUGGESTIONS = [
  "ש״ס בבלי",
  "הלכה",
  "רמב״ם",
  "תנ״ך",
  "שו״ת",
  "מוסר ומחשבה",
  "חסידות",
  "ראשונים",
  "אחרונים",
  "מדרש ואגדה",
];

async function compressImageToJpeg(
  source: File | HTMLVideoElement,
  maxDim = 1400,
  quality = 0.82
): Promise<{ base64: string; origKb: number; compKb: number }> {
  let width = 0;
  let height = 0;
  let origBytes = 0;
  let drawTarget: CanvasImageSource;

  if (source instanceof File) {
    origBytes = source.size;
    const url = URL.createObjectURL(source);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });
      width = img.naturalWidth || img.width;
      height = img.naturalHeight || img.height;
      drawTarget = img;

      const scale = Math.min(1, maxDim / Math.max(width, height));
      const targetW = Math.max(1, Math.round(width * scale));
      const targetH = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas context unavailable");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, targetW, targetH);
      ctx.drawImage(drawTarget, 0, 0, targetW, targetH);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const base64 = dataUrl.split(",")[1] || "";
      const compBytes = Math.round((base64.length * 3) / 4);
      return {
        base64,
        origKb: Math.max(1, Math.round(origBytes / 1024)),
        compKb: Math.max(1, Math.round(compBytes / 1024)),
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  } else {
    width = source.videoWidth || 1280;
    height = source.videoHeight || 720;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context unavailable");
    ctx.drawImage(source, 0, 0, targetW, targetH);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const base64 = dataUrl.split(",")[1] || "";
    const compBytes = Math.round((base64.length * 3) / 4);
    return {
      base64,
      origKb: Math.max(1, Math.round((width * height) / 1024)),
      compKb: Math.max(1, Math.round(compBytes / 1024)),
    };
  }
}

export const CatalogModule: React.FC<CatalogModuleProps> = ({
  cabinets,
  nextBarcode,
  barcodePrefix,
  aiModel,
  hasApiKey,
  onReload,
}) => {
  const [subTab, setSubTab] = useState<CatalogSubTab>("manual");

  // Manual quick catalog form state
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [volume, setVolume] = useState("");
  const [publisher, setPublisher] = useState("");
  const [pubYear, setPubYear] = useState("");
  const [edition, setEdition] = useState("");
  const [category, setCategory] = useState("הלכה");
  const [tagsText, setTagsText] = useState("");
  const [cabinetId, setCabinetId] = useState<string>(() => (cabinets[0] ? String(cabinets[0].id) : ""));
  const [shelfNumber, setShelfNumber] = useState<number>(1);
  const [status, setStatus] = useState<"available" | "reference_only">("available");
  const [notes, setNotes] = useState("");
  const [copiesCount, setCopiesCount] = useState<number>(1);
  const [savingManual, setSavingManual] = useState(false);
  const [manualNotice, setManualNotice] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  const volumeRef = useRef<HTMLInputElement>(null);

  // AI Queue state
  const [queueItems, setQueueItems] = useState<AiQueueItem[]>([]);
  const [workerRunning, setWorkerRunning] = useState(false);
  const [uploadingAi, setUploadingAi] = useState(false);
  const [compressionStats, setCompressionStats] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // Webcam state (multi-page capture with preview + confirm / add another)
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraErr, setCameraErr] = useState<string | null>(null);
  const [stagedFrames, setStagedFrames] = useState<Array<{ dataUrl: string; base64: string; compKb: number }>>([]);
  const [reviewingShot, setReviewingShot] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Split Review state
  const [selectedQueueId, setSelectedQueueId] = useState<number | null>(null);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [imgZoom, setImgZoom] = useState(1);
  const [imgRotate, setImgRotate] = useState(0);
  const [revTitle, setRevTitle] = useState("");
  const [revAuthor, setRevAuthor] = useState("");
  const [revVolume, setRevVolume] = useState("");
  const [revPublisher, setRevPublisher] = useState("");
  const [revPubYear, setRevPubYear] = useState("");
  const [revEdition, setRevEdition] = useState("");
  const [revCategory, setRevCategory] = useState("הלכה");
  const [revTags, setRevTags] = useState("");
  const [revCabinetId, setRevCabinetId] = useState<string>(() => (cabinets[0] ? String(cabinets[0].id) : ""));
  const [revShelf, setRevShelf] = useState<number>(1);
  const [revStatus, setRevStatus] = useState<"available" | "reference_only">("available");
  const [revCopies, setRevCopies] = useState<number>(1);
  const [revNotes, setRevNotes] = useState("");
  const [approving, setApproving] = useState(false);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!cabinetId && cabinets[0]) setCabinetId(String(cabinets[0].id));
    if (!revCabinetId && cabinets[0]) setRevCabinetId(String(cabinets[0].id));
  }, [cabinets]);

  const selectedManualCab = cabinets.find((c) => String(c.id) === cabinetId) || cabinets[0];
  const selectedRevCab = cabinets.find((c) => String(c.id) === revCabinetId) || cabinets[0];

  const loadQueue = async () => {
    const res = await fetch("/api/ai-queue?approval=pending");
    if (res.ok) {
      const data = await res.json();
      setQueueItems(data.items || []);
      setWorkerRunning(Boolean(data.workerRunning));
    }
  };

  useEffect(() => {
    loadQueue();
  }, []);

  // Poll while worker or pending items active
  useEffect(() => {
    const hasPendingOrProcessing = queueItems.some(
      (i) => i.processing_status === "pending" || i.processing_status === "processing"
    );
    if (!workerRunning && !hasPendingOrProcessing) return;
    const timer = setInterval(() => {
      loadQueue();
    }, 1800);
    return () => clearInterval(timer);
  }, [workerRunning, queueItems]);

  // Keep Split Review form synced when selectedQueueId changes
  const activeReviewItem =
    queueItems.find((i) => i.id === selectedQueueId) ||
    queueItems.find((i) => i.processing_status === "done") ||
    queueItems[0] ||
    null;

  useEffect(() => {
    if (!activeReviewItem) return;
    setSelectedQueueId(activeReviewItem.id);
    setActiveImageIndex(0);
    setImgZoom(1);
    setImgRotate(0);
    const ex = activeReviewItem.extracted;
    setRevTitle(ex?.title || "");
    setRevAuthor(ex?.author || "");
    setRevVolume(ex?.volume || "");
    setRevPublisher(ex?.publisher || "");
    setRevPubYear(ex?.pub_year || "");
    setRevEdition(ex?.edition || "");
    setRevCategory(ex?.category || "הלכה");
    setRevTags(Array.isArray(ex?.tags) ? ex.tags.join(", ") : "");
    setRevNotes(ex?.notes || "");
    setRevCopies(1);
    setRevStatus("available");
  }, [activeReviewItem?.id, activeReviewItem?.processing_status]);

  // Cleanup webcam when leaving tab or closing
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const nextNum = parseInt(nextBarcode || "100001", 10) || 100001;
  const previewStart = barcodePrefix + String(nextNum);
  const previewEnd = barcodePrefix + String(nextNum + Math.max(1, copiesCount) - 1);

  const handleSaveManual = async (keepForNextVolume: boolean) => {
    if (!title.trim()) {
      setManualError("יש להזין שם ספר");
      return;
    }
    setSavingManual(true);
    setManualError(null);
    setManualNotice(null);

    try {
      const res = await fetch("/api/books", {
        method: "POST",
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
          notes: notes.trim(),
          status,
          copiesCount: Math.max(1, copiesCount),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בשמירת הספר");

      setManualNotice(
        `נשמר בהצלחה! נוצרו ברקודים: ${data.barcodes.join(", ")} (התווספו לתור המדבקות)`
      );
      setCopiesCount(1);
      if (keepForNextVolume) {
        setVolume("");
        setTimeout(() => volumeRef.current?.focus(), 40);
      } else {
        setTitle("");
        setAuthor("");
        setVolume("");
        setPublisher("");
        setPubYear("");
        setEdition("");
        setTagsText("");
        setNotes("");
        setTimeout(() => titleRef.current?.focus(), 40);
      }
      await onReload();
    } catch (err: any) {
      setManualError(err?.message || "שגיאה בשמירה");
    } finally {
      setSavingManual(false);
    }
  };

  // Upload batch images with client-side compression
  const handleUploadFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) {
      setAiError("לא נבחרו קבצי תמונה תקינים");
      return;
    }
    setUploadingAi(true);
    setAiError(null);
    setCompressionStats(null);

    try {
      let totalOrig = 0;
      let totalComp = 0;
      const compressedItems: Array<{ filename: string; imageBase64: string; mimeType: string }> = [];

      for (const file of files) {
        const res = await compressImageToJpeg(file, 1400, 0.82);
        totalOrig += res.origKb;
        totalComp += res.compKb;
        compressedItems.push({
          filename: file.name,
          imageBase64: res.base64,
          mimeType: "image/jpeg",
        });
      }

      const resp = await fetch("/api/ai-queue/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: compressedItems,
          autoProcess: hasApiKey,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "שגיאה בהעלאה");

      setCompressionStats(
        `נקלטו ${data.count} תמונות ונדחסו מ-${totalOrig} KB ל-${totalComp} KB (חיסכון של ${Math.max(
          0,
          Math.round((1 - totalComp / Math.max(1, totalOrig)) * 100)
        )}%)`
      );
      await Promise.all([loadQueue(), onReload()]);
    } catch (err: any) {
      setAiError(err?.message || "שגיאה בדחיסה או בהעלאה");
    } finally {
      setUploadingAi(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  };

  const startWebcam = async () => {
    setCameraErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      setCameraOpen(true);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }, 60);
    } catch {
      setCameraErr(
        "לא ניתן לגשת למצלמה. אם דחית בטעות הרשאת מצלמה: לחץ על תפריט ⋯ בפינת החלון ← הגדרות/הרשאות אתר ← מצלמה ← אפשר (או פתח http://127.0.0.1:4747 בדפדפן רגיל ואשר ליד שורת הכתובת)."
      );
    }
  };

  const stopWebcam = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setStagedFrames([]);
    setReviewingShot(false);
    setCameraOpen(false);
  };

  const captureFrameToStage = async () => {
    if (!videoRef.current) return;
    setAiError(null);
    try {
      const { base64, compKb } = await compressImageToJpeg(videoRef.current, 1400, 0.84);
      const dataUrl = `data:image/jpeg;base64,${base64}`;
      setStagedFrames((prev) => [...prev, { dataUrl, base64, compKb }]);
      setReviewingShot(true);
    } catch (err: any) {
      setAiError(err?.message || "שגיאה בצילום מהמצלמה");
    }
  };

  const retakeLastStagedFrame = () => {
    setStagedFrames((prev) => prev.slice(0, -1));
    setReviewingShot(false);
  };

  const confirmStagedBookToQueue = async () => {
    if (stagedFrames.length === 0) return;
    setUploadingAi(true);
    setAiError(null);
    try {
      const totalKb = stagedFrames.reduce((sum, f) => sum + f.compKb, 0);
      const count = stagedFrames.length;
      const res = await fetch("/api/ai-queue/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              images: stagedFrames.map((f) => ({
                imageBase64: f.base64,
                mimeType: "image/jpeg",
              })),
            },
          ],
          autoProcess: hasApiKey,
        }),
      });
      if (!res.ok) throw new Error("שגיאה בשליחת הצילומים לתור");
      setCompressionStats(
        count > 1
          ? `נקלט ספר עם ${count} דפים (${totalKb} KB) ונשלח לתור הפענוח`
          : `תמונת השער צולמה, נדחסה ל-${totalKb} KB ונשלחה לתור הפענוח`
      );
      setStagedFrames([]);
      setReviewingShot(false);
      await Promise.all([loadQueue(), onReload()]);
    } catch (err: any) {
      setAiError(err?.message || "שגיאה בשליחה לתור הפענוח");
    } finally {
      setUploadingAi(false);
    }
  };

  const handleApproveReview = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!activeReviewItem || !revTitle.trim()) return;
    setApproving(true);
    setReviewNotice(null);
    try {
      const res = await fetch(`/api/ai-queue/${activeReviewItem.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: revTitle.trim(),
          author: revAuthor.trim(),
          volume: revVolume.trim(),
          publisher: revPublisher.trim(),
          pub_year: revPubYear.trim(),
          edition: revEdition.trim(),
          category: revCategory.trim(),
          tags: revTags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          cabinet_id: revCabinetId ? Number(revCabinetId) : null,
          shelf_number: revShelf,
          status: revStatus,
          copiesCount: Math.max(1, revCopies),
          notes: revNotes.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה באישור");
      setReviewNotice(`הספר אושר! ברקודים: ${data.barcodes.join(", ")}`);
      await Promise.all([loadQueue(), onReload()]);
    } catch (err: any) {
      setAiError(err?.message || "שגיאה באישור");
    } finally {
      setApproving(false);
    }
  };

  const handleRejectReview = async (id: number) => {
    await fetch(`/api/ai-queue/${id}/reject`, { method: "POST" });
    await Promise.all([loadQueue(), onReload()]);
  };

  const doneCount = queueItems.filter((i) => i.processing_status === "done").length;
  const pendingCount = queueItems.filter(
    (i) => i.processing_status === "pending" || i.processing_status === "processing"
  ).length;
  const errorCount = queueItems.filter((i) => i.processing_status === "error").length;

  return (
    <div className="space-y-5 max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">קטלוג והוספת ספרים</h1>
          <p className="text-sm text-[var(--otzar-text-muted)]">
            הוספה מהירה עם ברקודים עוקבים לריבוי עותקים, או צילום וסריקת שערי ספרים לפענוח פרטים אוטומטי.
          </p>
        </div>

        <div className="px-3.5 py-2 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs flex items-center gap-3">
          <span className="text-[var(--otzar-text-muted)]">ברקוד רץ הבא:</span>
          <strong className="font-mono text-sm tabular-nums text-[var(--otzar-accent)]">{previewStart}</strong>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex flex-wrap gap-1 p-1 rounded-xl bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] w-fit">
        {[
          { id: "manual", label: "קטלוג מהיר", icon: Layers },
          { id: "ai-scan", label: `סריקה וצילום שערים (${queueItems.length})`, icon: Camera },
          { id: "ai-review", label: `בדיקה ואישור (${doneCount} מוכנים)`, icon: CheckCircle2 },
        ].map((t) => {
          const Icon = t.icon;
          const active = subTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id as CatalogSubTab)}
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

      {/* SUB-TAB 1: MANUAL FAST CATALOG */}
      {subTab === "manual" && (
        <div className="rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] p-5 space-y-4">
          {manualNotice && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-sm font-medium">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{manualNotice}</span>
            </div>
          )}
          {manualError && (
            <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 text-sm">{manualError}</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 text-sm">
            <div className="md:col-span-5">
              <label className="block text-xs font-medium mb-1">שם הספר *</label>
              <input
                ref={titleRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="למשל: קצות החושן"
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              />
            </div>

            <div className="md:col-span-4">
              <label className="block text-xs font-medium mb-1">מחבר / מפרש</label>
              <input
                type="text"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="למשל: רבי אריה לייב הלר"
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              />
            </div>

            <div className="md:col-span-3">
              <label className="block text-xs font-medium mb-1">כרך / חלק / מסכת</label>
              <input
                ref={volumeRef}
                type="text"
                value={volume}
                onChange={(e) => setVolume(e.target.value)}
                placeholder="למשל: חלק א׳"
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              />
            </div>

            <div className="md:col-span-3">
              <label className="block text-xs font-medium mb-1">קטגוריה</label>
              <input
                list="otzar-categories-list"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              />
              <datalist id="otzar-categories-list">
                {CATEGORY_SUGGESTIONS.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>

            <div className="md:col-span-3">
              <label className="block text-xs font-medium mb-1">הוצאה / מכון</label>
              <input
                type="text"
                value={publisher}
                onChange={(e) => setPublisher(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              />
            </div>

            <div className="md:col-span-3">
              <label className="block text-xs font-medium mb-1">מהדורה (אופציונלי)</label>
              <input
                type="text"
                value={edition}
                onChange={(e) => setEdition(e.target.value)}
                placeholder="למשל: מהדורה מתוקנת / מורחבת"
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              />
            </div>

            <div className="md:col-span-3">
              <label className="block text-xs font-medium mb-1">שנת הוצאה (אופציונלי)</label>
              <input
                type="text"
                value={pubYear}
                onChange={(e) => setPubYear(e.target.value)}
                placeholder="למשל: תשפ״ד / 2024"
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              />
            </div>

            <div className="md:col-span-6">
              <label className="block text-xs font-medium mb-1">תגיות חיפוש וכינויים (מופרדות בפסיק)</label>
              <input
                type="text"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="למשל: חושן משפט, קצוה״ח, ממון, פוסקים"
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              />
            </div>

            <div className="md:col-span-3">
              <label className="block text-xs font-medium mb-1">ארון במפה</label>
              <select
                value={cabinetId}
                onChange={(e) => {
                  setCabinetId(e.target.value);
                  setShelfNumber(1);
                }}
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              >
                {cabinets.map((c) => (
                  <option key={c.id} value={c.id}>
                    ארון {c.code} ({c.main_subject})
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium mb-1">
                מדף (1–{selectedManualCab?.shelves_count || 6})
              </label>
              <input
                type="number"
                min={1}
                max={selectedManualCab?.shelves_count || 20}
                value={shelfNumber}
                onChange={(e) => setShelfNumber(Math.max(1, Number(e.target.value) || 1))}
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium mb-1">סטטוס השאלה</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as "available" | "reference_only")}
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              >
                <option value="available">זמין להשאלה</option>
                <option value="reference_only">לעיון בלבד</option>
              </select>
            </div>

            <div className="md:col-span-3">
              <label className="block text-xs font-medium mb-1">כמות עותקים זהים</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={copiesCount}
                  onChange={(e) => setCopiesCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                  className="w-24 px-3 py-2 rounded-lg border-2 border-[var(--otzar-border)] bg-[var(--otzar-surface)] font-bold tabular-nums text-center"
                />
                <span className="text-xs text-[var(--otzar-text-muted)] font-mono tabular-nums">
                  {copiesCount > 1 ? `${previewStart}–${previewEnd}` : previewStart}
                </span>
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
            <div className="text-xs text-[var(--otzar-text-muted)] flex items-center gap-1.5">
              <Barcode className="w-4 h-4 text-[var(--otzar-accent)]" />
              <span>כל העותקים יקבלו ברקוד עוקב ויתווספו אוטומטית לתור הדפסת המדבקות.</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={savingManual || !title.trim()}
                onClick={() => handleSaveManual(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border border-[var(--otzar-accent)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-surface)] cursor-pointer disabled:opacity-40"
              >
                <Layers className="w-4 h-4" />
                שמור והמשך לכרך/עותק הבא
              </button>
              <button
                type="button"
                disabled={savingManual || !title.trim()}
                onClick={() => handleSaveManual(false)}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
              >
                <Save className="w-4 h-4" />
                {savingManual ? "שומר..." : "שמור והוסף לתור מדבקות"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 2: AI SCAN & UPLOAD + WEBCAM */}
      {subTab === "ai-scan" && (
        <div className="space-y-4">
          {!hasApiKey && (
            <div className="flex items-center gap-2 p-3.5 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                שירות פענוח השערים האוטומטי עדיין לא הוגדר (במסך מפה והגדרות &rarr; הגדרות תצוגה ומערכת). ניתן עדיין לצלם או להעלות תמונות ולבצע פענוח לאחר ההגדרה.
              </span>
            </div>
          )}

          {aiError && (
            <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-800 text-sm">{aiError}</div>
          )}
          {compressionStats && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-sm">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{compressionStats}</span>
            </div>
          )}

          {/* Upload Dropzone & Webcam */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handleUploadFiles(e.dataTransfer.files);
              }}
              className="lg:col-span-7 rounded-xl border-2 border-dashed border-[var(--otzar-border)] bg-[var(--otzar-surface)] p-6 flex flex-col items-center justify-center text-center space-y-3"
            >
              <ImagePlus className="w-9 h-9 text-[var(--otzar-accent)]" />
              <div>
                <div className="font-bold text-base">גרור לכאן צילומי שערי ספרים (או בחר קבצים/תיקייה)</div>
                <p className="text-xs text-[var(--otzar-text-muted)] mt-1">
                  כל תמונה מותאמת ונדחסת אוטומטית לפני השמירה לחיסכון בנפח האחסון.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => handleUploadFiles(e.target.files)}
                  className="hidden"
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  {...({ webkitdirectory: "" } as Record<string, string>)}
                  onChange={(e) => handleUploadFiles(e.target.files)}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={uploadingAi}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                >
                  <Upload className="w-4 h-4" />
                  {uploadingAi ? "דוחס ומעלה..." : "בחר תמונות"}
                </button>
                <button
                  type="button"
                  disabled={uploadingAi}
                  onClick={() => folderInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] hover:bg-[var(--otzar-surface-alt)] cursor-pointer"
                >
                  <FolderOpen className="w-4 h-4" />
                  בחר תיקייה שלמה
                </button>
              </div>
            </div>

            <div className="lg:col-span-5 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-sm flex items-center gap-1.5">
                  <Camera className="w-4 h-4 text-[var(--otzar-accent)]" />
                  צילום שער ספר ממצלמת רשת
                </h3>
                {cameraOpen && (
                  <button type="button" onClick={stopWebcam} className="text-xs text-red-600 cursor-pointer flex items-center gap-1">
                    <X className="w-3.5 h-3.5" />
                    סגור מצלמה
                  </button>
                )}
              </div>

              {cameraErr && <div className="text-xs text-red-600">{cameraErr}</div>}

              {!cameraOpen ? (
                <div className="h-40 rounded-lg bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)] flex flex-col items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={startWebcam}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--otzar-accent)] text-white hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                  >
                    <Camera className="w-4 h-4" />
                    הפעל מצלמה
                  </button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {/* Keep video mounted so switching between shot preview & viewfinder is instant */}
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    className={`w-full h-44 object-cover rounded-lg bg-black ${reviewingShot ? "hidden" : "block"}`}
                  />

                  {reviewingShot && stagedFrames.length > 0 && (
                    <div className="relative h-44 rounded-lg bg-black/5 border border-[var(--otzar-border-muted)] overflow-hidden flex items-center justify-center">
                      <img
                        src={stagedFrames[stagedFrames.length - 1].dataUrl}
                        alt="תצוגה מקדימה של הדף שצולם"
                        className="max-h-full max-w-full object-contain"
                      />
                      <span className="absolute top-2 right-2 px-2 py-0.5 rounded bg-black/70 text-white text-[11px] font-medium tabular-nums">
                        דף {stagedFrames.length} ({stagedFrames[stagedFrames.length - 1].compKb} KB)
                      </span>
                    </div>
                  )}

                  {stagedFrames.length > 0 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto py-1">
                      {stagedFrames.map((f, idx) => (
                        <div key={idx} className="relative shrink-0">
                          <img
                            src={f.dataUrl}
                            alt={`דף ${idx + 1}`}
                            className="w-10 h-12 object-cover rounded border border-[var(--otzar-border)]"
                          />
                          <span className="absolute bottom-0 right-0 px-1 bg-black/70 text-white text-[9px] rounded-tl tabular-nums">
                            {idx + 1}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setStagedFrames((prev) => {
                                const next = prev.filter((_, i) => i !== idx);
                                if (next.length === 0) setReviewingShot(false);
                                return next;
                              });
                            }}
                            className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-red-600 text-white flex items-center justify-center text-[10px] cursor-pointer"
                            title="הסר דף"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {!reviewingShot ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={uploadingAi}
                        onClick={captureFrameToStage}
                        className="flex-1 py-2 rounded-lg text-sm font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer inline-flex items-center justify-center gap-1.5"
                      >
                        <Camera className="w-4 h-4" />
                        {stagedFrames.length > 0 ? `צלם דף ${stagedFrames.length + 1}` : "צלם תמונה"}
                      </button>
                      {stagedFrames.length > 0 && (
                        <button
                          type="button"
                          disabled={uploadingAi}
                          onClick={confirmStagedBookToQueue}
                          className="px-3.5 py-2 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 cursor-pointer inline-flex items-center gap-1"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          אישור ({stagedFrames.length})
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          disabled={uploadingAi}
                          onClick={confirmStagedBookToQueue}
                          className="py-2 px-3 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 cursor-pointer inline-flex items-center justify-center gap-1.5"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          {uploadingAi ? "שולח..." : `אישור (${stagedFrames.length} ${stagedFrames.length === 1 ? "דף" : "דפים"})`}
                        </button>
                        <button
                          type="button"
                          disabled={uploadingAi}
                          onClick={() => setReviewingShot(false)}
                          className="py-2 px-3 rounded-lg text-xs font-bold border border-[var(--otzar-accent)] text-[var(--otzar-accent)] bg-[var(--otzar-surface)] hover:bg-[var(--otzar-accent-soft)] cursor-pointer inline-flex items-center justify-center gap-1.5"
                        >
                          <Camera className="w-4 h-4" />
                          צילום תמונה נוספת
                        </button>
                      </div>
                      <button
                        type="button"
                        disabled={uploadingAi}
                        onClick={retakeLastStagedFrame}
                        className="w-full py-1 text-[11px] text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)] cursor-pointer"
                      >
                        צלם שוב (החלף תמונה אחרונה)
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Queue Monitor Bar */}
          <div className="rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4 text-sm tabular-nums">
                <span>ממתינים/בעיבוד: <strong>{pendingCount}</strong></span>
                <span>מוכנים לאישור: <strong className="text-emerald-700">{doneCount}</strong></span>
                <span>שגיאות: <strong className="text-red-600">{errorCount}</strong></span>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await fetch("/api/ai-queue/process", { method: "POST" });
                    loadQueue();
                  }}
                  disabled={pendingCount === 0}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold border border-[var(--otzar-border-muted)] hover:bg-[var(--otzar-surface)] cursor-pointer disabled:opacity-40"
                >
                  {workerRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  הפעל עיבוד תור
                </button>
                {doneCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setSubTab("ai-review")}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    עבור לאישור ({doneCount})
                  </button>
                )}
              </div>
            </div>

            {queueItems.length > 0 && (
              <div className="divide-y divide-[var(--otzar-border-muted)] max-h-64 overflow-y-auto">
                {queueItems.map((item) => (
                  <div key={item.id} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                    <div className="flex items-center gap-3">
                      {item.has_image && (
                        <img
                          src={`/api/ai-queue/image/${item.id}?adminToken=${encodeURIComponent(getAdminToken())}`}
                          alt=""
                          className="w-10 h-12 object-cover rounded border border-[var(--otzar-border-muted)]"
                        />
                      )}
                      <div>
                        <div className="font-semibold">
                          {item.extracted?.title || `פריט #${item.id}`}
                          {(item.image_count ?? 1) > 1 && (
                            <span className="mr-2 text-xs font-normal text-[var(--otzar-accent)]">
                              ({item.image_count} דפים)
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-[var(--otzar-text-muted)]">
                          {item.processing_status === "pending" && "ממתין בתור..."}
                          {item.processing_status === "processing" && "מפענח פרטי ספר..."}
                          {item.processing_status === "done" &&
                            `פוענח: ${item.extracted?.author || ""} (${item.extracted?.tags?.length || 0} תגיות)`}
                          {item.processing_status === "error" && (
                            <span className="text-red-600">{item.error_message}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {item.processing_status === "error" && (
                        <button
                          type="button"
                          onClick={async () => {
                            await fetch(`/api/ai-queue/${item.id}/retry`, { method: "POST" });
                            loadQueue();
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs border border-[var(--otzar-border-muted)] cursor-pointer"
                        >
                          <RefreshCw className="w-3 h-3" />
                          נסה שנית
                        </button>
                      )}
                      {item.processing_status === "done" && (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedQueueId(item.id);
                            setSubTab("ai-review");
                          }}
                          className="px-3 py-1 rounded text-xs font-semibold bg-[var(--otzar-surface)] text-[var(--otzar-accent)] cursor-pointer"
                        >
                          בדוק ואשר
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={async () => {
                          await fetch(`/api/ai-queue/${item.id}`, { method: "DELETE" });
                          loadQueue();
                          onReload();
                        }}
                        className="p-1.5 text-red-600 hover:bg-red-50 rounded cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* SUB-TAB 3: SPLIT-VIEW AI REVIEW QUEUE */}
      {subTab === "ai-review" && (
        <div className="space-y-4">
          {reviewNotice && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-sm font-medium">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{reviewNotice}</span>
            </div>
          )}

          {!activeReviewItem ? (
            <div className="p-8 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-center space-y-2">
              <p className="font-semibold">אין כרגע ספרים שממתינים לאישור.</p>
              <button
                type="button"
                onClick={() => setSubTab("ai-scan")}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] cursor-pointer"
              >
                העלה או צלם שערי ספרים
              </button>
            </div>
          ) : (
            <>
              {/* Queue Strip */}
              <div className="flex gap-2 overflow-x-auto pb-1">
                {queueItems.map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => setSelectedQueueId(q.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap cursor-pointer ${
                      activeReviewItem.id === q.id
                        ? "border-[var(--otzar-accent)] bg-[var(--otzar-surface)] text-[var(--otzar-accent)]"
                        : "border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                    }`}
                  >
                    #{q.id} · {q.extracted?.title || (q.processing_status === "error" ? "שגיאה" : "ממתין")}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                {/* Image Viewer with Zoom & Rotate */}
                <div className="lg:col-span-5 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] p-3 space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold">
                      צילום שער הספר (#{activeReviewItem.id})
                      {(activeReviewItem.image_count ?? 1) > 1 ? ` · דף ${activeImageIndex + 1} מתוך ${activeReviewItem.image_count}` : ""}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setImgZoom((z) => Math.max(0.75, z - 0.25))}
                        className="p-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] cursor-pointer"
                        title="הקטן"
                      >
                        <ZoomOut className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setImgZoom((z) => Math.min(2.5, z + 0.25))}
                        className="p-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] cursor-pointer"
                        title="הגדל"
                      >
                        <ZoomIn className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setImgRotate((r) => (r + 90) % 360)}
                        className="p-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] cursor-pointer"
                        title="סובב 90°"
                      >
                        <RotateCw className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  {(activeReviewItem.image_count ?? 1) > 1 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {Array.from({ length: activeReviewItem.image_count || 1 }, (_, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setActiveImageIndex(i)}
                          className={`px-2.5 py-1 rounded text-xs font-medium border cursor-pointer ${
                            activeImageIndex === i
                              ? "bg-[var(--otzar-accent)] border-[var(--otzar-accent)] text-white"
                              : "bg-[var(--otzar-bg)] border-[var(--otzar-border-muted)] text-[var(--otzar-text-muted)]"
                          }`}
                        >
                          דף {i + 1}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="h-[430px] overflow-auto rounded-lg border border-[var(--otzar-border-muted)] bg-black/5 flex items-center justify-center p-2">
                    {activeReviewItem.has_image ? (
                      <img
                        src={`/api/ai-queue/image/${activeReviewItem.id}?index=${activeImageIndex}&adminToken=${encodeURIComponent(getAdminToken())}`}
                        alt="שער הספר"
                        style={{
                          transform: `scale(${imgZoom}) rotate(${imgRotate}deg)`,
                          transformOrigin: "center",
                          transition: "transform 150ms ease",
                        }}
                        className="max-h-full max-w-full object-contain"
                      />
                    ) : (
                      <span className="text-xs text-[var(--otzar-text-muted)]">תמונה לא זמינה</span>
                    )}
                  </div>
                </div>

                {/* Editable Form */}
                <form
                  onSubmit={handleApproveReview}
                  className="lg:col-span-7 rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] p-5 space-y-3.5 text-sm"
                >
                  {activeReviewItem.processing_status === "error" && (
                    <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs flex items-center justify-between">
                      <span>{activeReviewItem.error_message}</span>
                      <button
                        type="button"
                        onClick={async () => {
                          await fetch(`/api/ai-queue/${activeReviewItem.id}/retry`, { method: "POST" });
                          loadQueue();
                        }}
                        className="px-2.5 py-1 rounded bg-white border border-red-300 font-semibold cursor-pointer"
                      >
                        נסה שוב
                      </button>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="md:col-span-2">
                      <label className="block text-xs font-medium mb-1">שם הספר *</label>
                      <input
                        type="text"
                        required
                        value={revTitle}
                        onChange={(e) => setRevTitle(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-semibold"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">מחבר / מפרש</label>
                      <input
                        type="text"
                        value={revAuthor}
                        onChange={(e) => setRevAuthor(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">כרך / חלק</label>
                      <input
                        type="text"
                        value={revVolume}
                        onChange={(e) => setRevVolume(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">קטגוריה</label>
                      <input
                        list="otzar-categories-list"
                        value={revCategory}
                        onChange={(e) => setRevCategory(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">הוצאה לאור</label>
                      <input
                        type="text"
                        value={revPublisher}
                        onChange={(e) => setRevPublisher(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">מהדורה (אופציונלי)</label>
                      <input
                        type="text"
                        value={revEdition}
                        onChange={(e) => setRevEdition(e.target.value)}
                        placeholder="למשל: מהדורה מתוקנת"
                        className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">שנת הוצאה (אופציונלי)</label>
                      <input
                        type="text"
                        value={revPubYear}
                        onChange={(e) => setRevPubYear(e.target.value)}
                        placeholder="למשל: תשפ״ד / 2024"
                        className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-xs font-medium mb-1">תגיות חיפוש ונושאים (ניתנות לעריכה)</label>
                      <input
                        type="text"
                        value={revTags}
                        onChange={(e) => setRevTags(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">ארון במפה</label>
                      <select
                        value={revCabinetId}
                        onChange={(e) => {
                          setRevCabinetId(e.target.value);
                          setRevShelf(1);
                        }}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                      >
                        {cabinets.map((c) => (
                          <option key={c.id} value={c.id}>
                            ארון {c.code}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs font-medium mb-1">
                          מדף (1–{selectedRevCab?.shelves_count || 6})
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={selectedRevCab?.shelves_count || 20}
                          value={revShelf}
                          onChange={(e) => setRevShelf(Math.max(1, Number(e.target.value) || 1))}
                          className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1">עותקים זהים</label>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={revCopies}
                          onChange={(e) => setRevCopies(Math.max(1, Number(e.target.value) || 1))}
                          className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">סטטוס</label>
                      <select
                        value={revStatus}
                        onChange={(e) => setRevStatus(e.target.value as "available" | "reference_only")}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                      >
                        <option value="available">זמין להשאלה</option>
                        <option value="reference_only">לעיון בלבד</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">הערות</label>
                      <input
                        type="text"
                        value={revNotes}
                        onChange={(e) => setRevNotes(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                      />
                    </div>
                  </div>

                  <div className="pt-3 border-t border-[var(--otzar-border-muted)] flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => handleRejectReview(activeReviewItem.id)}
                      className="px-3 py-2 rounded-lg text-xs font-medium text-red-600 hover:bg-red-50 cursor-pointer"
                    >
                      דחה והסר מהתור
                    </button>
                    <button
                      type="submit"
                      disabled={approving || !revTitle.trim()}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      {approving ? "מאשר..." : "אשר והוסף לאוצר (Enter)"}
                    </button>
                  </div>
                </form>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
