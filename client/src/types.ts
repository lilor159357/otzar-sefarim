export type ModuleKey = "search" | "circulation" | "catalog" | "labels" | "admin";

export interface MapEntrance {
  wall: "bottom" | "top" | "left" | "right";
  offset: number; // percentage 10..90 along the wall
}

export interface RoomDimensions {
  width_m: number;
  length_m: number;
  wall_note?: string;
}

export interface VolumeNotationRule {
  symbol: string;
  rank: number;
  label?: string;
}

export interface HealthData {
  ok: boolean;
  driver: string;
  dbPath: string;
  dataDir?: string;
  isElectron?: boolean;
  appVersion?: string;
  migratedFrom?: string | null;
  certSummary?: {
    loadedCount: number;
    mode: string;
  } | null;
  counts: {
    books: number;
    cabinets: number;
    borrowers: number;
    activeLoans: number;
    printQueue: number;
    aiQueue: number;
    recycleBin?: number;
  };
}

export interface CabinetRow {
  id: number;
  code: string;
  main_subject: string;
  shelves_count: number;
  x: number;
  y: number;
  width: number;
  height: number;
  width_cm?: number | null;
  depth_cm?: number | null;
  rotation: number;
  books_count?: number;
  sync_id?: string;
  updated_at?: string;
}

export interface BookRow {
  barcode: string;
  title: string;
  author: string;
  volume: string;

  set_name?: string;
  sub_series?: string;
  set_global_number?: number | null;
  coverage_range?: string;
  publisher: string;
  pub_year?: string;
  edition?: string;
  category: string;
  tags: string;
  tagsList: string[];
  format_size?: string;
  thickness_mm?: number | null;
  pages_count?: number | null;
  barcode_status?: "assigned" | "pending_barcode";
  cabinet_id: number | null;
  cabinet_code: string | null;
  cabinet_subject: string | null;
  cabinet_shelves_count: number | null;
  shelf_number: number | null;
  notes: string;
  status: "available" | "borrowed" | "reference_only" | "lost";
  label_printed: number;
  created_at: string;
  sync_id?: string;
  updated_at?: string;
  matchHint?: string;
}

export interface BorrowerRow {
  id: number;
  full_name: string;
  shiur_group: string;
  phone: string;
  notes: string;
  created_at: string;
  active_loans_count?: number;
  overdue_loans_count?: number;
  sync_id?: string;
  updated_at?: string;
}

export interface MissingVolumeSlotDto {
  key: string;
  setName: string;
  subSeries: string;
  slotType: "volume" | "global";
  kind?: "missing" | "anomaly";
  index: number;
  gapSize?: number;
  suggestedVolume: string;
  suggestedGlobalNumber: number | null;
  sourceBookBarcode?: string;
  sourceBookTitle?: string;
  anomalyMessage?: string;
  ignored: boolean;
}

export interface LoanRow {
  id: number;
  book_barcode: string;
  borrower_id: number;
  loan_date: string;
  due_date: string;
  return_date: string | null;
  book_title: string;
  book_author: string;
  book_volume: string;
  cabinet_code: string | null;
  shelf_number: number | null;
  borrower_name: string;
  borrower_shiur: string;
  borrower_phone: string;
  is_overdue: boolean;
  days_overdue: number;
  sync_id?: string;
  updated_at?: string;
}

export interface AiQueueItem {
  id: number;
  has_image: boolean;
  image_count?: number;
  default_cabinet_id?: number | null;
  default_shelf_number?: number | null;
  source_relay_id?: string | null;
  source_book_barcode?: string | null;

  set_batch_id?: string | null;

  is_shelf_set?: boolean;

  spine_extracted?: Array<{
    volume: string;
    sub_series?: string;
    set_global_number?: number | null;
    coverage_range?: string;
    copiesCount: number;
    notes?: string;
  }> | null;
  processing_status: "pending" | "processing" | "done" | "error";
  processing_started_at?: string | null;
  extracted: {
    title?: string;
    author?: string;
    volume?: string;
    sub_series?: string;
    set_global_number?: number | null;
    coverage_range?: string;
    publisher?: string;
    pub_year?: string;
    edition?: string;
    category?: string;
    notes?: string;
    tags?: string[];
    set_name?: string;
    canonical_author?: string;
    authority_suggestion?: { field: string; suggestion: string; confidence: number } | string;
    authority_unified?: { field: string; original: string; matched: string } | boolean;
    volumes?: Array<{
      volume: string;
      sub_series?: string;
      set_global_number?: number | null;
      coverage_range?: string;
      copiesCount: number;
      notes?: string;
    }>;
  } | null;
  error_message: string | null;
  approval_status: "pending" | "approved" | "rejected";
  deleted_at?: string | null;
  recycle_expires_at?: string | null;
  created_at: string;
}

export interface BookImageMeta {
  id: number;
  book_barcode: string;
  mime_type: string;
  source_type: string;
  queue_id?: number | null;
  created_at: string;
  expires_at: string;
  days_remaining: number;
}

