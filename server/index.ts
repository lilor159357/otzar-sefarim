import express, { type Express } from "express";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { openDatabase } from "./db/adapter.ts";
import { buildNormalizedBookSearch, enqueueSyncOutbox, initSchemaAndSeed, newSyncId } from "./db/schema.ts";
import { searchBooksOffline, type SearchableBook } from "./search/torahSearch.ts";
import { registerCirculationRoutes } from "./routes/circulation.ts";
import { registerCatalogAiRoutes } from "./routes/catalogAi.ts";
import { registerLabelsAndAdminRoutes } from "./routes/labelsAndAdmin.ts";
import {
  registerUpdaterRoutes,
  scheduleStartupAutoUpdateCheck,
  type DesktopUpdaterBridge,
  type UpdaterRestartHooks,
} from "./routes/updater.ts";
import { isAdminRequest, requireAdmin } from "./auth/adminAuth.ts";
import { blobToFloat32, buildBookEmbeddingText, cosineSimilarity, float32ToBlob, generateTextEmbedding, getAiConfig, hasConfiguredAiKeys } from "./ai/geminiService.ts";

export interface OtzarServerOptions {
  rootDir?: string;
  dataDir?: string;
  preferredPort?: number;
  isElectron?: boolean;
  appVersion?: string;
  migratedFrom?: string | null;
  certSummary?: { loadedCount: number; mode: string };
  desktopUpdater?: DesktopUpdaterBridge;
}

export interface StartedOtzarServer {
  app: Express;
  port: number;
  url: string;
  dataDir: string;
  dbPath: string;
  close: () => void;
}

function resolveDefaultRootDir(): string {
  if (typeof __dirname !== "undefined" && __dirname) {
    return path.resolve(__dirname, "..");
  }
  try {
    const metaUrl = import.meta?.url;
    if (metaUrl) {
      return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..");
    }
  } catch {}
  return process.cwd();
}

function readPackageVersion(rootDir: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    return typeof raw?.version === "string" ? raw.version : "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(findFreePort(startPort + 1)));
    server.listen(startPort, "127.0.0.1", () => {
      server.close(() => resolve(startPort));
    });
  });
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean);
    } catch {}
    return raw.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

