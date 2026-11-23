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
      rotation REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS books (
      barcode TEXT PRIMARY KEY,
      title TEXT NOT NULL,
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
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS borrowers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      shiur_group TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_barcode TEXT NOT NULL REFERENCES books(barcode) ON DELETE CASCADE,
      borrower_id INTEGER NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
      loan_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      return_date TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_catalog_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_path TEXT NOT NULL,
      extra_images_json TEXT NOT NULL DEFAULT '[]',
      processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'done', 'error')),
      extracted_json TEXT,
      error_message TEXT,
      approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_books_status ON books(status);
    CREATE INDEX IF NOT EXISTS idx_books_cabinet ON books(cabinet_id);
    CREATE INDEX IF NOT EXISTS idx_books_norm ON books(normalized_search);
    CREATE INDEX IF NOT EXISTS idx_loans_barcode ON loans(book_barcode);
    CREATE INDEX IF NOT EXISTS idx_loans_open ON loans(return_date);
  `);

  const existingBookCols = db.all<{ name: string }>("PRAGMA table_info(books)").map((c) => c.name);
  if (!existingBookCols.includes("pub_year")) {
    db.exec("ALTER TABLE books ADD COLUMN pub_year TEXT NOT NULL DEFAULT ''");
  }
  if (!existingBookCols.includes("edition")) {
    db.exec("ALTER TABLE books ADD COLUMN edition TEXT NOT NULL DEFAULT ''");
  }

  const existingQueueCols = db.all<{ name: string }>("PRAGMA table_info(ai_catalog_queue)").map((c) => c.name);
  if (!existingQueueCols.includes("extra_images_json")) {
    db.exec("ALTER TABLE ai_catalog_queue ADD COLUMN extra_images_json TEXT NOT NULL DEFAULT '[]'");
  }

  const defaultSettings: Record<string, string> = {
    library_name: "אוצר הספרים - ישיבת אור התורה",
    admin_pin: "1234",
    default_loan_days: "14",
    next_barcode: "100007",
    barcode_prefix: "",
    ai_api_key: "",
    ai_model: "gemini-4-hydrogen",
    embedding_model: "gemini-embedding-001",
    ai_delay_ms: "4200",
    theme_preset: "otzar-orange",
    theme_mode: "light",
    map_entrance: JSON.stringify({ wall: "bottom", offset: 50 }),
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

  const existingCabinets = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM cabinets");
  if ((existingCabinets?.c ?? 0) === 0) {
    db.transaction(() => {
      const now = new Date().toISOString();
      const cab1 = db.run(
        "INSERT INTO cabinets (code, main_subject, shelves_count, x, y, width, height, rotation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        "א-1", "ש״ס תלמוד בבלי ומפרשים", 6, 40, 40, 180, 60, 0
      ).lastInsertRowid;
      const cab2 = db.run(
        "INSERT INTO cabinets (code, main_subject, shelves_count, x, y, width, height, rotation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        "ב-1", "הלכה, טור, שו״ע ופוסקים", 6, 250, 40, 180, 60, 0
      ).lastInsertRowid;
      const cab3 = db.run(
        "INSERT INTO cabinets (code, main_subject, shelves_count, x, y, width, height, rotation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        "ג-1", "תנ״ך ומפרשים", 5, 40, 160, 180, 60, 0
      ).lastInsertRowid;
      const cab4 = db.run(
        "INSERT INTO cabinets (code, main_subject, shelves_count, x, y, width, height, rotation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        "ד-1", "מחשבה, חסידות ומוסר", 5, 250, 160, 180, 60, 0
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
          `INSERT INTO books (barcode, title, author, volume, publisher, category, tags, normalized_search, cabinet_id, shelf_number, notes, status, label_printed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          b.barcode, b.title, b.author, b.volume, b.publisher, b.category, JSON.stringify(b.tags), norm, b.cabinet_id, b.shelf_number, b.notes, b.status, b.label_printed, now
        );
      }

      db.run("INSERT INTO borrowers (full_name, shiur_group, phone, notes, created_at) VALUES (?, ?, ?, ?, ?)", "דוד כהן", "שיעור ב׳", "050-1234567", "", now);
      db.run("INSERT INTO borrowers (full_name, shiur_group, phone, notes, created_at) VALUES (?, ?, ?, ?, ?)", "יהודה לוי", "שיעור ג׳", "052-7654321", "", now);
      db.run("INSERT INTO borrowers (full_name, shiur_group, phone, notes, created_at) VALUES (?, ?, ?, ?, ?)", "הרב אברהם גולדברג", "כולל אברכים", "054-9876543", "", now);
    });
  }
}
