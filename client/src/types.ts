export type ModuleKey = "search" | "circulation" | "catalog" | "labels" | "admin";

export interface MapEntrance {
  wall: "bottom" | "top" | "left" | "right";
  offset: number; // percentage 10..90 along the wall
}

export interface HealthData {
  ok: boolean;
  driver: string;
  dbPath: string;
  counts: {
    books: number;
    cabinets: number;
    borrowers: number;
    activeLoans: number;
    printQueue: number;
    aiQueue: number;
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
  rotation: number;
  books_count?: number;
}

export interface BookRow {
  barcode: string;
  title: string;
  author: string;
  volume: string;
  publisher: string;
  pub_year?: string;
  edition?: string;
  category: string;
  tags: string;
  tagsList: string[];
  cabinet_id: number | null;
  cabinet_code: string | null;
  cabinet_subject: string | null;
  cabinet_shelves_count: number | null;
  shelf_number: number | null;
  notes: string;
  status: "available" | "borrowed" | "reference_only" | "lost";
  label_printed: number;
  created_at: string;
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
}

export interface AiQueueItem {
  id: number;
  has_image: boolean;
  image_count?: number;
  processing_status: "pending" | "processing" | "done" | "error";
  extracted: {
    title?: string;
    author?: string;
    volume?: string;
    publisher?: string;
    pub_year?: string;
    edition?: string;
    category?: string;
    notes?: string;
    tags?: string[];
  } | null;
  error_message: string | null;
  approval_status: "pending" | "approved" | "rejected";
  created_at: string;
}

export const STATUS_LABELS: Record<string, string> = {
  available: "זמין על המדף",
  borrowed: "מושאל",
  reference_only: "לעיון בלבד",
  lost: "אבוד / חסר",
};
