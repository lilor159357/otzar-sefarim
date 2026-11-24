import type { Express } from "express";
import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import type { DbClient } from "../db/adapter.ts";
import { enqueueSyncOutbox, newSyncId } from "../db/schema.ts";
import { extractTokenFromRequest, isAdminRequest, issueAdminToken, requireAdmin, revokeAdminToken } from "../auth/adminAuth.ts";
import { generateLabelsPdfBuffer, type A4TemplateConfig, type LabelBookInput, type LabelDesignConfig } from "../pdf/labelsPdf.ts";
import { fallbackT, type StringsTranslateFn } from "../../shared/strings/engine.ts";

function getJsonSetting<T>(db: DbClient, key: string, fallback: T): T {
  const row = db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function registerLabelsAndAdminRoutes(app: Express, db: DbClient, dataDir: string, t: StringsTranslateFn = fallbackT) {
  // --- Admin PIN Authentication ---
  app.get("/api/admin/status", (req, res) => {
    res.json({ isAdmin: isAdminRequest(req) });
  });

  app.post("/api/admin/login", (req, res) => {
    const pin = String(req.body?.pin || "").trim();
    const storedPin = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'admin_pin'")?.value ?? "1234";
    if (!pin || pin !== storedPin) {
      return res.status(401).json({ error: t("errors.adminPinInvalid") });
    }
    const token = issueAdminToken();
    res.json({ ok: true, token });
  });

  app.post("/api/admin/logout", (req, res) => {
    const token = extractTokenFromRequest(req);
    revokeAdminToken(token);
    res.json({ ok: true });
  });

  app.put("/api/admin/pin", requireAdmin, (req, res) => {
    const newPin = String(req.body?.newPin || "").trim();
    if (newPin.length < 4) {
      return res.status(400).json({ error: t("errors.pinMinLength") });
    }
    db.run("INSERT INTO settings (key, value) VALUES ('admin_pin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", newPin);
    res.json({ ok: true });
  });

  // --- Barcode Labels Queue & A4 PDF Engine ---
  app.get("/api/labels/queue", requireAdmin, (_req, res) => {
    const rows = db.all(
      `SELECT b.barcode, b.title, b.author, b.volume, b.category, b.shelf_number, b.label_printed, b.barcode_status, b.created_at,
              c.code AS cabinet_code
       FROM books b
       LEFT JOIN cabinets c ON b.cabinet_id = c.id AND c.deleted_at IS NULL
       WHERE b.label_printed = 0 AND b.deleted_at IS NULL
       ORDER BY b.barcode ASC`
    );
    res.json(rows);
  });

  app.post("/api/labels/queue/add", requireAdmin, (req, res) => {
    const barcodes: string[] = Array.isArray(req.body?.barcodes) ? req.body.barcodes : [];
    if (barcodes.length === 0) return res.status(400).json({ error: t("errors.noBarcodesSelected") });
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const bc of barcodes) {
        const code = String(bc).trim();
        db.run("UPDATE books SET label_printed = 0, updated_at = ? WHERE barcode = ? AND deleted_at IS NULL", now, code);
        const row = db.get<{ sync_id?: string }>("SELECT sync_id FROM books WHERE barcode = ?", code);
        if (row?.sync_id) {
          enqueueSyncOutbox(db, "book", row.sync_id, "upsert", { sync_id: row.sync_id, barcode: code, label_printed: 0, updated_at: now });
        }
      }
    });
    res.json({ ok: true, count: barcodes.length });
  });

  app.post("/api/labels/queue/mark-printed", requireAdmin, (req, res) => {
    const barcodes: string[] = Array.isArray(req.body?.barcodes) ? req.body.barcodes : [];
    if (barcodes.length === 0) return res.status(400).json({ error: t("errors.noBarcodesSelected") });
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const bc of barcodes) {
        const code = String(bc).trim();
        db.run(
          "UPDATE books SET label_printed = 1, barcode_status = 'assigned', updated_at = ? WHERE barcode = ? AND deleted_at IS NULL",
          now,
          code
        );
        const row = db.get<{ sync_id?: string }>("SELECT sync_id FROM books WHERE barcode = ?", code);
        if (row) {
          const syncId = row.sync_id || newSyncId();
          enqueueSyncOutbox(db, "book", syncId, "upsert", {
            sync_id: syncId,
            barcode: code,
            label_printed: 1,
            barcode_status: "assigned",
            updated_at: now,
          });
        }
      }
    });
    res.json({ ok: true, count: barcodes.length });
  });

  app.post("/api/labels/generate-pdf", requireAdmin, async (req, res) => {
    try {
      const barcodes: string[] = Array.isArray(req.body?.barcodes) ? req.body.barcodes : [];
      const startPosition = Math.max(1, Number(req.body?.startPosition) || 1);
      const drawGuides = Boolean(req.body?.drawGuides);
      const markAsPrinted = Boolean(req.body?.markAsPrinted);

      let books: LabelBookInput[] = [];
      if (barcodes.length > 0) {
        const placeholders = barcodes.map(() => "?").join(",");
        books = db.all<LabelBookInput>(
          `SELECT b.barcode, b.title, b.volume, b.shelf_number, c.code AS cabinet_code
           FROM books b
           LEFT JOIN cabinets c ON b.cabinet_id = c.id AND c.deleted_at IS NULL
           WHERE b.barcode IN (${placeholders}) AND b.deleted_at IS NULL
           ORDER BY b.barcode ASC`,
          ...barcodes.map((b) => String(b).trim())
        );
      } else {
        books = db.all<LabelBookInput>(
          `SELECT b.barcode, b.title, b.volume, b.shelf_number, c.code AS cabinet_code
           FROM books b
           LEFT JOIN cabinets c ON b.cabinet_id = c.id AND c.deleted_at IS NULL
           WHERE b.label_printed = 0 AND b.deleted_at IS NULL
           ORDER BY b.barcode ASC`
        );
      }

      if (books.length === 0) {
        return res.status(400).json({ error: t("errors.noBooksForLabels") });
      }

      const libraryName = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'library_name'")?.value ?? "אוצר ספרים";
      const defaultTemplate: A4TemplateConfig = {
        rows: 8,
        cols: 3,
        marginTopMm: 12,
        marginRightMm: 8,
        marginBottomMm: 12,
        marginLeftMm: 8,
        gapXMm: 4,
        gapYMm: 2,
      };
      const defaultDesign: LabelDesignConfig = {
        showLibraryName: false,
        showBookTitle: true,
        showLocation: true,
      };

      const template = { ...defaultTemplate, ...getJsonSetting(db, "a4_template", defaultTemplate), ...(req.body?.templateOverride || {}) };
      const design = { ...defaultDesign, ...getJsonSetting(db, "label_config", defaultDesign), ...(req.body?.configOverride || {}) };

      const pdfBytes = await generateLabelsPdfBuffer({
        books,
        libraryName,
        template,
        design,
        startPosition,
        drawGuides,
      });

      if (markAsPrinted) {
        const now = new Date().toISOString();
        db.transaction(() => {
          for (const bk of books) {
            db.run(
              "UPDATE books SET label_printed = 1, barcode_status = 'assigned', updated_at = ? WHERE barcode = ?",
              now,
              bk.barcode
            );
          }
        });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'inline; filename="otzar-labels.pdf"');
      res.send(Buffer.from(pdfBytes));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || t("errors.pdfGenerateFailed") });
    }
  });

  // --- Shelving & Physical Space Report ---
  app.get("/api/reports/shelving", requireAdmin, (_req, res) => {
    const cabinets = db.all<{
      id: number;
      code: string;
      main_subject: string;
      shelves_count: number;
    }>("SELECT id, code, main_subject, shelves_count FROM cabinets WHERE deleted_at IS NULL ORDER BY code ASC");

    const books = db.all<{
      barcode: string;
      cabinet_id: number | null;
      shelf_number: number | null;
      format_size: string;
      thickness_mm: number | null;
      pages_count: number | null;
      status: string;
    }>(
      "SELECT barcode, cabinet_id, shelf_number, format_size, thickness_mm, pages_count, status FROM books WHERE deleted_at IS NULL"
    );

    const formatBreakdown: Record<string, number> = {};
    let totalThicknessMm = 0;
    let knownThicknessCount = 0;
    let missingThicknessCount = 0;
    let assignedBooks = 0;
    let unassignedBooks = 0;
    let unassignedThicknessMm = 0;
    let unassignedMissingThickness = 0;

    type ShelfAcc = {
      shelfNumber: number;
      booksCount: number;
      totalThicknessMm: number;
      knownThicknessCount: number;
      missingThicknessCount: number;
      formatCounts: Record<string, number>;
    };

    const cabMap = new Map<
      number,
      {
        id: number;
        code: string;
        main_subject: string;
        shelves_count: number;
        booksCount: number;
        totalThicknessMm: number;
        knownThicknessCount: number;
        missingThicknessCount: number;
        formatCounts: Record<string, number>;
        shelves: Map<number, ShelfAcc>;
      }
    >();

    for (const cab of cabinets) {
      const shelves = new Map<number, ShelfAcc>();
      const count = Math.max(1, Number(cab.shelves_count) || 5);
      for (let s = 1; s <= count; s++) {
        shelves.set(s, {
          shelfNumber: s,
          booksCount: 0,
          totalThicknessMm: 0,
          knownThicknessCount: 0,
          missingThicknessCount: 0,
          formatCounts: {},
        });
      }
      cabMap.set(cab.id, {
        id: cab.id,
        code: cab.code,
        main_subject: cab.main_subject,
        shelves_count: count,
        booksCount: 0,
        totalThicknessMm: 0,
        knownThicknessCount: 0,
        missingThicknessCount: 0,
        formatCounts: {},
        shelves,
      });
    }

    for (const b of books) {
      const fmt = String(b.format_size || "").trim() || "לא הוגדר";
      formatBreakdown[fmt] = (formatBreakdown[fmt] || 0) + 1;

      const thick = b.thickness_mm != null && Number(b.thickness_mm) > 0 ? Number(b.thickness_mm) : null;
      if (thick != null) {
        totalThicknessMm += thick;
        knownThicknessCount += 1;
      } else {
        missingThicknessCount += 1;
      }

      const cabEntry = b.cabinet_id != null ? cabMap.get(b.cabinet_id) : undefined;
      if (!cabEntry) {
        unassignedBooks += 1;
        if (thick != null) unassignedThicknessMm += thick;
        else unassignedMissingThickness += 1;
        continue;
      }

      assignedBooks += 1;
      cabEntry.booksCount += 1;
      cabEntry.formatCounts[fmt] = (cabEntry.formatCounts[fmt] || 0) + 1;
      if (thick != null) {
        cabEntry.totalThicknessMm += thick;
        cabEntry.knownThicknessCount += 1;
      } else {
        cabEntry.missingThicknessCount += 1;
      }

      const shelfNum = Number(b.shelf_number) > 0 ? Number(b.shelf_number) : 0;
      let shelfAcc = cabEntry.shelves.get(shelfNum);
      if (!shelfAcc) {
        shelfAcc = {
          shelfNumber: shelfNum,
          booksCount: 0,
          totalThicknessMm: 0,
          knownThicknessCount: 0,
          missingThicknessCount: 0,
          formatCounts: {},
        };
        cabEntry.shelves.set(shelfNum, shelfAcc);
      }
      shelfAcc.booksCount += 1;
      shelfAcc.formatCounts[fmt] = (shelfAcc.formatCounts[fmt] || 0) + 1;
      if (thick != null) {
        shelfAcc.totalThicknessMm += thick;
        shelfAcc.knownThicknessCount += 1;
      } else {
        shelfAcc.missingThicknessCount += 1;
      }
    }

    const round1 = (n: number) => Math.round(n * 10) / 10;

    const cabinetReports = Array.from(cabMap.values()).map((cab) => {
      const shelfRows = Array.from(cab.shelves.values())
        .sort((a, b) => a.shelfNumber - b.shelfNumber)
        .map((s) => ({
          shelfNumber: s.shelfNumber,
          booksCount: s.booksCount,
          totalThicknessMm: round1(s.totalThicknessMm),
          totalThicknessCm: round1(s.totalThicknessMm / 10),
          avgThicknessMm: s.knownThicknessCount > 0 ? round1(s.totalThicknessMm / s.knownThicknessCount) : null,
          knownThicknessCount: s.knownThicknessCount,
          missingThicknessCount: s.missingThicknessCount,
          formatCounts: s.formatCounts,
        }));

      return {
        id: cab.id,
        code: cab.code,
        main_subject: cab.main_subject,
        shelves_count: cab.shelves_count,
        booksCount: cab.booksCount,
        totalThicknessMm: round1(cab.totalThicknessMm),
        totalThicknessCm: round1(cab.totalThicknessMm / 10),
        avgThicknessMm: cab.knownThicknessCount > 0 ? round1(cab.totalThicknessMm / cab.knownThicknessCount) : null,
        knownThicknessCount: cab.knownThicknessCount,
        missingThicknessCount: cab.missingThicknessCount,
        formatCounts: cab.formatCounts,
        shelves: shelfRows,
      };
    });

    res.json({
      totals: {
        totalBooks: books.length,
        assignedBooks,
        unassignedBooks,
        totalThicknessMm: round1(totalThicknessMm),
        totalThicknessCm: round1(totalThicknessMm / 10),
        avgThicknessMm: knownThicknessCount > 0 ? round1(totalThicknessMm / knownThicknessCount) : null,
        knownThicknessCount,
        missingThicknessCount,
        formatBreakdown,
      },
      unassigned: {
        booksCount: unassignedBooks,
        totalThicknessCm: round1(unassignedThicknessMm / 10),
        missingThicknessCount: unassignedMissingThickness,
      },
      cabinets: cabinetReports,
    });
  });

  // --- Backup & Catalog Export (CSV BOM / Excel / SQLite .db) ---
  app.get("/api/export/books.csv", requireAdmin, (_req, res) => {
    const rows = db.all<Record<string, unknown>>(
      `SELECT b.barcode, b.title, b.author, b.volume, b.publisher, b.pub_year, b.edition, b.category, b.tags,
              b.format_size, b.thickness_mm, b.pages_count, b.barcode_status,
              c.code AS cabinet_code, b.shelf_number, b.status, b.notes, b.created_at
       FROM books b
       LEFT JOIN cabinets c ON b.cabinet_id = c.id AND c.deleted_at IS NULL
       WHERE b.deleted_at IS NULL
       ORDER BY b.barcode ASC`
    );
    const headers = [
      "ברקוד",
      "שם הספר",
      "מחבר",
      "כרך",
      "הוצאה",
      "שנת הוצאה",
      "מהדורה",
      "קטגוריה",
      "תגיות",
      "גודל/פורמט",
      "עובי (מ״מ)",
      "עמודים",
      "סטטוס ברקוד",
      "ארון",
      "מדף",
      "סטטוס",
      "הערות",
      "תאריך הוספה",
    ];
    const esc = (v: unknown) => {
      const s = String(v ?? "").replace(/"/g, '""');
      return `"${s}"`;
    };
    const lines = [headers.map(esc).join(",")];
    for (const r of rows) {
      let tagsReadable = String(r.tags || "");
      try {
        const parsed = JSON.parse(tagsReadable);
        if (Array.isArray(parsed)) tagsReadable = parsed.join(", ");
      } catch {}
      lines.push(
        [
          r.barcode,
          r.title,
          r.author,
          r.volume,
          r.publisher,
          r.pub_year || "",
          r.edition || "",
          r.category,
          tagsReadable,
          r.format_size || "",
          r.thickness_mm ?? "",
          r.pages_count ?? "",
          r.barcode_status || "assigned",
          r.cabinet_code || "",
          r.shelf_number ?? "",
          r.status,
          r.notes,
          r.created_at,
        ]
          .map(esc)
          .join(",")
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="otzar-catalog.csv"');
    res.send("\uFEFF" + lines.join("\r\n"));
  });

  app.get("/api/export/books.xlsx", requireAdmin, (_req, res) => {
    const rows = db.all<Record<string, unknown>>(
      `SELECT b.barcode AS "ברקוד", b.title AS "שם הספר", b.author AS "מחבר", b.volume AS "כרך",
              b.publisher AS "הוצאה", b.pub_year AS "שנת הוצאה", b.edition AS "מהדורה", b.category AS "קטגוריה",
              b.format_size AS "גודל/פורמט", b.thickness_mm AS "עובי (מ״מ)", b.pages_count AS "עמודים",
              b.barcode_status AS "סטטוס ברקוד", c.code AS "ארון",
              b.shelf_number AS "מדף", b.status AS "סטטוס", b.notes AS "הערות"
       FROM books b
       LEFT JOIN cabinets c ON b.cabinet_id = c.id AND c.deleted_at IS NULL
       WHERE b.deleted_at IS NULL
       ORDER BY b.barcode ASC`
    );
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, ws, "קטלוג ספרים");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="otzar-catalog.xlsx"');
    res.send(buf);
  });

  app.get("/api/backup/download", requireAdmin, (_req, res) => {
    const backupsDir = path.join(dataDir, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const tmpDest = path.join(backupsDir, `download_tmp_${Date.now()}.db`);
    db.backupTo(tmpDest);
    res.download(tmpDest, `otzar-backup-${stamp}.db`, () => {
      try {
        if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
      } catch {}
    });
  });

  app.post("/api/backup/save-local", requireAdmin, (_req, res) => {
    const backupsDir = path.join(dataDir, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dest = path.join(backupsDir, `otzar-backup-${stamp}.db`);
    db.backupTo(dest);
    res.json({ ok: true, path: dest });
  });
}