export async function startOtzarServer(options: OtzarServerOptions = {}): Promise<StartedOtzarServer> {
  const ROOT_DIR = options.rootDir || resolveDefaultRootDir();
  const DATA_DIR = options.dataDir || process.env.OTZAR_DATA_DIR || path.join(ROOT_DIR, "data");
  const DB_PATH = path.join(DATA_DIR, "otzar.db");
  const appVersion = options.appVersion || readPackageVersion(ROOT_DIR);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "ai_images"), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "backups"), { recursive: true });

  const db = await openDatabase(DB_PATH);
  initSchemaAndSeed(db);

  const app = express();
  app.use(express.json({ limit: "25mb" }));

  // Health & DB verification
  app.get("/api/health", (_req, res) => {
    const books = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM books WHERE deleted_at IS NULL")?.c ?? 0;
    const cabinets = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM cabinets WHERE deleted_at IS NULL")?.c ?? 0;
    const borrowers = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM borrowers WHERE deleted_at IS NULL")?.c ?? 0;
    const activeLoans = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM loans WHERE return_date IS NULL AND deleted_at IS NULL")?.c ?? 0;
    const printQueue = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM books WHERE label_printed = 0")?.c ?? 0;
    const aiQueue = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM ai_catalog_queue WHERE approval_status = 'pending'")?.c ?? 0;
    res.json({
      ok: true,
      driver: db.driverName,
      dbPath: db.dbPath,
      dataDir: DATA_DIR,
      isElectron: Boolean(options.isElectron),
      appVersion,
      migratedFrom: options.migratedFrom ?? null,
      certSummary: options.certSummary ?? null,
      counts: { books, cabinets, borrowers, activeLoans, printQueue, aiQueue },
    });
  });

  // Settings API (filters sensitive keys for regular kiosk users)
  app.get("/api/settings", (req, res) => {
    const admin = isAdminRequest(req);
    const rows = db.all<{ key: string; value: string }>("SELECT key, value FROM settings");
    const publicKeys = new Set(["library_name", "default_loan_days", "theme_preset", "theme_mode", "map_entrance"]);
    const out: Record<string, unknown> = {};
    const hasApiKey = hasConfiguredAiKeys(db);
    for (const r of rows) {
      if (r.key === "ai_api_key" || r.key === "ai_keys_pool") {
        if (!admin) continue;
      }
      if (r.key === "ai_keys_pool") continue;
      if (r.key === "admin_pin") continue;
      if (!admin && !publicKeys.has(r.key)) continue;
      try {
        if (r.value.startsWith("{") || r.value.startsWith("[")) {
          out[r.key] = JSON.parse(r.value);
        } else {
          out[r.key] = r.value;
        }
      } catch {
        out[r.key] = r.value;
      }
    }
    out.has_api_key = hasApiKey;
    res.json(out);
  });

  app.put("/api/settings", requireAdmin, (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "גוף בקשה לא תקין" });
    }
    db.transaction(() => {
      for (const [key, val] of Object.entries(body)) {
        const str = typeof val === "string" ? val : JSON.stringify(val);
        db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, str);
      }
    });
    res.json({ ok: true });
  });

  // Cabinets API (Full CRUD + Batch Layout Save for 2D Editor)
  app.get("/api/cabinets", (_req, res) => {
    const rows = db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM books b WHERE b.cabinet_id = c.id AND b.deleted_at IS NULL) AS books_count
       FROM cabinets c
       WHERE c.deleted_at IS NULL
       ORDER BY c.code ASC`
    );
    res.json(rows);
  });

  app.post("/api/cabinets", requireAdmin, (req, res) => {
    const { code, main_subject = "", shelves_count = 5, x = 60, y = 60, width = 160, height = 64, rotation = 0 } = req.body || {};
    if (!code || !String(code).trim()) {
      return res.status(400).json({ error: "יש להזין קוד ארון" });
    }
    try {
      const now = new Date().toISOString();
      const syncId = newSyncId();
      const info = db.run(
        `INSERT INTO cabinets (code, main_subject, shelves_count, x, y, width, height, rotation, sync_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        String(code).trim(),
        String(main_subject).trim(),
        Math.max(1, Math.min(30, Number(shelves_count) || 5)),
        Number(x) || 60,
        Number(y) || 60,
        Math.max(40, Number(width) || 160),
        Math.max(40, Number(height) || 64),
        Number(rotation) || 0,
        syncId,
        now
      );
      enqueueSyncOutbox(db, "cabinet", syncId, "upsert", { id: info.lastInsertRowid });
      const created = db.get("SELECT * FROM cabinets WHERE id = ?", info.lastInsertRowid);
      res.status(201).json(created);
    } catch (err: any) {
      if (String(err?.message || "").includes("UNIQUE")) {
        return res.status(409).json({ error: "קוד ארון זה כבר קיים במפה" });
      }
      res.status(500).json({ error: err?.message || "שגיאה ביצירת ארון" });
    }
  });

  app.put("/api/cabinets/layout/batch", requireAdmin, (req, res) => {
    const items = Array.isArray(req.body?.cabinets) ? req.body.cabinets : [];
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const c of items) {
        const cabId = Number(c.id);
        db.run(
          `UPDATE cabinets
           SET code = ?, main_subject = ?, shelves_count = ?, x = ?, y = ?, width = ?, height = ?, rotation = ?, updated_at = ?
           WHERE id = ?`,
          String(c.code || "").trim(),
          String(c.main_subject || "").trim(),
          Math.max(1, Math.min(30, Number(c.shelves_count) || 5)),
          Number(c.x) || 0,
          Number(c.y) || 0,
          Math.max(40, Number(c.width) || 140),
          Math.max(40, Number(c.height) || 60),
          Number(c.rotation) || 0,
          now,
          cabId
        );
        const row = db.get<{ sync_id: string }>("SELECT sync_id FROM cabinets WHERE id = ?", cabId);
        if (row?.sync_id) enqueueSyncOutbox(db, "cabinet", row.sync_id, "upsert", { id: cabId });
      }
    });
    res.json({ ok: true });
  });

  app.put("/api/cabinets/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const { code, main_subject = "", shelves_count = 5, x = 60, y = 60, width = 160, height = 64, rotation = 0 } = req.body || {};
    if (!code || !String(code).trim()) {
      return res.status(400).json({ error: "יש להזין קוד ארון" });
    }
    try {
      const now = new Date().toISOString();
      db.run(
        `UPDATE cabinets SET code = ?, main_subject = ?, shelves_count = ?, x = ?, y = ?, width = ?, height = ?, rotation = ?, updated_at = ? WHERE id = ?`,
        String(code).trim(),
        String(main_subject).trim(),
        Math.max(1, Math.min(30, Number(shelves_count) || 5)),
        Number(x) || 0,
        Number(y) || 0,
        Math.max(40, Number(width) || 160),
        Math.max(40, Number(height) || 64),
        Number(rotation) || 0,
        now,
        id
      );
      const updated = db.get<Record<string, unknown>>("SELECT * FROM cabinets WHERE id = ?", id);
      if (updated?.sync_id) enqueueSyncOutbox(db, "cabinet", String(updated.sync_id), "upsert", { id });
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "שגיאה בעדכון ארון" });
    }
  });

  app.delete("/api/cabinets/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const existing = db.get<{ sync_id: string }>("SELECT sync_id FROM cabinets WHERE id = ?", id);
    db.transaction(() => {
      if (existing?.sync_id) {
        enqueueSyncOutbox(db, "cabinet", existing.sync_id, "delete", { id, deleted_at: new Date().toISOString() });
      }
      db.run("DELETE FROM cabinets WHERE id = ?", id);
    });
    res.json({ ok: true });
  });

  // Books API with Smart Offline Torah Search + Optional 768d Semantic Hybrid Blending
  app.get("/api/books", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const semantic = req.query.semantic === "1" || req.query.semantic === "true";
    const statusFilter = typeof req.query.status === "string" ? req.query.status : "all";
    const categoryFilter = typeof req.query.category === "string" ? req.query.category : "all";
    const cabinetFilter = typeof req.query.cabinetId === "string" ? req.query.cabinetId : "all";

    let rows = db.all(
      `SELECT b.*, c.code AS cabinet_code, c.main_subject AS cabinet_subject, c.shelves_count AS cabinet_shelves_count
       FROM books b
       LEFT JOIN cabinets c ON b.cabinet_id = c.id
       WHERE b.deleted_at IS NULL
       ORDER BY b.barcode DESC`
    ) as Array<SearchableBook & Record<string, unknown>>;

    if (statusFilter !== "all") {
      rows = rows.filter((r) => r.status === statusFilter);
    }
    if (categoryFilter !== "all") {
      rows = rows.filter((r) => String(r.category || "") === categoryFilter);
    }
    if (cabinetFilter !== "all") {
      rows = rows.filter((r) => String(r.cabinet_id ?? "") === cabinetFilter);
    }

    const offlineScored = searchBooksOffline(rows, q);

    if (!semantic || q.trim().length < 2) {
      res.setHeader("X-Semantic-Status", "off");
      const out = offlineScored.map(({ book, score, matchHint }) => {
        const { embedding: _dropBlob, ...rest } = book;
        return {
          ...rest,
          tagsList: parseTags(book.tags),
          searchScore: score,
          matchHint,
        };
      });
      return res.json(out);
    }

    const cfg = getAiConfig(db);
    const hasVectors = rows.some((r) => Boolean(r.embedding));
    if (!cfg.hasAnyKey) {
      res.setHeader("X-Semantic-Status", "fallback:no_key");
    } else if (!hasVectors) {
      res.setHeader("X-Semantic-Status", "fallback:no_vectors");
    } else {
      try {
        const qVec = await generateTextEmbedding(db, q.trim());
        const offlineMap = new Map<string, { score: number; matchHint: string }>();
        for (const item of offlineScored) {
          offlineMap.set(item.book.barcode, { score: item.score, matchHint: item.matchHint });
        }

        const hybridResults: Array<{ book: SearchableBook & Record<string, unknown>; score: number; matchHint: string }> = [];
        for (const book of rows) {
          const off = offlineMap.get(book.barcode);
          const vec = blobToFloat32(book.embedding);
          const sim = vec ? cosineSimilarity(qVec, vec) : 0;

          if (off || sim >= 0.45) {
            const semBoost = sim > 0 ? Math.round(sim * 220) : 0;
            const totalScore = (off?.score || 0) + semBoost;
            const pct = Math.max(0, Math.min(99, Math.round(sim * 100)));
            const hint = off?.matchHint
              ? sim >= 0.5
                ? `${off.matchHint} + סמנטי (${pct}%)`
                : off.matchHint
              : `התאמה סמנטית (${pct}%)`;
            hybridResults.push({ book, score: totalScore, matchHint: hint });
          }
        }
        hybridResults.sort((a, b) => b.score - a.score || a.book.title.localeCompare(b.book.title, "he"));
        res.setHeader("X-Semantic-Status", "used");
        const out = hybridResults.map(({ book, score, matchHint }) => {
          const { embedding: _dropBlob, ...rest } = book;
          return {
            ...rest,
            tagsList: parseTags(book.tags),
            searchScore: score,
            matchHint,
          };
        });
        return res.json(out);
      } catch {
        res.setHeader("X-Semantic-Status", "fallback:offline");
      }
    }

    const out = offlineScored.map(({ book, score, matchHint }) => {
      const { embedding: _dropBlob, ...rest } = book;
      return {
        ...rest,
        tagsList: parseTags(book.tags),
        searchScore: score,
        matchHint,
      };
    });
    res.json(out);
  });

  app.post("/api/books", requireAdmin, (req, res) => {
    const {
      title,
      author = "",
      volume = "",
      publisher = "",
      pub_year = "",
      edition = "",
      category = "",
      tags = [],
      cabinet_id = null,
      shelf_number = null,
      notes = "",
      status = "available",
      format_size = "",
      thickness_mm = null,
      pages_count = null,
      barcode_status = "assigned",
      copiesCount = 1,
      barcode: explicitBarcode,
    } = req.body || {};

    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "יש להזין שם ספר" });
    }

    const parsedThickness = thickness_mm !== null && thickness_mm !== "" && Number(thickness_mm) > 0 ? Number(thickness_mm) : null;
    const parsedPages = pages_count !== null && pages_count !== "" && Number(pages_count) > 0 ? Math.round(Number(pages_count)) : null;

    const count = Math.max(1, Math.min(200, Number(copiesCount) || 1));
    const prefix = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'barcode_prefix'")?.value ?? "";
    let nextNum = parseInt(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'next_barcode'")?.value ?? "100001", 10) || 100001;
    const now = new Date().toISOString();
    const tagsArr = parseTags(tags);
    const createdBarcodes: string[] = [];

    db.transaction(() => {
      for (let i = 0; i < count; i++) {
        let code = i === 0 && explicitBarcode ? String(explicitBarcode).trim() : "";
        if (!code) {
          while (db.get("SELECT barcode FROM books WHERE barcode = ?", prefix + String(nextNum))) {
            nextNum++;
          }
          code = prefix + String(nextNum);
          nextNum++;
        }
        const syncId = newSyncId();
        const norm = buildNormalizedBookSearch([code, title, author, volume, publisher, pub_year, edition, category, tagsArr.join(" "), notes]);
        db.run(
          `INSERT INTO books (barcode, title, author, volume, publisher, pub_year, edition, category, tags, normalized_search, cabinet_id, shelf_number, notes, status, label_printed, created_at, format_size, thickness_mm, pages_count, barcode_status, sync_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
          code, title.trim(), String(author).trim(), String(volume).trim(), String(publisher).trim(),
          String(pub_year).trim(), String(edition).trim(),
          String(category).trim(), JSON.stringify(tagsArr), norm, cabinet_id ? Number(cabinet_id) : null,
          shelf_number ? Number(shelf_number) : null, String(notes).trim(), status, now,
          String(format_size || "").trim(), parsedThickness, parsedPages,
          barcode_status === "pending_barcode" ? "pending_barcode" : "assigned",
          syncId, now
        );
        enqueueSyncOutbox(db, "book", syncId, "upsert", { barcode: code });
        createdBarcodes.push(code);
      }
      db.run("INSERT INTO settings (key, value) VALUES ('next_barcode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(nextNum));
    });

    const cfg = getAiConfig(db);
    if (cfg.hasAnyKey && createdBarcodes.length > 0) {
      const embText = buildBookEmbeddingText({ title, author, volume, publisher, pub_year, edition, category, tags: tagsArr, notes });
      void generateTextEmbedding(db, embText)
        .then((vec) => {
          const blob = float32ToBlob(vec);
          for (const bc of createdBarcodes) {
            db.run("UPDATE books SET embedding = ? WHERE barcode = ?", blob, bc);
          }
        })
        .catch(() => {});
    }

    res.status(201).json({ ok: true, barcodes: createdBarcodes, nextBarcode: prefix + String(nextNum) });
  });

  app.put("/api/books/:barcode", requireAdmin, (req, res) => {
    const barcode = req.params.barcode;
    const existing = db.get<Record<string, unknown>>("SELECT * FROM books WHERE barcode = ?", barcode);
    if (!existing) {
      return res.status(404).json({ error: "הספר לא נמצא" });
    }
    const {
      title = existing.title,
      author = existing.author,
      volume = existing.volume,
      publisher = existing.publisher,
      pub_year = existing.pub_year || "",
      edition = existing.edition || "",
      category = existing.category,
      tags,
      cabinet_id = existing.cabinet_id,
      shelf_number = existing.shelf_number,
      notes = existing.notes,
      status = existing.status,
      format_size = existing.format_size || "",
      thickness_mm = existing.thickness_mm ?? null,
      pages_count = existing.pages_count ?? null,
      barcode_status = existing.barcode_status || "assigned",
    } = req.body || {};

    const parsedThickness = thickness_mm !== null && thickness_mm !== "" && Number(thickness_mm) > 0 ? Number(thickness_mm) : null;
    const parsedPages = pages_count !== null && pages_count !== "" && Number(pages_count) > 0 ? Math.round(Number(pages_count)) : null;
    const now = new Date().toISOString();

    const tagsArr = tags !== undefined ? parseTags(tags) : parseTags(existing.tags);
    const norm = buildNormalizedBookSearch([
      barcode,
      String(title),
      String(author),
      String(volume),
      String(publisher),
      String(pub_year),
      String(edition),
      String(category),
      tagsArr.join(" "),
      String(notes),
    ]);

    db.run(
      `UPDATE books
       SET title = ?, author = ?, volume = ?, publisher = ?, pub_year = ?, edition = ?, category = ?, tags = ?, normalized_search = ?, cabinet_id = ?, shelf_number = ?, notes = ?, status = ?, format_size = ?, thickness_mm = ?, pages_count = ?, barcode_status = ?, updated_at = ?
       WHERE barcode = ?`,
      String(title).trim(),
      String(author).trim(),
      String(volume).trim(),
      String(publisher).trim(),
      String(pub_year).trim(),
      String(edition).trim(),
      String(category).trim(),
      JSON.stringify(tagsArr),
      norm,
      cabinet_id ? Number(cabinet_id) : null,
      shelf_number ? Number(shelf_number) : null,
      String(notes).trim(),
      String(status),
      String(format_size || "").trim(),
      parsedThickness,
      parsedPages,
      String(barcode_status || "assigned"),
      now,
      barcode
    );

    if (existing.sync_id) {
      enqueueSyncOutbox(db, "book", String(existing.sync_id), "upsert", { barcode });
    }

    db.run("UPDATE books SET embedding = NULL WHERE barcode = ?", barcode);
    const cfg = getAiConfig(db);
    if (cfg.hasAnyKey) {
      const embText = buildBookEmbeddingText({
        title: String(title),
        author: String(author),
        volume: String(volume),
        publisher: String(publisher),
        pub_year: String(pub_year),
        edition: String(edition),
        category: String(category),
        tags: tagsArr,
        notes: String(notes),
      });
      void generateTextEmbedding(db, embText)
        .then((vec) => {
          db.run("UPDATE books SET embedding = ? WHERE barcode = ?", float32ToBlob(vec), barcode);
        })
        .catch(() => {});
    }

    res.json({ ok: true });
  });

  app.delete("/api/books/:barcode", requireAdmin, (req, res) => {
    const barcode = req.params.barcode;
    const existing = db.get<{ sync_id: string }>("SELECT sync_id FROM books WHERE barcode = ?", barcode);
    db.transaction(() => {
      if (existing?.sync_id) {
        enqueueSyncOutbox(db, "book", existing.sync_id, "delete", { barcode, deleted_at: new Date().toISOString() });
      }
      db.run("DELETE FROM books WHERE barcode = ?", barcode);
    });
    res.json({ ok: true });
  });

  // Stage 3: Circulation, Borrowers & CSV/Excel Import
  registerCirculationRoutes(app, db);

  // Stage 4: Catalog AI Queue, Image Compression & 768d Embeddings
  registerCatalogAiRoutes(app, db, DATA_DIR);

  // Stage 5: A4 Barcode PDF Labels, Backup/Export & Admin PIN Auth
  registerLabelsAndAdminRoutes(app, db, DATA_DIR);

  // Stage 6: Auto-Update & GitHub Sync
  const updaterHooks: UpdaterRestartHooks = {};
  registerUpdaterRoutes(app, db, ROOT_DIR, DATA_DIR, updaterHooks, options.desktopUpdater);

  const distDir = path.join(ROOT_DIR, "dist", "client");
  if (fs.existsSync(path.join(distDir, "index.html")) && process.env.VITE_DEV !== "1") {
    app.use(express.static(distDir));
    app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
  } else if (!options.isElectron || process.env.VITE_DEV === "1") {
    const vitePkgName = "vite";
    const { createServer: createViteServer } = await import(/* @vite-ignore */ vitePkgName);
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
      configFile: path.join(ROOT_DIR, "vite.config.ts"),
    });
    app.use(vite.middlewares);
  } else {
    app.get("*", (_req, res) => {
      res.status(503).send("Client build (dist/client/index.html) not found. Run npm run build first.");
    });
  }

  const preferredPort = options.preferredPort ?? Number(process.env.PORT || 4747);
  const port = await findFreePort(preferredPort);
  const url = `http://127.0.0.1:${port}`;
  const httpServer = await new Promise<ReturnType<Express["listen"]>>((resolve) => {
    const srv = app.listen(port, "127.0.0.1", () => {
      console.log(`OTZAR_SEFARIM_READY ${url} (SQLite driver: ${db.driverName})`);
      resolve(srv);
    });
  });

  const close = () => {
    try {
      updaterHooks.cancelStartupCheck?.();
    } catch {}
    try {
      httpServer.close();
    } catch {}
    try {
      db.close();
    } catch {}
  };

  updaterHooks.closeServer = close;
  scheduleStartupAutoUpdateCheck(db, ROOT_DIR, DATA_DIR, updaterHooks, options.desktopUpdater);

  return { app, port, url, dataDir: DATA_DIR, dbPath: db.dbPath, close };
}

const entryArg = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
const isRunningAsServerCli =
  !process.versions.electron &&
  (process.env.OTZAR_STANDALONE_SERVER === "1" ||
    entryArg.endsWith(`${path.sep}server${path.sep}index.ts`) ||
    entryArg.endsWith(`${path.sep}server${path.sep}index.js`) ||
    entryArg.endsWith(`${path.sep}server${path.sep}index.cjs`));

if (isRunningAsServerCli) {
  startOtzarServer().catch((err) => {
    console.error("Failed to start Otzar Sefarim server:", err);
    process.exit(1);
  });
}
