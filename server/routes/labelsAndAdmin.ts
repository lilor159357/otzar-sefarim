import type { Express } from "express";
import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import type { DbClient } from "../db/adapter.ts";
import { extractTokenFromRequest, isAdminRequest, issueAdminToken, requireAdmin, revokeAdminToken } from "../auth/adminAuth.ts";
import { generateLabelsPdfBuffer, type A4TemplateConfig, type LabelBookInput, type LabelDesignConfig } from "../pdf/labelsPdf.ts";

function getJsonSetting<T>(db: DbClient, key: string, fallback: T): T {
  const row = db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function registerLabelsAndAdminRoutes(app: Express, db: DbClient, dataDir: string) {
  // --- Admin PIN Authentication ---
  app.get("/api/admin/status", (req, res) => {
    res.json({ isAdmin: isAdminRequest(req) });
  });

  app.post("/api/admin/login", (req, res) => {
    const pin = String(req.body?.pin || "").trim();
    const storedPin = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'admin_pin'")?.value ?? "1234";
    if (!pin || pin !== storedPin) {
      return res.status(401).json({ error: "קוד PIN שגוי" });
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
      return res.status(400).json({ error: "קוד PIN חייב להכיל לפחות 4 תווים" });
    }
    db.run("INSERT INTO settings (key, value) VALUES ('admin_pin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", newPin);
    res.json({ ok: true });
  });

  // --- Barcode Labels Queue & A4 PDF Engine ---
  app.get("/api/labels/queue", requireAdmin, (_req, res) => {
    const rows = db.all(
      `SELECT b.barcode, b.title, b.author, b.volume, b.category, b.shelf_number, b.label_printed, b.created_at,
              c.code AS cabinet_code
       FROM books b
       LEFT JOIN cabinets c ON b.cabinet_id = c.id
       WHERE b.label_printed = 0
       ORDER BY b.barcode ASC`
    );
    res.json(rows);
  });

  app.post("/api/labels/queue/add", requireAdmin, (req, res) => {
    const barcodes: string[] = Array.isArray(req.body?.barcodes) ? req.body.barcodes : [];
    if (barcodes.length === 0) return res.status(400).json({ error: "לא נבחרו ברקודים" });
    db.transaction(() => {
      for (const bc of barcodes) {
        db.run("UPDATE books SET label_printed = 0 WHERE barcode = ?", String(bc).trim());
      }
    });
    res.json({ ok: true, count: barcodes.length });
  });

  app.post("/api/labels/queue/mark-printed", requireAdmin, (req, res) => {
    const barcodes: string[] = Array.isArray(req.body?.barcodes) ? req.body.barcodes : [];
    if (barcodes.length === 0) return res.status(400).json({ error: "לא נבחרו ברקודים" });
    db.transaction(() => {
      for (const bc of barcodes) {
        db.run("UPDATE books SET label_printed = 1 WHERE barcode = ?", String(bc).trim());
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
           LEFT JOIN cabinets c ON b.cabinet_id = c.id
           WHERE b.barcode IN (${placeholders})
           ORDER BY b.barcode ASC`,
          ...barcodes.map((b) => String(b).trim())
        );
      } else {
        books = db.all<LabelBookInput>(
          `SELECT b.barcode, b.title, b.volume, b.shelf_number, c.code AS cabinet_code
           FROM books b
           LEFT JOIN cabinets c ON b.cabinet_id = c.id
           WHERE b.label_printed = 0
           ORDER BY b.barcode ASC`
        );
      }

      if (books.length === 0) {
        return res.status(400).json({ error: "אין ספרים להפקה במדבקות" });
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
        db.transaction(() => {
          for (const bk of books) {
            db.run("UPDATE books SET label_printed = 1 WHERE barcode = ?", bk.barcode);
          }
        });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'inline; filename="otzar-labels.pdf"');
      res.send(Buffer.from(pdfBytes));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "שגיאה ביצירת קובץ ה-PDF" });
    }
  });

  // --- Backup & Catalog Export (CSV BOM / Excel / SQLite .db) ---
  app.get("/api/export/books.csv", requireAdmin, (_req, res) => {
    const rows = db.all<Record<string, unknown>>(
      `SELECT b.barcode, b.title, b.author, b.volume, b.publisher, b.pub_year, b.edition, b.category, b.tags,
              c.code AS cabinet_code, b.shelf_number, b.status, b.notes, b.created_at
       FROM books b
       LEFT JOIN cabinets c ON b.cabinet_id = c.id
       ORDER BY b.barcode ASC`
    );
    const headers = ["ברקוד", "שם הספר", "מחבר", "כרך", "הוצאה", "שנת הוצאה", "מהדורה", "קטגוריה", "תגיות", "ארון", "מדף", "סטטוס", "הערות", "תאריך הוספה"];
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
              b.publisher AS "הוצאה", b.pub_year AS "שנת הוצאה", b.edition AS "מהדורה", b.category AS "קטגוריה", c.code AS "ארון",
              b.shelf_number AS "מדף", b.status AS "סטטוס", b.notes AS "הערות"
       FROM books b
       LEFT JOIN cabinets c ON b.cabinet_id = c.id
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