export interface RecycleBinBookItem {
  barcode: string;
  title: string;
  author: string;
  volume: string;
  set_name?: string;
  sub_series?: string;
  set_global_number?: number | null;
  coverage_range?: string;
  publisher?: string;
  pub_year?: string;
  edition?: string;
  category?: string;
  tags?: string[];
  cabinet_id?: number | null;
  cabinet_code?: string | null;
  shelf_number?: number | null;
  notes?: string;
  deleted_at: string;
  days_remaining: number;
  images_count: number;
}

export interface RecycleBinAiItem {
  id: number;
  has_image: boolean;
  image_count: number;
  is_shelf_set?: boolean;
  processing_status: string;
  extracted: AiQueueItem["extracted"];
  deleted_at: string;
  recycle_expires_at: string;
  days_remaining: number;
  created_at: string;
}

export interface RecycleBinData {
  books: RecycleBinBookItem[];
  aiItems: RecycleBinAiItem[];
  retentionDays: number;
}

export interface AiPoolKeyStatus {
  id: string;
  label: string;
  maskedKey: string;
  enabled: boolean;
  status: "ready" | "cooldown" | "invalid" | "disabled";
  cooldownRemainingSec: number;
  callsLast60s: number;
  activeInFlight: number;
  totalRequests: number;
  lastUsedAt: string | null;
  lastError: string | null;
}

export interface ShelvingShelfReport {
  shelfNumber: number;
  booksCount: number;
  totalThicknessMm: number;
  totalThicknessCm: number;
  estimatedCapacityCm?: number | null;
  fillPercent?: number | null;
  isOverloaded?: boolean;
  avgThicknessMm: number | null;
  knownThicknessCount: number;
  missingThicknessCount: number;
  formatCounts: Record<string, number>;
}

export interface ShelvingCabinetReport {
  id: number;
  code: string;
  main_subject: string;
  shelves_count: number;
  width_cm?: number | null;
  depth_cm?: number | null;
  footprintSqm?: number | null;
  booksCount: number;
  totalThicknessMm: number;
  totalThicknessCm: number;
  avgThicknessMm: number | null;
  knownThicknessCount: number;
  missingThicknessCount: number;
  formatCounts: Record<string, number>;
  shelves: ShelvingShelfReport[];
}

export interface ShelvingReport {
  room?: {
    width_m: number;
    length_m: number;
    areaSqm: number;
    cabinetsFootprintSqm: number;
    cabinetsKnownCount: number;
    aisleFreeSqm: number;
    aisleFreePercent: number;
  };
  totals: {
    totalBooks: number;
    assignedBooks: number;
    unassignedBooks: number;
    totalThicknessMm: number;
    totalThicknessCm: number;
    avgThicknessMm: number | null;
    knownThicknessCount: number;
    missingThicknessCount: number;
    formatBreakdown: Record<string, number>;
  };
  unassigned: {
    booksCount: number;
    totalThicknessCm: number;
    missingThicknessCount: number;
  };
  cabinets: ShelvingCabinetReport[];
}

export interface SmartShelfMove {
  id: string;
  title: string;
  description: string;
  reason: string;
  severity: "info" | "warning" | "high";
  source: "deterministic" | "ai";
  fromCabinetId?: number;
  fromCabinetCode?: string;
  fromShelf?: number;
  toCabinetId?: number;
  toCabinetCode?: string;
  toShelf?: number;
  barcodes?: string[];
  setName?: string;
}

export interface SmartShelfPlan {
  moves: SmartShelfMove[];
  summary: string;
  usedAi: boolean;
  aiError?: string | null;
}

export const FORMAT_SIZE_OPTIONS = ["רגיל", "גדול (פוליו)", "בינוני", "קטן (כיס)"] as const;

export interface FirebaseSyncStatus {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  syncing: boolean;
  offline: boolean;
  projectId: string | null;
  email: string | null;
  uid: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingOutboxCount: number;
  pendingRelayLocalCount: number;
  pendingBarcodeBooksCount: number;
  syncEmbeddings: boolean;
  initialSeedDone: boolean;
  deviceId: string;
  demoStatus?: {
    demoBooksCount: number;
    duplicateDemoCount: number;
    isPureDemo: boolean;
  };
  config?: {
    apiKey: string;
    authDomain?: string;
    projectId: string;
    storageBucket?: string;
    messagingSenderId?: string;
    appId: string;
  } | null;
  hasPassword?: boolean;
  spark: {
    date: string;
    reads: number;
    writes: number;
    deletes: number;
    relayProcessed: number;
    limits: {
      reads: number;
      writes: number;
      deletes: number;
    };
  };
}

export const STATUS_LABELS: Record<string, string> = {
  available: "זמין על המדף",
  borrowed: "מושאל",
  reference_only: "לעיון בלבד",
  lost: "אבוד / חסר",
};
