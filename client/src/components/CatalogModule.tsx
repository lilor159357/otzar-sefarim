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
  Plus,
  Sparkles,
  BookCopy,
} from "lucide-react";
import { FORMAT_SIZE_OPTIONS, type AiQueueItem, type CabinetRow } from "../types.ts";
import { getAdminToken } from "../lib/adminSession.ts";
import { AutocompleteInput } from "./AutocompleteInput.tsx";
import { suggestNextVolume } from "../lib/torahUtils.ts";

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
  const [setName, setSetName] = useState("");
  const [author, setAuthor] = useState("");
  const [volume, setVolume] = useState("");
  const [nextVolSuggestion, setNextVolSuggestion] = useState("");
  const [publisher, setPublisher] = useState("");
  const [pubYear, setPubYear] = useState("");
  const [edition, setEdition] = useState("");
  const [category, setCategory] = useState("הלכה");
  const [tagsText, setTagsText] = useState("");
  const [formatSize, setFormatSize] = useState("");
  const [thicknessMm, setThicknessMm] = useState("");
  const [pagesCount, setPagesCount] = useState("");
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

  // Sticky Set & Shelf-Set Capture modes
  const [scanMode, setScanMode] = useState<"standard" | "shelf-set">("standard");
  const [stickySetEnabled, setStickySetEnabled] = useState(false);
  const [stickyBatchId, setStickyBatchId] = useState<string>(() => `batch_${Date.now()}`);
  const [stickyPresetSetName, setStickyPresetSetName] = useState("");
  const [shelfTitleImage, setShelfTitleImage] = useState<{ dataUrl: string; base64: string; compKb: number } | null>(null);
  const [shelfSpineImages, setShelfSpineImages] = useState<Array<{ dataUrl: string; base64: string; compKb: number }>>([]);
  const [shelfCabId, setShelfCabId] = useState<string>(() => (cabinets[0] ? String(cabinets[0].id) : ""));
  const [shelfNum, setShelfNum] = useState<number>(1);
  const [shelfPresetSetName, setShelfPresetSetName] = useState("");
  const shelfTitleInputRef = useRef<HTMLInputElement>(null);
  const shelfSpineInputRef = useRef<HTMLInputElement>(null);

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
  const [revSetName, setRevSetName] = useState("");
  const [revAuthor, setRevAuthor] = useState("");
  const [revVolume, setRevVolume] = useState("");
  const [revVolumes, setRevVolumes] = useState<Array<{ volume: string; copiesCount: number; notes?: string }>>([]);
  const [applyingBatch, setApplyingBatch] = useState(false);
  const [revPublisher, setRevPublisher] = useState("");
  const [revPubYear, setRevPubYear] = useState("");
  const [revEdition, setRevEdition] = useState("");
  const [revCategory, setRevCategory] = useState("הלכה");
  const [revTags, setRevTags] = useState("");
  const [revFormatSize, setRevFormatSize] = useState("");
  const [revThicknessMm, setRevThicknessMm] = useState("");
  const [revPagesCount, setRevPagesCount] = useState("");
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
    if (!shelfCabId && cabinets[0]) setShelfCabId(String(cabinets[0].id));
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
    setRevTitle(ex?.title || ex?.set_name || "");
    setRevSetName(ex?.set_name || "");
    setRevAuthor(ex?.author || "");
    setRevVolume(ex?.volume || "");
    const rawVols =
      Array.isArray(ex?.volumes) && ex.volumes.length > 0
        ? ex.volumes
        : Array.isArray(activeReviewItem.spine_extracted) && activeReviewItem.spine_extracted.length > 0
        ? activeReviewItem.spine_extracted
        : [];
    setRevVolumes(
      activeReviewItem.is_shelf_set
        ? rawVols.length > 0
          ? rawVols.map((v) => ({
              volume: String(v.volume || ""),
              copiesCount: Math.max(1, Number(v.copiesCount) || 1),
              notes: v.notes ? String(v.notes) : "",
            }))
          : [{ volume: ex?.volume || "חלק א׳", copiesCount: 1, notes: "" }]
        : []
    );
    setRevPublisher(ex?.publisher || "");
    setRevPubYear(ex?.pub_year || "");
    setRevEdition(ex?.edition || "");
    setRevCategory(ex?.category || "הלכה");
    setRevTags(Array.isArray(ex?.tags) ? ex.tags.join(", ") : "");
    setRevFormatSize((ex as any)?.format_size || "");
    setRevThicknessMm("");
    setRevPagesCount("");
    setRevNotes(ex?.notes || "");
    setRevCopies(1);
    setRevStatus("available");
    if (activeReviewItem.default_cabinet_id) {
      setRevCabinetId(String(activeReviewItem.default_cabinet_id));
    }
    if (activeReviewItem.default_shelf_number) {
      setRevShelf(activeReviewItem.default_shelf_number);
    }
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
          set_name: setName.trim(),
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
        const nextSuggested = suggestNextVolume(volume);
        setVolume("");
        setNextVolSuggestion(nextSuggested);
        setTimeout(() => volumeRef.current?.focus(), 40);
      } else {
        setTitle("");
        setSetName("");
        setAuthor("");
        setVolume("");
        setNextVolSuggestion("");
        setPublisher("");
        setPubYear("");
        setEdition("");
        setTagsText("");
        setFormatSize("");
        setThicknessMm("");
        setPagesCount("");
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
          set_batch_id: stickySetEnabled ? stickyBatchId : null,
          preset_set_name: stickySetEnabled ? stickyPresetSetName.trim() : "",
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
          set_batch_id: stickySetEnabled ? stickyBatchId : null,
          preset_set_name: stickySetEnabled ? stickyPresetSetName.trim() : "",
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

  const handlePickShelfTitleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const file = Array.from(fileList).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    setUploadingAi(true);
    setAiError(null);
    try {
      const res = await compressImageToJpeg(file, 1400, 0.82);
      setShelfTitleImage({ dataUrl: `data:image/jpeg;base64,${res.base64}`, base64: res.base64, compKb: res.compKb });
    } catch (err: any) {
      setAiError(err?.message || "שגיאה בטעינת תמונת השער");
    } finally {
      setUploadingAi(false);
      if (shelfTitleInputRef.current) shelfTitleInputRef.current.value = "";
    }
  };

  const handlePickShelfSpineFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    setUploadingAi(true);
    setAiError(null);
    try {
      const next: Array<{ dataUrl: string; base64: string; compKb: number }> = [];
      for (const f of files) {
        const res = await compressImageToJpeg(f, 1400, 0.82);
        next.push({ dataUrl: `data:image/jpeg;base64,${res.base64}`, base64: res.base64, compKb: res.compKb });
      }
      setShelfSpineImages((prev) => [...prev, ...next]);
    } catch (err: any) {
      setAiError(err?.message || "שגיאה בטעינת תמונות השדרות");
    } finally {
      setUploadingAi(false);
      if (shelfSpineInputRef.current) shelfSpineInputRef.current.value = "";
    }
  };

  const handleSubmitShelfSet = async () => {
    if (!shelfTitleImage) {
      setAiError("יש לצרף תמונת שער מייצגת עבור הסט");
      return;
    }
    setUploadingAi(true);
    setAiError(null);
    setCompressionStats(null);
    try {
      const res = await fetch("/api/ai-queue/upload-shelf-set", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleImage: { imageBase64: shelfTitleImage.base64, mimeType: "image/jpeg" },
          spineImages: shelfSpineImages.map((s) => ({ imageBase64: s.base64, mimeType: "image/jpeg" })),
          default_cabinet_id: shelfCabId ? Number(shelfCabId) : null,
          default_shelf_number: shelfNum,
          set_batch_id: stickySetEnabled ? stickyBatchId : null,
          preset_set_name: shelfPresetSetName.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בשליחת הסט לתור");
      setCompressionStats(`סט מהמדף נשלח לפענוח (שער + ${shelfSpineImages.length} תמונות שדרות)`);
      setShelfTitleImage(null);
      setShelfSpineImages([]);
      setShelfPresetSetName("");
      await Promise.all([loadQueue(), onReload()]);
    } catch (err: any) {
      setAiError(err?.message || "שגיאה בשליחת הסט מהמדף");
    } finally {
      setUploadingAi(false);
    }
  };

  const handleApplyBatchDetails = async () => {
    if (!activeReviewItem?.set_batch_id) return;
    setApplyingBatch(true);
    setReviewNotice(null);
    try {
      const res = await fetch("/api/ai-queue/batch-apply-set", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: activeReviewItem.set_batch_id,
          set_name: revSetName.trim() || revTitle.trim(),
          author: revAuthor.trim(),
          publisher: revPublisher.trim(),
          category: revCategory.trim(),
          default_cabinet_id: revCabinetId ? Number(revCabinetId) : null,
          default_shelf_number: revShelf,
          format_size: revFormatSize.trim(),
          edition: revEdition.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בהחלת פרטי הסט");
      setReviewNotice(`פרטי הסט הוחלו בהצלחה על ${data.updatedCount} פריטים במקבץ!`);
      await loadQueue();
    } catch (err: any) {
      setAiError(err?.message || "שגיאה בהחלת פרטי הסט");
    } finally {
      setApplyingBatch(false);
    }
  };

  const handleApproveReview = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!activeReviewItem) return;
    const isBatchShelfSet = Boolean(activeReviewItem.is_shelf_set);
    const cleanedVolumes = revVolumes.filter((v) => v.volume.trim());
    const effectiveTitle = revTitle.trim() || revSetName.trim();
    if (!isBatchShelfSet && !effectiveTitle) return;
    if (isBatchShelfSet && cleanedVolumes.length === 0) {
      setAiError("יש להגדיר לפחות כרך אחד בטבלת הסט לפני אישור");
      return;
    }
    setApproving(true);
    setReviewNotice(null);
    setAiError(null);
    try {
      const res = await fetch(`/api/ai-queue/${activeReviewItem.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: effectiveTitle,
          set_name: revSetName.trim(),
          author: revAuthor.trim(),
          volume: revVolume.trim(),
          volumes: isBatchShelfSet ? cleanedVolumes : undefined,
          publisher: revPublisher.trim(),
          pub_year: revPubYear.trim(),
          edition: revEdition.trim(),
          category: revCategory.trim(),
          tags: revTags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          format_size: revFormatSize.trim(),
          thickness_mm: revThicknessMm.trim() ? Number(revThicknessMm) : null,
          pages_count: revPagesCount.trim() ? Number(revPagesCount) : null,
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
            <div className="md:col-span-4">
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

            <div className="md:col-span-3">
              <AutocompleteInput
                label="שם הסט / סדרה (אופציונלי)"
                field="set_name"
                value={setName}
                onChange={setSetName}
                placeholder="למשל: ש״ס וילנא / משנה ברורה"
              />
            </div>

            <div className="md:col-span-3">
              <AutocompleteInput
                label="מחבר / מפרש"
                field="author"
                value={author}
                onChange={setAuthor}
                placeholder="למשל: רבי אריה לייב הלר"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium mb-1">כרך / חלק / מסכת</label>
              <input
                ref={volumeRef}
                type="text"
                value={volume}
                onChange={(e) => {
                  setVolume(e.target.value);
                  if (nextVolSuggestion) setNextVolSuggestion("");
                }}
                placeholder="למשל: חלק א׳"
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              />
              {nextVolSuggestion && (
                <button
                  type="button"
                  onClick={() => {
                    setVolume(nextVolSuggestion);
                    setNextVolSuggestion("");
                    setTimeout(() => volumeRef.current?.focus(), 20);
                  }}
                  className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-300/70 text-[11px] font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-100 cursor-pointer"
                >
                  <Sparkles className="w-3 h-3" />
                  הצעה לכרך הבא: {nextVolSuggestion}
                </button>
              )}
            </div>

            <div className="md:col-span-3">
              <AutocompleteInput
                label="קטגוריה"
                field="category"
                value={category}
                onChange={setCategory}
                placeholder="הלכה / ש״ס בבלי..."
              />
            </div>

            <div className="md:col-span-3">
              <AutocompleteInput
                label="הוצאה / מכון"
                field="publisher"
                value={publisher}
                onChange={setPublisher}
                placeholder="מכון ירושלים / פלדהיים..."
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

            <div className="md:col-span-4">
              <label className="block text-xs font-medium mb-1">גודל / פורמט (אופציונלי — למידוף)</label>
              <input
                list="otzar-format-sizes-cat"
                value={formatSize}
                onChange={(e) => setFormatSize(e.target.value)}
                placeholder="רגיל / גדול (פוליו) / כיס"
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
              />
              <datalist id="otzar-format-sizes-cat">
                {FORMAT_SIZE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt} />
                ))}
              </datalist>
            </div>

            <div className="md:col-span-4">
              <label className="block text-xs font-medium mb-1">עובי שדרה במ״מ (אופציונלי)</label>
              <input
                type="number"
                min={1}
                max={300}
                step="0.5"
                value={thicknessMm}
                onChange={(e) => setThicknessMm(e.target.value)}
                placeholder="למשל: 35"
                className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
              />
            </div>

            <div className="md:col-span-4">
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
                שירות פענוח השערים האוטומטי עדיין לא הוגדר (במסך הגדרות ומפה). ניתן עדיין לצלם או להעלות תמונות ולבצע פענוח לאחר ההגדרה.
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

          {/* Scan Mode Switcher & Sticky Set Bar */}
          <div className="rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-1 p-1 rounded-lg bg-[var(--otzar-surface-alt)] border border-[var(--otzar-border-muted)]">
                <button
                  type="button"
                  onClick={() => setScanMode("standard")}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer ${
                    scanMode === "standard"
                      ? "bg-[var(--otzar-accent)] text-white"
                      : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                  }`}
                >
                  <Camera className="w-3.5 h-3.5" />
                  סריקה רגילה / מקבץ רציף
                </button>
                <button
                  type="button"
                  onClick={() => setScanMode("shelf-set")}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer ${
                    scanMode === "shelf-set"
                      ? "bg-[var(--otzar-accent)] text-white"
                      : "text-[var(--otzar-text-muted)] hover:text-[var(--otzar-text)]"
                  }`}
                >
                  <BookCopy className="w-3.5 h-3.5" />
                  צילום סט מהמדף (שער + שדרות)
                </button>
              </div>

              {scanMode === "standard" && (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface)] text-xs font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={stickySetEnabled}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setStickySetEnabled(on);
                        if (on && !stickyBatchId) setStickyBatchId(`batch_${Date.now()}`);
                      }}
                      className="accent-[var(--otzar-accent)]"
                    />
                    <span>קיבוץ צילומים לסט (Sticky Set)</span>
                  </label>
                  {stickySetEnabled && (
                    <button
                      type="button"
                      onClick={() => {
                        setStickyBatchId(`batch_${Date.now()}`);
                        setStickyPresetSetName("");
                      }}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-[var(--otzar-accent)] text-[var(--otzar-accent)] hover:bg-[var(--otzar-surface)] cursor-pointer"
                    >
                      התחל מקבץ סט חדש
                    </button>
                  )}
                </div>
              )}
            </div>

            {scanMode === "standard" && stickySetEnabled && (
              <div className="grid grid-cols-1 md:grid-cols-12 gap-3 pt-2 border-t border-[var(--otzar-border-muted)] items-end">
                <div className="md:col-span-5">
                  <AutocompleteInput
                    label="שם סט מקדים לכל הצילומים במקבץ (אופציונלי)"
                    field="set_name"
                    value={stickyPresetSetName}
                    onChange={setStickyPresetSetName}
                    placeholder="למשל: אגרות משה / שו״ת יביע אומר"
                  />
                </div>
                <div className="md:col-span-7 text-xs text-[var(--otzar-text-muted)] pb-2">
                  מקבץ פעיל: <span className="font-mono font-semibold text-[var(--otzar-accent)]">{stickyBatchId}</span> · כל תמונה שתועלה או תצולם תשויך למקבץ זה ותוכל להחיל את פרטי הסט על כולן בלחיצה אחת במסך האישור.
                </div>
              </div>
            )}
          </div>

          {scanMode === "shelf-set" ? (
            <div className="rounded-xl border border-[var(--otzar-border)] bg-[var(--otzar-bg)] p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-bold text-base flex items-center gap-2">
                    <BookCopy className="w-5 h-5 text-[var(--otzar-accent)]" />
                    מצב סט מהמדף — זיהוי סדרה שלמה מ-2 תמונות (שער + שדרות)
                  </h3>
                  <p className="text-xs text-[var(--otzar-text-muted)] mt-0.5">
                    העלה 1) שער מייצג לפרטי הספר, מחבר והוצאה, ו-2) צילומי שדרות מהמדף לזיהוי כל הכרכים והעותקים במכה אחת.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold">1. תמונת שער מייצגת *</span>
                    <input
                      ref={shelfTitleInputRef}
                      type="file"
                      accept="image/*"
                      onChange={(e) => handlePickShelfTitleFiles(e.target.files)}
                      className="hidden"
                    />
                    <button
                      type="button"
                      disabled={uploadingAi}
                      onClick={() => shelfTitleInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--otzar-accent)] text-white cursor-pointer"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      בחר תמונת שער
                    </button>
                  </div>
                  {shelfTitleImage ? (
                    <div className="relative h-44 rounded-lg border border-[var(--otzar-border-muted)] bg-black/5 overflow-hidden flex items-center justify-center">
                      <img src={shelfTitleImage.dataUrl} alt="שער הסט" className="max-h-full max-w-full object-contain" />
                      <button
                        type="button"
                        onClick={() => setShelfTitleImage(null)}
                        className="absolute top-2 left-2 p-1 rounded-full bg-red-600 text-white cursor-pointer"
                        title="הסר"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="h-44 rounded-lg border-2 border-dashed border-[var(--otzar-border-muted)] flex flex-col items-center justify-center text-xs text-[var(--otzar-text-muted)]">
                      <ImagePlus className="w-7 h-7 mb-1.5 opacity-60" />
                      לחץ על &quot;בחר תמונת שער&quot; (דף השער של כרך אחד מהסט)
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-[var(--otzar-border-muted)] bg-[var(--otzar-surface-alt)] p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold">2. צילומי שדרות הסט על המדף ({shelfSpineImages.length})</span>
                    <input
                      ref={shelfSpineInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(e) => handlePickShelfSpineFiles(e.target.files)}
                      className="hidden"
                    />
                    <button
                      type="button"
                      disabled={uploadingAi}
                      onClick={() => shelfSpineInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[var(--otzar-accent)] text-[var(--otzar-accent)] bg-[var(--otzar-bg)] cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      הוסף צילומי שדרות
                    </button>
                  </div>
                  {shelfSpineImages.length > 0 ? (
                    <div className="grid grid-cols-3 gap-2 max-h-44 overflow-y-auto p-1">
                      {shelfSpineImages.map((sp, idx) => (
                        <div key={idx} className="relative h-24 rounded-lg border border-[var(--otzar-border-muted)] bg-black/5 overflow-hidden">
                          <img src={sp.dataUrl} alt={`שדרות ${idx + 1}`} className="w-full h-full object-cover" />
                          <button
                            type="button"
                            onClick={() => setShelfSpineImages((prev) => prev.filter((_, i) => i !== idx))}
                            className="absolute top-1 left-1 p-0.5 rounded-full bg-red-600 text-white cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="h-44 rounded-lg border-2 border-dashed border-[var(--otzar-border-muted)] flex flex-col items-center justify-center text-xs text-[var(--otzar-text-muted)] text-center px-3">
                      <Layers className="w-7 h-7 mb-1.5 opacity-60" />
                      העלה תמונה אחת או יותר של שדרות הכרכים על המדף כדי שה-AI ימנה את כל הכרכים והעותקים
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-3 pt-2 border-t border-[var(--otzar-border-muted)] items-end text-sm">
                <div className="md:col-span-4">
                  <AutocompleteInput
                    label="שם הסט (אופציונלי)"
                    field="set_name"
                    value={shelfPresetSetName}
                    onChange={setShelfPresetSetName}
                    placeholder="ייקבע אוטומטית מהשער אם ריק"
                  />
                </div>
                <div className="md:col-span-3">
                  <label className="block text-xs font-medium mb-1">ארון יעד</label>
                  <select
                    value={shelfCabId}
                    onChange={(e) => {
                      setShelfCabId(e.target.value);
                      setShelfNum(1);
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
                  <label className="block text-xs font-medium mb-1">מדף</label>
                  <input
                    type="number"
                    min={1}
                    max={cabinets.find((c) => String(c.id) === shelfCabId)?.shelves_count || 20}
                    value={shelfNum}
                    onChange={(e) => setShelfNum(Math.max(1, Number(e.target.value) || 1))}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                  />
                </div>
                <div className="md:col-span-3 flex justify-end">
                  <button
                    type="button"
                    disabled={uploadingAi || !shelfTitleImage}
                    onClick={handleSubmitShelfSet}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    {uploadingAi ? "שולח..." : "שלח סט שלם לפענוח AI"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* Upload Dropzone & Webcam */
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
          )}

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
                {errorCount > 0 && (
                  <button
                    type="button"
                    onClick={async () => {
                      await fetch("/api/ai-queue/retry-errors", { method: "POST" });
                      loadQueue();
                    }}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/30 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    נסה שנית שגיאות ({errorCount})
                  </button>
                )}
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
                    #{q.id} · {q.is_shelf_set ? "[סט מהמדף] " : ""}{q.extracted?.title || q.extracted?.set_name || (q.processing_status === "error" ? "שגיאה" : "ממתין")}
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
                      {activeReviewItem.source_relay_id ? " · נשלח מהנייד" : ""}
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

                  {/* Sticky Set Batch Banner */}
                  {(() => {
                    const batchId = activeReviewItem.set_batch_id;
                    const otherCount = batchId
                      ? queueItems.filter(
                          (q) => q.id !== activeReviewItem.id && q.set_batch_id === batchId && q.approval_status === "pending"
                        ).length
                      : 0;
                    if (!batchId || otherCount === 0) return null;
                    return (
                      <div className="p-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800/60 text-amber-900 dark:text-amber-200 text-xs flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold">
                          זוהו עוד {otherCount} צילומים במקבץ סט זה ({batchId}) — החל עליהם את פרטי הסט (שם סט, מחבר, הוצאה, מיקום)?
                        </span>
                        <button
                          type="button"
                          disabled={applyingBatch}
                          onClick={handleApplyBatchDetails}
                          className="px-3 py-1.5 rounded-lg bg-amber-600 text-white font-bold hover:bg-amber-700 cursor-pointer disabled:opacity-50"
                        >
                          {applyingBatch ? "מחיל..." : "החל על כל המקבץ"}
                        </button>
                      </div>
                    );
                  })()}

                  {/* Authority Suggestion Banner (85-93% similarity) */}
                  {(() => {
                    const suggObj = activeReviewItem.extracted?.authority_suggestion;
                    const suggText = typeof suggObj === "string" ? suggObj : suggObj?.suggestion;
                    const suggConf = typeof suggObj === "object" && suggObj ? suggObj.confidence : null;
                    if (!suggText || suggText === revAuthor.trim()) return null;
                    return (
                      <div className="p-2.5 rounded-lg border border-sky-300 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-800 text-sky-900 dark:text-sky-200 text-xs flex flex-wrap items-center justify-between gap-2">
                        <span>
                          שם מחבר דומה קיים במאגר{suggConf ? ` (${suggConf}%)` : ""}: <strong>{suggText}</strong>
                        </span>
                        <button
                          type="button"
                          onClick={() => setRevAuthor(suggText)}
                          className="px-2.5 py-1 rounded bg-sky-600 text-white font-semibold hover:bg-sky-700 cursor-pointer"
                        >
                          לחץ להחלה
                        </button>
                      </div>
                    );
                  })()}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        {activeReviewItem.is_shelf_set ? "שם הספר הכללי (אופציונלי אם הוזן שם סט)" : "שם הספר *"}
                      </label>
                      <input
                        type="text"
                        required={!activeReviewItem.is_shelf_set}
                        value={revTitle}
                        onChange={(e) => setRevTitle(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] font-semibold"
                      />
                    </div>
                    <div>
                      <AutocompleteInput
                        label="שם הסט / סדרה"
                        field="set_name"
                        value={revSetName}
                        onChange={setRevSetName}
                        placeholder="למשל: משנה ברורה / שו״ת יביע אומר"
                      />
                    </div>
                    <div>
                      {(() => {
                        const uni = activeReviewItem.extracted?.authority_unified;
                        const uniObj = typeof uni === "object" && uni ? uni : null;
                        return (
                          <AutocompleteInput
                            label="מחבר / מפרש"
                            field="author"
                            value={revAuthor}
                            onChange={setRevAuthor}
                            badgeText={uniObj ? `אוחד עם השם הקיים במאגר (${uniObj.matched})` : uni ? "אוחד עם השם הקיים במאגר" : undefined}
                            rawRestorableValue={uniObj?.original}
                            onRestoreRaw={uniObj?.original ? () => setRevAuthor(uniObj.original) : undefined}
                          />
                        );
                      })()}
                    </div>
                    {!activeReviewItem.is_shelf_set && (
                      <div>
                        <label className="block text-xs font-medium mb-1">כרך / חלק</label>
                        <input
                          type="text"
                          value={revVolume}
                          onChange={(e) => setRevVolume(e.target.value)}
                          className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                        />
                      </div>
                    )}
                    <div>
                      <AutocompleteInput
                        label="קטגוריה"
                        field="category"
                        value={revCategory}
                        onChange={setRevCategory}
                      />
                    </div>
                    <div>
                      <AutocompleteInput
                        label="הוצאה לאור"
                        field="publisher"
                        value={revPublisher}
                        onChange={setRevPublisher}
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
                    <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <div>
                        <label className="block text-xs font-medium mb-1">גודל / פורמט</label>
                        <input
                          list="otzar-format-sizes-rev"
                          value={revFormatSize}
                          onChange={(e) => setRevFormatSize(e.target.value)}
                          placeholder="רגיל / גדול / כיס"
                          className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]"
                        />
                        <datalist id="otzar-format-sizes-rev">
                          {FORMAT_SIZE_OPTIONS.map((opt) => (
                            <option key={opt} value={opt} />
                          ))}
                        </datalist>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1">עובי (מ״מ)</label>
                        <input
                          type="number"
                          min={1}
                          max={300}
                          step="0.5"
                          value={revThicknessMm}
                          onChange={(e) => setRevThicknessMm(e.target.value)}
                          placeholder="35"
                          className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1">עמודים</label>
                        <input
                          type="number"
                          min={1}
                          max={10000}
                          value={revPagesCount}
                          onChange={(e) => setRevPagesCount(e.target.value)}
                          placeholder="420"
                          className="w-full px-3 py-2 rounded-lg border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] tabular-nums"
                        />
                      </div>
                    </div>
                    {activeReviewItem.is_shelf_set && (
                      <div className="md:col-span-2 rounded-xl border border-[var(--otzar-border)] bg-[var(--otzar-surface-alt)] p-3 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold flex items-center gap-1.5">
                            <BookCopy className="w-4 h-4 text-[var(--otzar-accent)]" />
                            כרכים ועותקים שזוהו על המדף ({revVolumes.length} שורות)
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const lastVol = revVolumes[revVolumes.length - 1]?.volume || "";
                              const nextVol = suggestNextVolume(lastVol) || `חלק ${revVolumes.length + 1}`;
                              setRevVolumes((prev) => [...prev, { volume: nextVol, copiesCount: 1, notes: "" }]);
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-[var(--otzar-accent)] text-white cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            הוסף כרך
                          </button>
                        </div>
                        <div className="space-y-1.5 max-h-56 overflow-y-auto">
                          {revVolumes.map((row, idx) => (
                            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                              <input
                                type="text"
                                value={row.volume}
                                onChange={(e) =>
                                  setRevVolumes((prev) =>
                                    prev.map((r, i) => (i === idx ? { ...r, volume: e.target.value } : r))
                                  )
                                }
                                placeholder="כרך / חלק"
                                className="col-span-5 px-2.5 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs font-medium"
                              />
                              <input
                                type="number"
                                min={1}
                                max={20}
                                value={row.copiesCount}
                                onChange={(e) =>
                                  setRevVolumes((prev) =>
                                    prev.map((r, i) =>
                                      i === idx ? { ...r, copiesCount: Math.max(1, Number(e.target.value) || 1) } : r
                                    )
                                  )
                                }
                                title="כמות עותקים"
                                className="col-span-2 px-2 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs text-center tabular-nums font-bold"
                              />
                              <input
                                type="text"
                                value={row.notes || ""}
                                onChange={(e) =>
                                  setRevVolumes((prev) =>
                                    prev.map((r, i) => (i === idx ? { ...r, notes: e.target.value } : r))
                                  )
                                }
                                placeholder="הערה (אופציונלי)"
                                className="col-span-4 px-2.5 py-1.5 rounded border border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)] text-xs"
                              />
                              <button
                                type="button"
                                onClick={() => setRevVolumes((prev) => prev.filter((_, i) => i !== idx))}
                                className="col-span-1 p-1.5 text-red-600 hover:bg-red-50 rounded cursor-pointer flex justify-center"
                                title="הסר שורה"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
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
                      disabled={
                        approving ||
                        (activeReviewItem.is_shelf_set
                          ? revVolumes.filter((v) => v.volume.trim()).length === 0
                          : !revTitle.trim())
                      }
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] cursor-pointer disabled:opacity-40"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      {approving
                        ? "מאשר..."
                        : activeReviewItem.is_shelf_set
                        ? `אשר את כל הסט (${revVolumes.reduce((s, v) => s + (v.volume.trim() ? Math.max(1, v.copiesCount || 1) : 0), 0)} עותקים)`
                        : "אשר והוסף לאוצר (Enter)"}
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
