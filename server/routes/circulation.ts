import type { Express } from "express";
import * as XLSX from "xlsx";
import type { DbClient } from "../db/adapter.ts";
import { requireAdmin } from "../auth/adminAuth.ts";
import { enqueueSyncOutbox, newSyncId } from "../db/schema.ts";

function normalizeHeader(h: string): string {
  return String(h || "")
    .replace(/[\uFEFF"'`]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeText(s: string): string {
  return String(s || "")
    .replace(/[\u0591-\u05C7"'׳״-]/g, "")
    .trim()
    .toLowerCase();
}

function decodeCsvText(buf: Buffer): string {
  let text = buf.toString("utf8");
  if (text.includes("\uFFFD")) {
    try {
      text = new TextDecoder("windows-1255").decode(buf);
    } catch {
      // keep utf8 fallback
    }
  }
  return text.replace(/^\uFEFF/, "");
}

function extractBorrowerFields(rawRow: Record<string, unknown>) {
  const entries = Object.entries(rawRow);
  const map = new Map<string, string>();
  for (const [k, v] of entries) {
    map.set(normalizeHeader(k), String(v ?? "").trim());
  }

  const pick = (candidates: string[]): string => {
    for (const c of candidates) {
      const val = map.get(c);
      if (val !== undefined && val !== "") return val;
    }
    return "";
  };

  let fullName = pick([
    "שם מלא",
    "שם השואל",
    "שם התלמיד",
    "שם",
    "תלמיד",
    "שואל",
    "full_name",
    "fullname",
    "name",
    "borrower",
  ]);

  if (!fullName) {
    const first = pick(["שם פרטי", "פרטי", "first_name", "firstname"]);
    const last = pick(["שם משפחה", "משפחה", "last_name", "lastname"]);
    if (first || last) {
      fullName = [first, last].filter(Boolean).join(" ").trim();
    }
  }

  if (!fullName && entries.length > 0) {
    const firstNonEmpty = entries.find(([, v]) => String(v ?? "").trim().length > 0);
    if (firstNonEmpty && entries[0][0].startsWith("__EMPTY")) {
      fullName = String(firstNonEmpty[1]).trim();
    }
  }

  const shiurGroup = pick([
    "שיעור/קבוצה",
    "שיעור / קבוצה",
    "שיעור",
    "קבוצה",
    "כיתה",
    "ועד",
    "מסגרת",
    "shiur_group",
    "shiur",
    "group",
    "class",
  ]);

  const phone = pick([
    "טלפון",
    "נייד",
    "פלאפון",
    "טל׳",
    "מספר טלפון",
    "phone",
    "mobile",
    "tel",
  ]);

  const notes = pick(["הערות", "הערה", "פרטים", "notes", "note"]);

  return {
    full_name: fullName.trim(),
    shiur_group: shiurGroup.trim(),
    phone: phone.trim(),
    notes: notes.trim(),
  };
}

export function registerCirculationRoutes(app: Express, db: DbClient) {
  // List borrowers with active/overdue loan counters
  app.get("/api/borrowers", (req, res) => {
    const q = typeof req.query.q === "string" ? normalizeText(req.query.q) : "";
    const nowIso = new Date().toISOString();
    let rows = db.all<Record<string, unknown>>(
      `SELECT b.*,
        (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = b.id AND l.return_date IS NULL AND l.deleted_at IS NULL) AS active_loans_count,
        (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = b.id AND l.return_date IS NULL AND l.deleted_at IS NULL AND l.due_date < ?) AS overdue_loans_count
       FROM borrowers b
       WHERE b.deleted_at IS NULL
       ORDER BY b.full_name ASC`,
      nowIso
    );
    if (q) {
      rows = rows.filter((r) => {
        const hay = normalizeText(`${r.full_name} ${r.shiur_group} ${r.phone} ${r.notes}`);
        return hay.includes(q);
      });
    }
    res.json(rows);
  });

  app.post("/api/borrowers", requireAdmin, (req, res) => {
    const { full_name, shiur_group = "", phone = "", notes = "" } = req.body || {};
    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ error: "יש להזין שם מלא לשואל" });
    }
    const now = new Date().toISOString();
    const syncId = newSyncId();
    const info = db.run(
      "INSERT INTO borrowers (full_name, shiur_group, phone, notes, created_at, sync_id, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      String(full_name).trim(),
      String(shiur_group).trim(),
      String(phone).trim(),
      String(notes).trim(),
      now,
      syncId,
      now
    );
    const created = db.get<Record<string, unknown>>(
      "SELECT *, 0 AS active_loans_count, 0 AS overdue_loans_count FROM borrowers WHERE id = ?",
      info.lastInsertRowid
    );
    enqueueSyncOutbox(db, "borrower", syncId, "upsert", created || { sync_id: syncId, full_name: String(full_name).trim(), updated_at: now });
    res.status(201).json(created);
  });

  app.put("/api/borrowers/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const existing = db.get<Record<string, unknown>>("SELECT * FROM borrowers WHERE id = ? AND deleted_at IS NULL", id);
    if (!existing) return res.status(404).json({ error: "השואל לא נמצא" });
    const {
      full_name = existing.full_name,
      shiur_group = existing.shiur_group,
      phone = existing.phone,
      notes = existing.notes,
    } = req.body || {};
    if (!String(full_name).trim()) {
      return res.status(400).json({ error: "שם השואל אינו יכול להיות ריק" });
    }
    const now = new Date().toISOString();
    const syncId = String(existing.sync_id || "") || newSyncId();
    db.run(
      "UPDATE borrowers SET full_name = ?, shiur_group = ?, phone = ?, notes = ?, sync_id = ?, updated_at = ? WHERE id = ?",
      String(full_name).trim(),
      String(shiur_group).trim(),
      String(phone).trim(),
      String(notes).trim(),
      syncId,
      now,
      id
    );
    const updated = db.get<Record<string, unknown>>("SELECT * FROM borrowers WHERE id = ?", id);
    enqueueSyncOutbox(db, "borrower", syncId, "upsert", updated || { sync_id: syncId, updated_at: now });
    res.json(updated);
  });

  app.delete("/api/borrowers/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const existing = db.get<{ id: number; sync_id?: string }>("SELECT id, sync_id FROM borrowers WHERE id = ? AND deleted_at IS NULL", id);
    if (!existing) return res.status(404).json({ error: "השואל לא נמצא" });
    const active = db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM loans WHERE borrower_id = ? AND return_date IS NULL AND deleted_at IS NULL",
      id
    );
    if ((active?.c ?? 0) > 0) {
      return res.status(400).json({ error: "לא ניתן למחוק שואל שברשותו ספרים מושאלים כעת. החזר את הספרים תחילה." });
    }
    const now = new Date().toISOString();
    db.transaction(() => {
      db.run("DELETE FROM borrowers WHERE id = ?", id);
      if (existing.sync_id) {
        enqueueSyncOutbox(db, "borrower", existing.sync_id, "delete", { sync_id: existing.sync_id, deleted_at: now });
      }
    });
    res.json({ ok: true });
  });

  // CSV / Excel Preview & Import
  app.post("/api/borrowers/import/preview", requireAdmin, (req, res) => {
    const { filename = "", contentBase64 = "" } = req.body || {};
    if (!contentBase64) {
      return res.status(400).json({ error: "לא התקבל קובץ לייבוא" });
    }
    try {
      const buf = Buffer.from(String(contentBase64), "base64");
      const isCsv = String(filename).toLowerCase().endsWith(".csv");
      const workbook = isCsv
        ? XLSX.read(decodeCsvText(buf), { type: "string" })
        : XLSX.read(buf, { type: "buffer" });

      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        return res.status(400).json({ error: "הקובץ ריק ואינו מכיל גיליונות" });
      }
      const sheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

      const existing = db.all<{ full_name: string; shiur_group: string }>(
        "SELECT full_name, shiur_group FROM borrowers WHERE deleted_at IS NULL"
      );
      const existingKeys = new Set(
        existing.map((e) => `${normalizeText(e.full_name)}||${normalizeText(e.shiur_group)}`)
      );
      const existingNames = new Set(existing.map((e) => normalizeText(e.full_name)));

      const seenInFile = new Set<string>();
      const parsed = rawRows
        .map((r, idx) => {
          const f = extractBorrowerFields(r);
          const key = `${normalizeText(f.full_name)}||${normalizeText(f.shiur_group)}`;
          const isDup =
            Boolean(f.full_name) &&
            (existingKeys.has(key) ||
              (!f.shiur_group && existingNames.has(normalizeText(f.full_name))) ||
              seenInFile.has(key));
          if (f.full_name) seenInFile.add(key);
          return {
            rowNumber: idx + 2,
            ...f,
            valid: Boolean(f.full_name),
            isDuplicate: isDup,
          };
        })
        .filter((r) => r.full_name || r.shiur_group || r.phone || r.notes);

      res.json({
        ok: true,
        sheetName: firstSheetName,
        totalRows: parsed.length,
        validRows: parsed.filter((r) => r.valid).length,
        duplicateRows: parsed.filter((r) => r.isDuplicate).length,
        rows: parsed.slice(0, 500),
      });
    } catch (err: any) {
      res.status(400).json({ error: "שגיאה בקריאת הקובץ: " + (err?.message || "פורמט לא נתמך") });
    }
  });

  app.post("/api/borrowers/import", requireAdmin, (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const skipDuplicates = req.body?.skipDuplicates !== false;
    if (rows.length === 0) {
      return res.status(400).json({ error: "אין שורות לייבוא" });
    }
    const now = new Date().toISOString();
    const existing = db.all<{ full_name: string; shiur_group: string }>(
      "SELECT full_name, shiur_group FROM borrowers WHERE deleted_at IS NULL"
    );
    const existingKeys = new Set(
      existing.map((e) => `${normalizeText(e.full_name)}||${normalizeText(e.shiur_group)}`)
    );

    let inserted = 0;
    let skipped = 0;

    db.transaction(() => {
      for (const r of rows) {
        const fullName = String(r.full_name || "").trim();
        const shiurGroup = String(r.shiur_group || "").trim();
        const phone = String(r.phone || "").trim();
        const notes = String(r.notes || "").trim();
        if (!fullName) {
          skipped++;
          continue;
        }
        const key = `${normalizeText(fullName)}||${normalizeText(shiurGroup)}`;
        if (skipDuplicates && existingKeys.has(key)) {
          skipped++;
          continue;
        }
        existingKeys.add(key);
        const syncId = newSyncId();
        db.run(
          "INSERT INTO borrowers (full_name, shiur_group, phone, notes, created_at, sync_id, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
          fullName,
          shiurGroup,
          phone,
          notes,
          now,
          syncId,
          now
        );
        enqueueSyncOutbox(db, "borrower", syncId, "upsert", {
          sync_id: syncId,
          full_name: fullName,
          shiur_group: shiurGroup,
          phone,
          notes,
          created_at: now,
          updated_at: now,
        });
        inserted++;
      }
    });

    res.status(201).json({ ok: true, inserted, skipped });
  });

  // Lookup barcode for instant checkout / return feedback
  app.get("/api/loans/lookup/:barcode", (req, res) => {
    const barcode = String(req.params.barcode || "").trim();
    const book = db.get<Record<string, unknown>>(
      `SELECT b.*, c.code AS cabinet_code, c.main_subject AS cabinet_subject
       FROM books b
       LEFT JOIN cabinets c ON b.cabinet_id = c.id AND c.deleted_at IS NULL
       WHERE b.barcode = ? AND b.deleted_at IS NULL`,
      barcode
    );
    if (!book) {
      return res.status(404).json({ error: `ברקוד "${barcode}" לא נמצא במאגר הספרים` });
    }
    const activeLoan = db.get<Record<string, unknown>>(
      `SELECT l.*, br.full_name AS borrower_name, br.shiur_group AS borrower_shiur
       FROM loans l
       JOIN borrowers br ON l.borrower_id = br.id
       WHERE l.book_barcode = ? AND l.return_date IS NULL AND l.deleted_at IS NULL AND br.deleted_at IS NULL
       ORDER BY l.id DESC LIMIT 1`,
      barcode
    );
    const { embedding: _drop, ...cleanBook } = book;
    res.json({ book: cleanBook, activeLoan: activeLoan || null });
  });

  // List loans (active / overdue / history)
  app.get("/api/loans", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "active";
    const q = typeof req.query.q === "string" ? normalizeText(req.query.q) : "";
    const nowMs = Date.now();

    const rows = db.all<Record<string, unknown>>(
      `SELECT l.*,
        bk.title AS book_title, bk.author AS book_author, bk.volume AS book_volume,
        bk.cabinet_id, c.code AS cabinet_code, bk.shelf_number, bk.status AS book_status,
        br.full_name AS borrower_name, br.shiur_group AS borrower_shiur, br.phone AS borrower_phone
       FROM loans l
       JOIN books bk ON l.book_barcode = bk.barcode
       LEFT JOIN cabinets c ON bk.cabinet_id = c.id AND c.deleted_at IS NULL
       JOIN borrowers br ON l.borrower_id = br.id
       WHERE l.deleted_at IS NULL AND bk.deleted_at IS NULL AND br.deleted_at IS NULL
       ORDER BY l.loan_date DESC, l.id DESC`
    );

    const mapped = rows.map((r) => {
      const dueMs = new Date(String(r.due_date)).getTime();
      const isOpen = !r.return_date;
      const isOverdue = isOpen && dueMs < nowMs;
      const daysOverdue = isOverdue ? Math.max(1, Math.floor((nowMs - dueMs) / 86400000)) : 0;
      return {
        ...r,
        is_overdue: isOverdue,
        days_overdue: daysOverdue,
      };
    });

    let filtered = mapped;
    if (status === "active") {
      filtered = mapped.filter((r) => !(r as any).return_date);
    } else if (status === "overdue") {
      filtered = mapped.filter((r) => r.is_overdue);
    } else if (status === "history") {
      filtered = mapped.filter((r) => Boolean((r as any).return_date)).slice(0, 200);
    }

    if (q) {
      filtered = filtered.filter((r: any) => {
        const hay = normalizeText(`${r.book_barcode} ${r.book_title} ${r.borrower_name} ${r.borrower_shiur}`);
        return hay.includes(q);
      });
    }

    res.json(filtered);
  });

  // Batch checkout by borrower_id + barcodes[]
  app.post("/api/loans/checkout", (req, res) => {
    const borrowerId = Number(req.body?.borrower_id);
    const rawBarcodes: string[] = Array.isArray(req.body?.barcodes) ? req.body.barcodes : [];
    const barcodes = Array.from(new Set(rawBarcodes.map((b) => String(b).trim()).filter(Boolean)));
    const forceReferenceOverride = Boolean(req.body?.forceReferenceOverride);

    if (!borrowerId) {
      return res.status(400).json({ error: "יש לבחור שואל לפני ביצוע ההשאלה" });
    }
    if (barcodes.length === 0) {
      return res.status(400).json({ error: "יש לסרוק או להזין לפחות ברקוד ספר אחד" });
    }

    const borrower = db.get<{ id: number; full_name: string; sync_id?: string }>(
      "SELECT id, full_name, sync_id FROM borrowers WHERE id = ? AND deleted_at IS NULL",
      borrowerId
    );
    if (!borrower) {
      return res.status(404).json({ error: "השואל הנבחר לא נמצא במערכת" });
    }

    const defaultDaysSetting = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'default_loan_days'")?.value ?? "14";
    const loanDays = Math.max(1, Math.min(365, Number(req.body?.loan_days) || parseInt(defaultDaysSetting, 10) || 14));

    const referenceBooks: Array<{ barcode: string; title: string }> = [];
    const checkedBooks: Array<{ barcode: string; title: string; status: string; sync_id?: string }> = [];

    for (const code of barcodes) {
      const book = db.get<{ barcode: string; title: string; status: string; sync_id?: string }>(
        "SELECT barcode, title, status, sync_id FROM books WHERE barcode = ? AND deleted_at IS NULL",
        code
      );
      if (!book) {
        return res.status(404).json({ error: `ברקוד "${code}" לא נמצא במאגר הספרים` });
      }
      const openLoan = db.get<{ borrower_name: string }>(
        `SELECT br.full_name AS borrower_name
         FROM loans l JOIN borrowers br ON l.borrower_id = br.id
         WHERE l.book_barcode = ? AND l.return_date IS NULL AND l.deleted_at IS NULL LIMIT 1`,
        code
      );
      if (openLoan || book.status === "borrowed") {
        const who = openLoan ? ` ל${openLoan.borrower_name}` : "";
        return res.status(409).json({ error: `הספר "${book.title}" (ברקוד ${code}) כבר מושאל כעת${who}` });
      }
      if (book.status === "lost") {
        return res.status(400).json({ error: `הספר "${book.title}" (ברקוד ${code}) מסומן כאבוד/חסר במערכת` });
      }
      if (book.status === "reference_only" && !forceReferenceOverride) {
        referenceBooks.push({ barcode: book.barcode, title: book.title });
      }
      checkedBooks.push(book);
    }

    if (referenceBooks.length > 0) {
      return res.status(409).json({
        error: `הספר "${referenceBooks[0].title}" מוגדר "לעיון בלבד". האם לאשר השאלה חריגה?`,
        requiresConfirmation: true,
        referenceBooks,
      });
    }

    const nowIso = new Date().toISOString();
    const dueIso = new Date(Date.now() + loanDays * 86400000).toISOString();

    db.transaction(() => {
      for (const bk of checkedBooks) {
        const loanSyncId = newSyncId();
        db.run(
          "INSERT INTO loans (book_barcode, borrower_id, loan_date, due_date, return_date, sync_id, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)",
          bk.barcode,
          borrowerId,
          nowIso,
          dueIso,
          loanSyncId,
          nowIso
        );
        const bookSyncId = bk.sync_id || newSyncId();
        db.run(
          "UPDATE books SET status = 'borrowed', sync_id = COALESCE(sync_id, ?), updated_at = ? WHERE barcode = ?",
          bookSyncId,
          nowIso,
          bk.barcode
        );
        enqueueSyncOutbox(db, "loan", loanSyncId, "upsert", {
          sync_id: loanSyncId,
          book_barcode: bk.barcode,
          book_sync_id: bookSyncId,
          borrower_id: borrowerId,
          borrower_sync_id: borrower.sync_id || null,
          loan_date: nowIso,
          due_date: dueIso,
          return_date: null,
          updated_at: nowIso,
        });
        enqueueSyncOutbox(db, "book", bookSyncId, "upsert", {
          sync_id: bookSyncId,
          barcode: bk.barcode,
          status: "borrowed",
          updated_at: nowIso,
        });
      }
    });

    res.status(201).json({
      ok: true,
      count: barcodes.length,
      barcodes,
      borrower_name: borrower.full_name,
      loan_date: nowIso,
      due_date: dueIso,
    });
  });

  // Fast return by barcode scan
  app.post("/api/loans/return", (req, res) => {
    const barcode = String(req.body?.barcode || "").trim();
    if (!barcode) {
      return res.status(400).json({ error: "יש לסרוק או להזין ברקוד להחזרה" });
    }

    const book = db.get<Record<string, unknown>>(
      `SELECT b.barcode, b.title, b.author, b.volume, b.status, b.shelf_number, b.sync_id, c.code AS cabinet_code, c.main_subject AS cabinet_subject
       FROM books b
       LEFT JOIN cabinets c ON b.cabinet_id = c.id AND c.deleted_at IS NULL
       WHERE b.barcode = ? AND b.deleted_at IS NULL`,
      barcode
    );
    if (!book) {
      return res.status(404).json({ error: `ברקוד "${barcode}" לא נמצא במאגר הספרים` });
    }

    const openLoan = db.get<{
      id: number;
      borrower_id: number;
      loan_date: string;
      due_date: string;
      sync_id?: string;
      borrower_name: string;
      borrower_shiur: string;
    }>(
      `SELECT l.id, l.borrower_id, l.loan_date, l.due_date, l.sync_id, br.full_name AS borrower_name, br.shiur_group AS borrower_shiur
       FROM loans l
       JOIN borrowers br ON l.borrower_id = br.id
       WHERE l.book_barcode = ? AND l.return_date IS NULL AND l.deleted_at IS NULL
       ORDER BY l.id DESC LIMIT 1`,
      barcode
    );

    const nowIso = new Date().toISOString();
    const bookSyncId = String(book.sync_id || "") || newSyncId();

    if (openLoan) {
      const wasOverdue = new Date(openLoan.due_date).getTime() < Date.now();
      const loanSyncId = openLoan.sync_id || newSyncId();
      db.transaction(() => {
        db.run(
          "UPDATE loans SET return_date = ?, sync_id = COALESCE(sync_id, ?), updated_at = ? WHERE id = ?",
          nowIso,
          loanSyncId,
          nowIso,
          openLoan.id
        );
        db.run(
          "UPDATE books SET status = 'available', sync_id = COALESCE(sync_id, ?), updated_at = ? WHERE barcode = ?",
          bookSyncId,
          nowIso,
          barcode
        );
        enqueueSyncOutbox(db, "loan", loanSyncId, "upsert", {
          sync_id: loanSyncId,
          book_barcode: barcode,
          borrower_id: openLoan.borrower_id,
          loan_date: openLoan.loan_date,
          due_date: openLoan.due_date,
          return_date: nowIso,
          updated_at: nowIso,
        });
        enqueueSyncOutbox(db, "book", bookSyncId, "upsert", {
          sync_id: bookSyncId,
          barcode,
          status: "available",
          updated_at: nowIso,
        });
      });
      return res.json({
        ok: true,
        book,
        borrower_name: openLoan.borrower_name,
        borrower_shiur: openLoan.borrower_shiur,
        loan_date: openLoan.loan_date,
        due_date: openLoan.due_date,
        return_date: nowIso,
        wasOverdue,
      });
    }

    if (book.status === "borrowed") {
      db.transaction(() => {
        db.run(
          "UPDATE books SET status = 'available', sync_id = COALESCE(sync_id, ?), updated_at = ? WHERE barcode = ?",
          bookSyncId,
          nowIso,
          barcode
        );
        enqueueSyncOutbox(db, "book", bookSyncId, "upsert", {
          sync_id: bookSyncId,
          barcode,
          status: "available",
          updated_at: nowIso,
        });
      });
      return res.json({
        ok: true,
        book,
        borrower_name: null,
        wasOverdue: false,
        note: "הספר סומן כזמין במערכת (לא הייתה השאלה פתוחה מקושרת)",
      });
    }

    return res.status(400).json({
      error: `הספר "${book.title}" (ברקוד ${barcode}) אינו רשום כמושאל כרגע`,
    });
  });

  // Extend active loan due date
  app.put("/api/loans/:id/extend", (req, res) => {
    const id = Number(req.params.id);
    const days = Math.max(1, Math.min(90, Number(req.body?.days) || 7));
    const loan = db.get<{
      id: number;
      book_barcode: string;
      borrower_id: number;
      loan_date: string;
      due_date: string;
      return_date: string | null;
      sync_id?: string;
    }>("SELECT id, book_barcode, borrower_id, loan_date, due_date, return_date, sync_id FROM loans WHERE id = ? AND deleted_at IS NULL", id);
    if (!loan || loan.return_date) {
      return res.status(404).json({ error: "השאלה פתוחה לא נמצאה" });
    }
    const baseMs = Math.max(Date.now(), new Date(loan.due_date).getTime());
    const newDue = new Date(baseMs + days * 86400000).toISOString();
    const nowIso = new Date().toISOString();
    const loanSyncId = loan.sync_id || newSyncId();
    db.run(
      "UPDATE loans SET due_date = ?, sync_id = COALESCE(sync_id, ?), updated_at = ? WHERE id = ?",
      newDue,
      loanSyncId,
      nowIso,
      id
    );
    enqueueSyncOutbox(db, "loan", loanSyncId, "upsert", {
      sync_id: loanSyncId,
      book_barcode: loan.book_barcode,
      borrower_id: loan.borrower_id,
      loan_date: loan.loan_date,
      due_date: newDue,
      return_date: null,
      updated_at: nowIso,
    });
    res.json({ ok: true, due_date: newDue });
  });
}
