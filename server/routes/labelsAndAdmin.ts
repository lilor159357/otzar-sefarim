import type { Express } from "express";
import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import type { DbClient } from "../db/adapter.ts";
import { enqueueSyncOutbox, newSyncId } from "../db/schema.ts";
import { extractTokenFromRequest, isAdminRequest, issueAdminToken, requireAdmin, revokeAdminToken } from "../auth/adminAuth.ts";
import { generateLabelsPdfBuffer, type A4TemplateConfig, type LabelBookInput, type LabelDesignConfig } from "../pdf/labelsPdf.ts";
import { fallbackT, type StringsTranslateFn } from "../../shared/strings/engine.ts";
import { formatGeminiError, generateSmartShelfPlanWithAi, getAiConfig } from "../ai/geminiService.ts";
import { readCustomVolumeNotationRules } from "../search/torahAuthority.ts";
import { analyzeMultiShelfSets, compareCabinetCodeNatural, type MultiShelfPrefs } from "../search/multiShelfSetOrganizer.ts";

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

  // --- Shelving & Physical Space Report + Smart Shelf Organizer ---
  function buildShelvingReportSnapshot() {
    const cabinets = db.all<{
      id: number;
      code: string;
      main_subject: string;
      shelves_count: number;
      width_cm: number | null;
      depth_cm: number | null;
    }>("SELECT id, code, main_subject, shelves_count, width_cm, depth_cm FROM cabinets WHERE deleted_at IS NULL ORDER BY code ASC");

    const books = db.all<{
      barcode: string;
      title: string;
      set_name: string;
      sub_series: string;
      volume: string;
      set_global_number: number | null;
      coverage_range: string;
      category: string;
      cabinet_id: number | null;
      shelf_number: number | null;
      format_size: string;
      thickness_mm: number | null;
      pages_count: number | null;
      status: string;
    }>(
      "SELECT barcode, title, set_name, sub_series, volume, set_global_number, coverage_range, category, cabinet_id, shelf_number, format_size, thickness_mm, pages_count, status FROM books WHERE deleted_at IS NULL"
    );

    const roomRaw = getJsonSetting<{ width_m?: number; length_m?: number }>(db, "room_dimensions", { width_m: 6, length_m: 5 });
    const roomWidthM = Number(roomRaw?.width_m) > 0 ? Number(roomRaw.width_m) : 6;
    const roomLengthM = Number(roomRaw?.length_m) > 0 ? Number(roomRaw.length_m) : 5;
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const roomAreaSqm = round2(roomWidthM * roomLengthM);

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
        width_cm: number | null;
        depth_cm: number | null;
        booksCount: number;
        totalThicknessMm: number;
        knownThicknessCount: number;
        missingThicknessCount: number;
        formatCounts: Record<string, number>;
        shelves: Map<number, ShelfAcc>;
      }
    >();

    let cabinetsFootprintSqm = 0;
    let cabinetsKnownCount = 0;
    for (const cab of cabinets) {
      const wCm = cab.width_cm != null && Number(cab.width_cm) > 0 ? Number(cab.width_cm) : null;
      const dCm = cab.depth_cm != null && Number(cab.depth_cm) > 0 ? Number(cab.depth_cm) : null;
      if (wCm && dCm) {
        cabinetsFootprintSqm += (wCm / 100) * (dCm / 100);
        cabinetsKnownCount += 1;
      }
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
        width_cm: wCm,
        depth_cm: dCm,
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

    const cabinetReports = Array.from(cabMap.values()).map((cab) => {
      const estimatedCapacityCm = cab.width_cm && cab.width_cm > 0 ? Math.max(20, round1(cab.width_cm - 4)) : 116;
      const shelfRows = Array.from(cab.shelves.values())
        .sort((a, b) => a.shelfNumber - b.shelfNumber)
        .map((s) => {
          const usedCm = round1(s.totalThicknessMm / 10);
          const estUsedCm = usedCm > 0 ? usedCm : s.booksCount > 0 ? round1(s.booksCount * 2.8) : 0;
          const fillPercent = Math.round((estUsedCm / estimatedCapacityCm) * 100);
          return {
            shelfNumber: s.shelfNumber,
            booksCount: s.booksCount,
            totalThicknessMm: round1(s.totalThicknessMm),
            totalThicknessCm: usedCm,
            estimatedCapacityCm,
            freeCm: round1(estimatedCapacityCm - estUsedCm),
            fillPercent,
            isOverloaded: fillPercent > 100,
            avgThicknessMm: s.knownThicknessCount > 0 ? round1(s.totalThicknessMm / s.knownThicknessCount) : null,
            knownThicknessCount: s.knownThicknessCount,
            missingThicknessCount: s.missingThicknessCount,
            formatCounts: s.formatCounts,
          };
        });

      const footprintSqm = cab.width_cm && cab.depth_cm ? round2((cab.width_cm / 100) * (cab.depth_cm / 100)) : null;
      const realShelves = shelfRows.filter((s) => s.shelfNumber > 0);
      const avgFillPercent = realShelves.length > 0 ? Math.round(realShelves.reduce((acc, s) => acc + s.fillPercent, 0) / realShelves.length) : 0;

      return {
        id: cab.id,
        code: cab.code,
        main_subject: cab.main_subject,
        shelves_count: cab.shelves_count,
        width_cm: cab.width_cm,
        depth_cm: cab.depth_cm,
        footprintSqm,
        avgFillPercent,
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

    const roundedCabFootprint = round2(cabinetsFootprintSqm);
    const aisleFreeSqm = round2(Math.max(0, roomAreaSqm - roundedCabFootprint));
    const aisleFreePercent = roomAreaSqm > 0 ? Math.round((aisleFreeSqm / roomAreaSqm) * 100) : 0;

    return {
      report: {
        room: {
          width_m: roomWidthM,
          length_m: roomLengthM,
          areaSqm: roomAreaSqm,
          cabinetsFootprintSqm: roundedCabFootprint,
          cabinetsKnownCount,
          aisleFreeSqm,
          aisleFreePercent,
        },
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
      },
      books,
    };
  }

  app.get("/api/reports/shelving", requireAdmin, (_req, res) => {
    const { report } = buildShelvingReportSnapshot();
    res.json(report);
  });

  app.put("/api/shelving/smart-organize-prefs", requireAdmin, (req, res) => {
    const raw = req.body || {};
    const prefs: MultiShelfPrefs = {
      shelfDirection: raw.shelfDirection === "bottom_up" ? "bottom_up" : "top_down",
      customShelfOrders:
        raw.customShelfOrders && typeof raw.customShelfOrders === "object"
          ? raw.customShelfOrders
          : {},
    };
    db.run(
      "INSERT INTO settings (key, value) VALUES ('smart_shelf_prefs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(prefs)
    );
    res.json({ ok: true, prefs });
  });

  app.post("/api/shelving/smart-organize", requireAdmin, async (req, res) => {
    const useAi = Boolean(req.body?.useAi);
    const storedPrefs = getJsonSetting<Partial<MultiShelfPrefs>>(db, "smart_shelf_prefs", {
      shelfDirection: "top_down",
      customShelfOrders: {},
    });
    const bodyPrefs = req.body?.prefs as Partial<MultiShelfPrefs> | undefined;
    const effectivePrefs: MultiShelfPrefs = {
      shelfDirection:
        bodyPrefs?.shelfDirection === "bottom_up" || (!bodyPrefs?.shelfDirection && storedPrefs?.shelfDirection === "bottom_up")
          ? "bottom_up"
          : "top_down",
      customShelfOrders:
        bodyPrefs?.customShelfOrders && typeof bodyPrefs.customShelfOrders === "object"
          ? bodyPrefs.customShelfOrders
          : storedPrefs?.customShelfOrders && typeof storedPrefs.customShelfOrders === "object"
          ? storedPrefs.customShelfOrders
          : {},
    };
    const ignoredRaw = getJsonSetting<unknown[]>(db, "ignored_missing_volumes", []);
    const ignoredMissingKeys = new Set(
      (Array.isArray(ignoredRaw) ? ignoredRaw : []).map((x) => String(x || "").trim()).filter(Boolean)
    );
    const volumeNotationRules = readCustomVolumeNotationRules(db);
    const { report, books } = buildShelvingReportSnapshot();
    const { multiShelfSets, handledSetNames } = analyzeMultiShelfSets({
      cabinets: report.cabinets,
      books,
      ignoredMissingKeys,
      volumeNotationRules,
      prefs: effectivePrefs,
    });
    const cabById = new Map(report.cabinets.map((c) => [c.id, c]));
    const cabByCode = new Map(report.cabinets.map((c) => [c.code.trim(), c]));

    type SmartMoveOut = {
      id: string;
      source: "deterministic" | "ai";
      title: string;
      description: string;
      reason: string;
      severity: "info" | "warning" | "high";
      fromCabinetId?: number;
      fromCabinetCode?: string;
      fromShelf?: number;
      toCabinetId?: number;
      toCabinetCode?: string;
      toShelf?: number;
      setName?: string;
      barcodes: string[];
    };

    const moves: SmartMoveOut[] = [];

    for (const cab of report.cabinets) {
      const shelvesReal = cab.shelves.filter((s) => s.shelfNumber > 0);
      for (const sh of shelvesReal) {
        if (sh.fillPercent <= 100) continue;
        const booksOnShelf = books.filter((b) => b.cabinet_id === cab.id && Number(b.shelf_number) === sh.shelfNumber);
        if (booksOnShelf.length === 0) continue;
        const excessCm = Math.max(5, Math.abs(sh.freeCm));
        const movable: string[] = [];
        let freedCm = 0;
        for (let i = booksOnShelf.length - 1; i >= 0 && freedCm < excessCm; i--) {
          const bk = booksOnShelf[i];
          movable.push(bk.barcode);
          freedCm += bk.thickness_mm && bk.thickness_mm > 0 ? bk.thickness_mm / 10 : 2.8;
        }
        const sameCabTarget = shelvesReal
          .filter((s) => s.shelfNumber !== sh.shelfNumber && s.freeCm >= Math.min(excessCm, 12))
          .sort((a, b) => b.freeCm - a.freeCm)[0];
        const sameSubjTargetCab = !sameCabTarget
          ? report.cabinets.find(
              (other) =>
                other.id !== cab.id &&
                cab.main_subject &&
                other.main_subject &&
                (other.main_subject.includes(cab.main_subject) || cab.main_subject.includes(other.main_subject)) &&
                other.shelves.some((os) => os.shelfNumber > 0 && os.freeCm >= 12)
            )
          : undefined;
        const destCab = sameCabTarget ? cab : sameSubjTargetCab;
        const destShelf = sameCabTarget
          ? sameCabTarget
          : destCab?.shelves.filter((s) => s.shelfNumber > 0 && s.freeCm >= 12).sort((a, b) => b.freeCm - a.freeCm)[0];

        moves.push({
          id: `overload-${cab.id}-${sh.shelfNumber}`,
          source: "deterministic",
          title: `עומס יתר במדף ${sh.shelfNumber} (ארון ${cab.code})`,
          description: destCab && destShelf
            ? `העברת ${movable.length} ספרים (${Math.round(freedCm)} ס״מ) לארון ${destCab.code} מדף ${destShelf.shelfNumber}`
            : `המדף בתפוסה של ${sh.fillPercent}% (${sh.totalThicknessCm} / ${sh.estimatedCapacityCm} ס״מ) — מומלץ לפנות ${Math.round(excessCm)} ס״מ`,
          reason: `מניעת דוחק ושחיקה בכריכות — יש ${sh.booksCount} ספרים על מדף ברוחב ${sh.estimatedCapacityCm} ס״מ`,
          severity: "high",
          fromCabinetId: cab.id,
          fromCabinetCode: cab.code,
          fromShelf: sh.shelfNumber,
          toCabinetId: destCab?.id,
          toCabinetCode: destCab?.code,
          toShelf: destShelf?.shelfNumber,
          barcodes: destCab && destShelf ? movable : [],
        });
      }
    }

    const bySet = new Map<string, typeof books>();
    for (const b of books) {
      const sn = String(b.set_name || "").trim();
      if (!sn || b.cabinet_id == null) continue;
      const arr = bySet.get(sn) || [];
      arr.push(b);
      bySet.set(sn, arr);
    }
    for (const [setName, setBooks] of bySet.entries()) {
      if (handledSetNames.has(setName) || handledSetNames.has(setName.toLowerCase())) continue;
      if (setBooks.length < 2) continue;
      const locGroups = new Map<string, typeof books>();
      for (const b of setBooks) {
        const key = `${b.cabinet_id}:${b.shelf_number || 1}`;
        const list = locGroups.get(key) || [];
        list.push(b);
        locGroups.set(key, list);
      }
      if (locGroups.size <= 1) continue;
      const sortedLocs = Array.from(locGroups.entries()).sort((a, b) => b[1].length - a[1].length);
      const [primaryKey, primaryList] = sortedLocs[0];
      const [pCabIdStr, pShelfStr] = primaryKey.split(":");
      const pCab = cabById.get(Number(pCabIdStr));
      const pShelfNum = Number(pShelfStr) || 1;
      if (!pCab) continue;
      const pShelfInfo = pCab.shelves.find((s) => s.shelfNumber === pShelfNum);
      const strays = sortedLocs.slice(1).flatMap(([, list]) => list);
      const straysWidthCm = strays.reduce((acc, b) => acc + (b.thickness_mm && b.thickness_mm > 0 ? b.thickness_mm / 10 : 3), 0);
      const canFit = !pShelfInfo || pShelfInfo.freeCm >= straysWidthCm * 0.8;
      const firstStrayCab = cabById.get(Number(strays[0].cabinet_id));

      moves.push({
        id: `split-${setName}`,
        source: "deterministic",
        title: `איחוד סט מפוצל: ${setName}`,
        description: canFit
          ? `איחוד ${strays.length} כרכים מפוזרים אל המיקום הראשי בארון ${pCab.code} מדף ${pShelfNum} (${primaryList.length} כרכים)`
          : `הסט ${setName} מפוצל בין ${locGroups.size} מדפים שונים (${strays.length} כרכים מפוזרים מארון ${firstStrayCab?.code || "?"})`,
        reason: "שמירה על רצף תורני ואיתור מהיר של כל הסט במקום אחד",
        severity: "warning",
        fromCabinetId: firstStrayCab?.id,
        fromCabinetCode: firstStrayCab?.code,
        fromShelf: Number(strays[0].shelf_number) || 1,
        toCabinetId: canFit ? pCab.id : undefined,
        toCabinetCode: canFit ? pCab.code : undefined,
        toShelf: canFit ? pShelfNum : undefined,
        setName,
        barcodes: canFit ? strays.map((s) => s.barcode) : [],
      });
    }

    const unassignedList = books.filter((b) => b.cabinet_id == null);
    if (unassignedList.length > 0 && report.cabinets.length > 0) {
      const groupedByTarget = new Map<number, { cab: typeof report.cabinets[number]; shelfNum: number; barcodes: string[] }>();
      for (const b of unassignedList) {
        const cat = String(b.category || "").trim();
        const text = `${cat} ${b.title} ${b.set_name}`.trim();
        const matchedCab =
          report.cabinets.find((c) => c.main_subject && (text.includes(c.main_subject) || (cat && c.main_subject.includes(cat)))) ||
          undefined;
        if (!matchedCab) continue;
        const bestShelf = matchedCab.shelves
          .filter((s) => s.shelfNumber > 0)
          .sort((a, b2) => b2.freeCm - a.freeCm)[0];
        if (!bestShelf) continue;
        const entry = groupedByTarget.get(matchedCab.id) || { cab: matchedCab, shelfNum: bestShelf.shelfNumber, barcodes: [] };
        entry.barcodes.push(b.barcode);
        groupedByTarget.set(matchedCab.id, entry);
      }
      for (const { cab, shelfNum, barcodes } of groupedByTarget.values()) {
        moves.push({
          id: `unassigned-${cab.id}-${shelfNum}`,
          source: "deterministic",
          title: `שיוך ${barcodes.length} ספרים ללא מיקום לארון ${cab.code}`,
          description: `שיבוץ אוטומטי לארון ${cab.code} (${cab.main_subject}) מדף ${shelfNum}`,
          reason: "הספרים תואמים לנושא הראשי של הארון ויש מקום פנוי במדף",
          severity: "info",
          toCabinetId: cab.id,
          toCabinetCode: cab.code,
          toShelf: shelfNum,
          barcodes,
        });
      }
    }

    const disorderedMultiCount = multiShelfSets.filter(
      (ms) => !ms.minimalMode.isOrdered || ms.shelfChain.some((s) => s.foreignAlerts.length > 0)
    ).length;
    const totalIssuesCount = moves.length + disorderedMultiCount;
    let summary =
      totalIssuesCount > 0
        ? `נמצאו ${moves.length} המלצות רוחב/שיבוץ ו-${disorderedMultiCount} סטים רב-מדפיים לסידור רצף`
        : "הספרייה מסודרת היטב — לא נמצאו מדפים עמוסים או סטים מבולגנים";
    let aiUsed = false;
    let aiError: string | undefined;

    if (useAi) {
      const cfg = getAiConfig(db);
      if (!cfg.hasAnyKey) {
        aiError = "לא הוגדר מפתח Gemini API בהגדרות";
      } else {
        try {
          const compactPayload = {
            room: report.room,
            cabinets: report.cabinets.map((c) => ({
              code: c.code,
              main_subject: c.main_subject,
              width_cm: c.width_cm,
              shelves: c.shelves.filter((s) => s.shelfNumber > 0).map((s) => ({
                shelfNumber: s.shelfNumber,
                booksCount: s.booksCount,
                fillPercent: s.fillPercent,
                freeCm: s.freeCm,
              })),
            })),
            unassignedSample: unassignedList.slice(0, 20).map((b) => ({ barcode: b.barcode, title: b.title, set_name: b.set_name, category: b.category })),
            splitSetsCount: moves.filter((m) => m.id.startsWith("split-")).length,
          };
          const aiPlan = await generateSmartShelfPlanWithAi(db, JSON.stringify(compactPayload), { timeoutMs: 45_000 });
          aiUsed = true;
          if (aiPlan.summary) summary = aiPlan.summary;
          aiPlan.moves.forEach((am, idx) => {
            const fromCab = am.fromCabinetCode ? cabByCode.get(am.fromCabinetCode.trim()) : undefined;
            const toCab = am.toCabinetCode ? cabByCode.get(am.toCabinetCode.trim()) : undefined;
            const resolvedBarcodes = Array.isArray(am.barcodes) ? am.barcodes.filter((bc) => books.some((bk) => bk.barcode === bc)) : [];
            moves.push({
              id: `ai-${idx}-${Date.now()}`,
              source: "ai",
              title: am.title,
              description: am.description,
              reason: am.reason,
              severity: am.severity,
              fromCabinetId: fromCab?.id,
              fromCabinetCode: fromCab?.code || am.fromCabinetCode,
              fromShelf: am.fromShelf,
              toCabinetId: toCab?.id,
              toCabinetCode: toCab?.code || am.toCabinetCode,
              toShelf: am.toShelf,
              setName: am.setName,
              barcodes: resolvedBarcodes,
            });
          });
        } catch (err) {
          aiError = formatGeminiError(err);
        }
      }
    }

    const cabinetsMeta = [...report.cabinets]
      .sort((a, b) => compareCabinetCodeNatural(a.code, b.code))
      .map((c) => ({
        id: c.id,
        code: c.code,
        main_subject: c.main_subject,
        shelves_count: c.shelves_count,
        shelves: c.shelves
          .filter((s) => s.shelfNumber > 0)
          .map((s) => ({
            shelfNumber: s.shelfNumber,
            estimatedCapacityCm: s.estimatedCapacityCm,
            totalThicknessCm: s.totalThicknessCm,
            booksCount: s.booksCount,
            fillPercent: s.fillPercent,
          })),
      }));
    res.json({ ok: true, summary, aiUsed, aiError, moves, multiShelfSets, prefs: effectivePrefs, cabinetsMeta });
  });

  app.post("/api/shelving/apply-moves", requireAdmin, (req, res) => {
    const rawMoves = Array.isArray(req.body?.moves) ? req.body.moves : [];
    if (rawMoves.length === 0) {
      return res.status(400).json({ error: "לא נבחרו מהלכים לביצוע" });
    }
    const now = new Date().toISOString();
    let movedBooks = 0;
    db.transaction(() => {
      for (const mv of rawMoves) {
        const toCabinetId = Number(mv?.toCabinetId);
        const cab = db.get<{ id: number; shelves_count: number }>("SELECT id, shelves_count FROM cabinets WHERE id = ? AND deleted_at IS NULL", toCabinetId);
        if (!cab) continue;
        const toShelf = Math.max(1, Math.min(cab.shelves_count || 5, Number(mv?.toShelf) || 1));
        const barcodes: string[] = Array.isArray(mv?.barcodes) ? mv.barcodes.map((b: unknown) => String(b).trim()).filter(Boolean) : [];
        for (const bc of barcodes) {
          const bk = db.get<{ sync_id: string | null }>("SELECT sync_id FROM books WHERE barcode = ? AND deleted_at IS NULL", bc);
          if (!bk) continue;
          db.run("UPDATE books SET cabinet_id = ?, shelf_number = ?, updated_at = ? WHERE barcode = ?", cab.id, toShelf, now, bc);
          if (bk.sync_id) enqueueSyncOutbox(db, "book", bk.sync_id, "upsert", { barcode: bc });
          movedBooks++;
        }
      }
    });
    res.json({ ok: true, movedBooks });
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
