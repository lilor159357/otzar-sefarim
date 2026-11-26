import crypto from "crypto";
import type { DbClient } from "./adapter.ts";

export function normalizeHebrewText(input: string): string {
  return (input || "")
    .replace(/[\u0591-\u05C7]/g, "") // Remove Hebrew niqqud & cantillation
    .replace(/["\u05F4\u201C\u201D'\u05F3\u2018\u2019\-\u05BE\u2013\u2014]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function buildNormalizedBookSearch(parts: Array<string | undefined | null>): string {
  return normalizeHebrewText(parts.filter(Boolean).join(" "));
}

export const DEMO_SEED_TIMESTAMP = "2025-01-01T00:00:00.000Z";
export const DEMO_CABINET_CODES = ["א-1", "ב-1", "ג-1", "ד-1"] as const;
export const DEMO_BOOK_BARCODES = ["100001", "100002", "100003", "100004", "100005", "100006"] as const;
export const DEMO_BOOK_TITLES = [
  "תלמוד בבלי - מסכת ברכות",
  "משנה ברורה - חלק א׳ (הלכות הנהגת הבוקר וציצית)",
  "משנה תורה לרמב״ם - ספר המדע ואהבה",
  "שולחן ערוך - יורה דעה עם נושאי כלים",
  "מקראות גדולות - בראשית",
  "מסילת ישרים",
] as const;
export const DEMO_BORROWER_NAMES = ["דוד כהן", "יהודה לוי", "הרב אברהם גולדברג"] as const;

export function newSyncId(): string {
  return crypto.randomUUID();
}

export function enqueueSyncOutbox(
  db: DbClient,
  entityType: "book" | "cabinet" | "borrower" | "loan",
  syncId: string,
  operation: "upsert" | "delete",
  payload: Record<string, unknown> = {}
): void {
  if (!syncId) return;
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO sync_outbox (entity_type, sync_id, operation, payload_json, created_at, synced_at) VALUES (?, ?, ?, ?, ?, NULL)",
    entityType,
    syncId,
    operation,
    JSON.stringify(payload),
    now
  );
}

function ensureColumn(db: DbClient, table: string, col: string, ddl: string): void {
  const cols = db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
}

function backfillSyncColumns(db: DbClient, table: string, pkCol: string, timeFallbackCol?: string): void {
  const now = new Date().toISOString();
  const missingSync = db.all<Record<string, unknown>>(
    `SELECT ${pkCol} AS pkVal FROM ${table} WHERE sync_id IS NULL OR sync_id = ''`
  );
  for (const row of missingSync) {
    db.run(`UPDATE ${table} SET sync_id = ? WHERE ${pkCol} = ?`, newSyncId(), row.pkVal as any);
  }
  if (timeFallbackCol) {
    db.run(
      `UPDATE ${table} SET updated_at = COALESCE(NULLIF(${timeFallbackCol}, ''), ?) WHERE updated_at IS NULL OR updated_at = ''`,
      now
    );
  } else {
    db.run(`UPDATE ${table} SET updated_at = ? WHERE updated_at IS NULL OR updated_at = ''`, now);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_sync_id ON ${table}(sync_id)`);
}

export function initSchemaAndSeed(db: DbClient): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cabinets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      main_subject TEXT NOT NULL DEFAULT '',
      shelves_count INTEGER NOT NULL DEFAULT 5,
      x REAL NOT NULL DEFAULT 40,
      y REAL NOT NULL DEFAULT 40,
      width REAL NOT NULL DEFAULT 150,
      height REAL NOT NULL DEFAULT 64,
      width_cm REAL,
      depth_cm REAL,
      rotation REAL NOT NULL DEFAULT 0,
      sync_id TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS books (
      barcode TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      set_name TEXT NOT NULL DEFAULT '',
      sub_series TEXT NOT NULL DEFAULT '',
      set_global_number INTEGER,
      coverage_range TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      volume TEXT NOT NULL DEFAULT '',
      publisher TEXT NOT NULL DEFAULT '',
      pub_year TEXT NOT NULL DEFAULT '',
      edition TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      normalized_search TEXT NOT NULL DEFAULT '',
      embedding BLOB,
      cabinet_id INTEGER REFERENCES cabinets(id) ON DELETE SET NULL,
      shelf_number INTEGER,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'borrowed', 'reference_only', 'lost')),
      label_printed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      format_size TEXT NOT NULL DEFAULT '',
      thickness_mm REAL,
      pages_count INTEGER,
      barcode_status TEXT NOT NULL DEFAULT 'assigned',
      sync_id TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS borrowers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      shiur_group TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      sync_id TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_barcode TEXT NOT NULL REFERENCES books(barcode) ON DELETE CASCADE,
      borrower_id INTEGER NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
      loan_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      return_date TEXT,
      sync_id TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_catalog_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_path TEXT NOT NULL,
      extra_images_json TEXT NOT NULL DEFAULT '[]',
      default_cabinet_id INTEGER,
      default_shelf_number INTEGER,
      source_relay_id TEXT,
      processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'done', 'error')),
      processing_started_at TEXT,
      extracted_json TEXT,
      error_message TEXT,
      approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
      deleted_at TEXT,
      recycle_expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS book_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_barcode TEXT NOT NULL REFERENCES books(barcode) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
      source_type TEXT NOT NULL DEFAULT 'ai_queue',
      queue_id INTEGER,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      sync_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      synced_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_books_status ON books(status);
    CREATE INDEX IF NOT EXISTS idx_books_cabinet ON books(cabinet_id);
    CREATE INDEX IF NOT EXISTS idx_books_norm ON books(normalized_search);
    CREATE INDEX IF NOT EXISTS idx_loans_open ON loans(book_barcode, return_date);
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox(synced_at, id);
    CREATE INDEX IF NOT EXISTS idx_book_images_barcode ON book_images(book_barcode);
    CREATE INDEX IF NOT EXISTS idx_book_images_expires ON book_images(expires_at);
  `);

  // Safe idempotent migrations for existing databases
  ensureColumn(db, "books", "set_name", "TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE INDEX IF NOT EXISTS idx_books_set_name ON books(set_name)");
  ensureColumn(db, "books", "sub_series", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "books", "set_global_number", "INTEGER");
  ensureColumn(db, "books", "coverage_range", "TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE INDEX IF NOT EXISTS idx_books_sub_series ON books(sub_series)");
  ensureColumn(db, "books", "pub_year", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "books", "edition", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "books", "format_size", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "books", "thickness_mm", "REAL");
  ensureColumn(db, "books", "pages_count", "INTEGER");
  ensureColumn(db, "books", "barcode_status", "TEXT NOT NULL DEFAULT 'assigned'");
  ensureColumn(db, "books", "sync_id", "TEXT");
  ensureColumn(db, "books", "updated_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "books", "deleted_at", "TEXT");

  ensureColumn(db, "cabinets", "width_cm", "REAL");
  ensureColumn(db, "cabinets", "depth_cm", "REAL");
  ensureColumn(db, "cabinets", "sync_id", "TEXT");
  ensureColumn(db, "cabinets", "updated_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "cabinets", "deleted_at", "TEXT");

  ensureColumn(db, "borrowers", "sync_id", "TEXT");
  ensureColumn(db, "borrowers", "updated_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "borrowers", "deleted_at", "TEXT");

  ensureColumn(db, "loans", "sync_id", "TEXT");
  ensureColumn(db, "loans", "updated_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "loans", "deleted_at", "TEXT");

  ensureColumn(db, "ai_catalog_queue", "extra_images_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "ai_catalog_queue", "default_cabinet_id", "INTEGER");
  ensureColumn(db, "ai_catalog_queue", "default_shelf_number", "INTEGER");
  ensureColumn(db, "ai_catalog_queue", "source_relay_id", "TEXT");
  ensureColumn(db, "ai_catalog_queue", "set_batch_id", "TEXT");
  ensureColumn(db, "ai_catalog_queue", "is_shelf_set", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "ai_catalog_queue", "spine_extracted_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "ai_catalog_queue", "processing_started_at", "TEXT");
  ensureColumn(db, "ai_catalog_queue", "deleted_at", "TEXT");
  ensureColumn(db, "ai_catalog_queue", "recycle_expires_at", "TEXT");
  ensureColumn(db, "ai_catalog_queue", "source_book_barcode", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ai_queue_set_batch ON ai_catalog_queue(set_batch_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_queue_relay_id ON ai_catalog_queue(source_relay_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ai_queue_deleted ON ai_catalog_queue(deleted_at)");

  backfillSyncColumns(db, "cabinets", "id");
  backfillSyncColumns(db, "books", "barcode", "created_at");
  backfillSyncColumns(db, "borrowers", "id", "created_at");
  backfillSyncColumns(db, "loans", "id", "loan_date");

  const defaultSettings: Record<string, string> = {
    library_name: "אוצר הספרים - ישיבת אור התורה",
    admin_pin: "1234",
    default_loan_days: "14",
    next_barcode: "100007",
    barcode_prefix: "",
    ai_api_key: "",
    ai_keys_pool: "[]",
    ai_cover_model: "gemini-3.5-flash-lite",
    ai_model: "gemini-3.8-flash",
    ai_fallback_model: "gemini-4-hydrogen",
    ai_auto_fallback: "true",
    ai_internet_enrichment: "true",
    ai_request_timeout_sec: "60",
    ai_key_cooldown_sec: "45",
    embedding_model: "gemini-embedding-001",
    ai_delay_ms: "4200",
    firebase_enabled: "0",
    firebase_sync_embeddings: "1",
    firebase_config: "{}",
    firebase_email: "",
    firebase_password: "",
    theme_preset: "otzar-orange",
    theme_mode: "light",
    map_entrance: JSON.stringify({ wall: "bottom", offset: 50 }),
    room_dimensions: JSON.stringify({ width_m: 8, length_m: 6, wall_note: "" }),
    volume_notation_rules: JSON.stringify([]),
    ignored_missing_volumes: JSON.stringify([]),
    label_config: JSON.stringify({
      showLibraryName: false,
      showBookTitle: true,
      showLocation: true,
    }),
    a4_template: JSON.stringify({
      rows: 8,
      cols: 3,
      marginTopMm: 12,
      marginRightMm: 8,
      marginBottomMm: 12,
      marginLeftMm: 8,
      gapXMm: 4,
      gapYMm: 2,
    }),
  };

  for (const [k, v] of Object.entries(defaultSettings)) {
    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", k, v);
  }

  // Migrate deprecated gemini-3.5-flash model setting to active models
  try {
    const curAiModel = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'ai_model'")?.value?.trim();
    if (curAiModel === "gemini-3.5-flash") {
      db.run("UPDATE settings SET value = 'gemini-3.8-flash' WHERE key = 'ai_model'");
    }
    const curCoverModel = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'ai_cover_model'")?.value?.trim();
    if (curCoverModel === "gemini-3.5-flash") {
      db.run("UPDATE settings SET value = 'gemini-3.5-flash-lite' WHERE key = 'ai_cover_model'");
    }
    const curFallbackModel = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'ai_fallback_model'")?.value?.trim();
    if (curFallbackModel === "gemini-3.5-flash") {
      db.run("UPDATE settings SET value = 'gemini-4-hydrogen' WHERE key = 'ai_fallback_model'");
    }
  } catch {}

  // Migrate legacy single ai_api_key into ai_keys_pool if pool is empty
  const legacyKey = (db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'ai_api_key'")?.value || "").trim();
  const poolRaw = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'ai_keys_pool'")?.value || "[]";
  try {
    const parsedPool = JSON.parse(poolRaw);
    if (legacyKey && Array.isArray(parsedPool) && parsedPool.length === 0) {
      const migrated = [{ id: newSyncId(), label: "מפתח 1", apiKey: legacyKey, enabled: true }];
      db.run("UPDATE settings SET value = ? WHERE key = 'ai_keys_pool'", JSON.stringify(migrated));
    }
  } catch {}

  const existingCabinets = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM cabinets");
  if ((existingCabinets?.c ?? 0) === 0) {
    db.transaction(() => {
      const now = DEMO_SEED_TIMESTAMP;
      const cab1 = db.run(
        "INSERT INTO cabinets (code, main_subject, shelves_count, x, y, width, height, rotation, sync_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "א-1", "ש״ס תלמוד בבלי ומפרשים", 6, 40, 40, 180, 60, 0, "demo-cabinet-1", now
      ).lastInsertRowid;
      const cab2 = db.run(
        "INSERT INTO cabinets (code, main_subject, shelves_count, x, y, width, height, rotation, sync_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "ב-1", "הלכה, טור, שו״ע ופוסקים", 6, 250, 40, 180, 60, 0, "demo-cabinet-2", now
      ).lastInsertRowid;
      const cab3 = db.run(
        "INSERT INTO cabinets (code, main_subject, shelves_count, x, y, width, height, rotation, sync_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "ג-1", "תנ״ך ומפרשים", 5, 40, 160, 180, 60, 0, "demo-cabinet-3", now
      ).lastInsertRowid;
      const cab4 = db.run(
        "INSERT INTO cabinets (code, main_subject, shelves_count, x, y, width, height, rotation, sync_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "ד-1", "מחשבה, חסידות ומוסר", 5, 250, 160, 180, 60, 0, "demo-cabinet-4", now
      ).lastInsertRowid;

      const sampleBooks = [
        {
          barcode: "100001",
          title: "תלמוד בבלי - מסכת ברכות",
          author: "חז״ל / רש״י ותוספות",
          volume: "כרך א׳",
          publisher: "עוז והדר",
          category: "ש״ס בבלי",
          tags: ["שס", "גמרא", "ברכות", "תלמוד בבלי", "רשי", "תוספות"],
          cabinet_id: cab1,
          shelf_number: 2,
          notes: "מהדורה מנוקדת ומבוארת",
          status: "available",
          label_printed: 1,
        },
        {
          barcode: "100002",
          title: "משנה ברורה - חלק א׳ (הלכות הנהגת הבוקר וציצית)",
          author: "הרב ישראל מאיר הכהן מראדין (החפץ חיים)",
          volume: "חלק א׳",
          publisher: "מכון משנת ראשונים",
          category: "הלכה",
          tags: ["משנב", "משנה ברורה", "שולחן ערוך", "אורח חיים", "הלכה", "חפץ חיים"],
          cabinet_id: cab2,
          shelf_number: 1,
          notes: "עם ביאור הלכה ושער הציון",
          status: "available",
          label_printed: 1,
        },
        {
          barcode: "100003",
          title: "משנה תורה לרמב״ם - ספר המדע ואהבה",
          author: "רבי משה בן מימון (הרמב״ם)",
          volume: "כרך א׳",
          publisher: "רמב״ם פרנקל",
          category: "רמב״ם",
          tags: ["רמבם", "היד החזקה", "משנה תורה", "ספר המדע", "הלכה"],
          cabinet_id: cab2,
          shelf_number: 3,
          notes: "מהדורת שבתי פרנקל",
          status: "reference_only",
          label_printed: 1,
        },
        {
          barcode: "100004",
          title: "שולחן ערוך - יורה דעה עם נושאי כלים",
          author: "רבי יוסף קארו / הרמ״א",
          volume: "חלק א׳ (סימנים א-קכ)",
          publisher: "מכון ירושלים",
          category: "הלכה",
          tags: ["שוע", "שולחן ערוך", "יורה דעה", "שך", "טז", "בית יוסף"],
          cabinet_id: cab2,
          shelf_number: 4,
          notes: "ט״ז, ש״ך, פרי מגדים",
          status: "available",
          label_printed: 0,
        },
        {
          barcode: "100005",
          title: "מקראות גדולות - בראשית",
          author: "רש״י, רמב״ן, אבן עזרא, אור החיים",
          volume: "בראשית",
          publisher: "המאור",
          category: "תנ״ך",
          tags: ["תורה", "חומש", "בראשית", "רשי", "רמבן", "מפרשים"],
          cabinet_id: cab3,
          shelf_number: 2,
          notes: "",
          status: "available",
          label_printed: 0,
        },
        {
          barcode: "100006",
          title: "מסילת ישרים",
          author: "רבי משה חיים לוצאטו (הרמח״ל)",
          volume: "מהדורה מורחבת",
          publisher: "פלדהיים",
          category: "מוסר ומחשבה",
          tags: ["מוסר", "רמחל", "מסילת ישרים", "יראת שמים", "מחשבה"],
          cabinet_id: cab4,
          shelf_number: 1,
          notes: "",
          status: "available",
          label_printed: 1,
        },
      ];
      for (const b of sampleBooks) {
        const norm = buildNormalizedBookSearch([b.barcode, b.title, b.author, b.volume, b.publisher, b.category, b.tags.join(" "), b.notes]);
        db.run(
          `INSERT INTO books (barcode, title, author, volume, publisher, category, tags, normalized_search, cabinet_id, shelf_number, notes, status, label_printed, created_at, barcode_status, sync_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?)`,
          b.barcode, b.title, b.author, b.volume, b.publisher, b.category, JSON.stringify(b.tags), norm, b.cabinet_id, b.shelf_number, b.notes, b.status, b.label_printed, now, `demo-book-${b.barcode}`, now
        );
      }

      db.run("INSERT INTO borrowers (full_name, shiur_group, phone, notes, created_at, sync_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "דוד כהן", "שיעור ב׳", "050-1234567", "", now, "demo-borrower-1", now);
      db.run("INSERT INTO borrowers (full_name, shiur_group, phone, notes, created_at, sync_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "יהודה לוי", "שיעור ג׳", "052-7654321", "", now, "demo-borrower-2", now);
      db.run("INSERT INTO borrowers (full_name, shiur_group, phone, notes, created_at, sync_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "הרב אברהם גולדברג", "כולל אברכים", "054-9876543", "", now, "demo-borrower-3", now);
    });
  }
}