import express, { type Express } from "express";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { openDatabase, type DbClient } from "./db/adapter.ts";
import { buildNormalizedBookSearch, enqueueSyncOutbox, initSchemaAndSeed, newSyncId } from "./db/schema.ts";
import { searchBooksOffline, type SearchableBook } from "./search/torahSearch.ts";
import { compareSetBooks, getAuthoritySuggestions, readCustomVolumeNotationRules } from "./search/torahAuthority.ts";
import {
  computeMissingSetSlots,
  extractVolumeNumberIndex,
  inferDominantCoverageUnit,
  inferVolumesFromCoverage,
  makeMissingVolumeIgnoreKey,
  normalizeCoverageRange,
  shouldSuppressSingleVolumeLabel,
  type CoverageUnit,
  type CoverageVolumeSuggestion,
} from "../shared/torah/volumeAndCoverage.ts";
import { registerCirculationRoutes } from "./routes/circulation.ts";
import { registerCatalogAiRoutes } from "./routes/catalogAi.ts";
import { registerLabelsAndAdminRoutes } from "./routes/labelsAndAdmin.ts";
import { registerSyncRoutes } from "./routes/sync.ts";
import { registerStringsRoutes } from "./routes/strings.ts";
import { DesktopStringsStore } from "./strings/stringsStore.ts";
import type { StringsTranslateFn } from "../shared/strings/engine.ts";
import type { UpdaterSplashStrings } from "../electron/updaterSplash.ts";
import { OtzarFirebaseSyncService } from "./sync/firebaseSync.ts";
import { loadWindowsRootCertificates } from "../electron/windowsCerts.ts";
import {
  createBackupFile,
  registerUpdaterRoutes,
  scheduleStartupAutoUpdateCheck,
  type DesktopUpdaterBridge,
  type UpdaterRestartHooks,
} from "./routes/updater.ts";
import { saveUiPrefs, type UiPrefsSnapshot } from "./sync/releaseNotes.ts";
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
  t: StringsTranslateFn;
  getSplashStrings: (targetVersion: string) => UpdaterSplashStrings;
  getThemeSnapshot: () => UiPrefsSnapshot;
  prepareAndCloseForUpdate: () => { backupPath: string; themePreset: string; darkMode: boolean };
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
  if (!options.isElectron && process.platform === "win32") {
    loadWindowsRootCertificates(DATA_DIR);
  }

  const dbExistedBeforeOpen = fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0;
  const db = await openDatabase(DB_PATH);
  initSchemaAndSeed(db);

  // Automatic one-time and startup migration: normalize all existing coverage_range strings to ASCII hyphen and quotes
  try {
    const coverageMigrated = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'coverage_normalized_v1025'")?.value;
    if (!coverageMigrated) {
      const booksWithCoverage = db.all<{ barcode: string; set_name: string; sub_series: string; author: string; volume: string; coverage_range: string; publisher: string; pub_year: string; edition: string; category: string; tags: string; notes: string; sync_id: string }>(
        "SELECT barcode, set_name, sub_series, author, volume, coverage_range, publisher, pub_year, edition, category, tags, notes, sync_id FROM books WHERE coverage_range IS NOT NULL AND coverage_range <> '' AND deleted_at IS NULL"
      );
      const nowIso = new Date().toISOString();
      db.transaction(() => {
        for (const b of booksWithCoverage) {
          const cur = String(b.coverage_range || "").trim();
          if (!cur) continue;
          const sName = String(b.set_name || "").trim();
          const prefUnit = sName ? resolvePreferredCoverageUnitForSet(db, sName) : "any";
          const normalized = normalizeCoverageRange(cur, prefUnit);
          if (normalized && normalized !== cur) {
            const tagsArr = parseTags(b.tags);
            const norm = buildNormalizedBookSearch([
              String(b.barcode),
              String(b.set_name || ""),
              String(b.sub_series || ""),
              String(b.author || ""),
              String(b.volume || ""),
              normalized,
              String(b.publisher || ""),
              String(b.pub_year || ""),
              String(b.edition || ""),
              String(b.category || ""),
              tagsArr.join(" "),
              String(b.notes || ""),
            ]);
            db.run(
              "UPDATE books SET coverage_range = ?, normalized_search = ?, updated_at = ? WHERE barcode = ?",
              normalized,
              norm,
              nowIso,
              b.barcode
            );
            if (b.sync_id) {
              enqueueSyncOutbox(db, "book", String(b.sync_id), "upsert", { barcode: String(b.barcode) });
            }
          }
        }
        db.run("INSERT INTO settings (key, value) VALUES ('coverage_normalized_v1025', 'done') ON CONFLICT(key) DO UPDATE SET value = 'done'");
      });
    }
  } catch (err) {
    console.error("Failed running coverage_normalized_v1025 startup migration:", err);
  }

  // Automatic one-time migration: move volume index (חלק א'..ה') to set_global_number for consecutive single-book sub-series sets (e.g. Mikraot Gedolot)
  try {
    const singleSubMigrated = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'single_subseries_global_v1026'")?.value;
    if (!singleSubMigrated) {
      const allSetRows = db.all<{
        barcode: string;
        set_name: string;
        sub_series: string;
        author: string;
        volume: string;
        coverage_range: string;
        set_global_number: number | null;
        publisher: string;
        pub_year: string;
        edition: string;
        category: string;
        tags: string;
        notes: string;
        sync_id: string;
      }>(
        "SELECT barcode, set_name, sub_series, author, volume, coverage_range, set_global_number, publisher, pub_year, edition, category, tags, notes, sync_id FROM books WHERE set_name IS NOT NULL AND set_name <> '' AND deleted_at IS NULL"
      );
      const bySet = new Map<string, typeof allSetRows>();
      for (const row of allSetRows) {
        const key = String(row.set_name || "").trim().toLowerCase();
        if (!key) continue;
        const arr = bySet.get(key) || [];
        arr.push(row);
        bySet.set(key, arr);
      }
      const nowIso = new Date().toISOString();
      db.transaction(() => {
        for (const [, setList] of bySet.entries()) {
          const bySub = new Map<string, typeof allSetRows>();
          for (const b of setList) {
            const sub = String(b.sub_series || "").trim();
            if (!sub) continue;
            const arr = bySub.get(sub) || [];
            arr.push(b);
            bySub.set(sub, arr);
          }
          if (bySub.size < 2 || bySub.size !== setList.length) continue;
          const entries = Array.from(bySub.values()).map((l) => l[0]);
          const allSingleNoCov = entries.every(
            (b) => !String(b.coverage_range || "").trim() && (extractVolumeNumberIndex(b.volume, null) ?? 0) > 0
          );
          if (!allSingleNoCov) continue;
          const indices = entries.map((b) => extractVolumeNumberIndex(b.volume, null)!);
          if (new Set(indices).size !== entries.length) continue;
          const maxIdx = Math.max(...indices);
          if (maxIdx > entries.length + 3) continue;

          for (const b of entries) {
            const idx = extractVolumeNumberIndex(b.volume, null)!;
            const nextGlobal =
              b.set_global_number != null && Number(b.set_global_number) > 0
                ? Number(b.set_global_number)
                : idx;
            const tagsArr = parseTags(b.tags);
            const norm = buildNormalizedBookSearch([
              String(b.barcode),
              String(b.set_name || ""),
              String(b.sub_series || ""),
              String(b.author || ""),
              "",
              String(b.coverage_range || ""),
              String(b.publisher || ""),
              String(b.pub_year || ""),
              String(b.edition || ""),
              String(b.category || ""),
              tagsArr.join(" "),
              String(b.notes || ""),
            ]);
            db.run(
              "UPDATE books SET volume = '', set_global_number = ?, normalized_search = ?, updated_at = ? WHERE barcode = ?",
              nextGlobal,
              norm,
              nowIso,
              b.barcode
            );
            if (b.sync_id) {
              enqueueSyncOutbox(db, "book", String(b.sync_id), "upsert", { barcode: String(b.barcode) });
            }
          }
        }
        db.run("INSERT INTO settings (key, value) VALUES ('single_subseries_global_v1026', 'done') ON CONFLICT(key) DO UPDATE SET value = 'done'");
      });
    }
  } catch (err) {
    console.error("Failed running single_subseries_global_v1026 startup migration:", err);
  }
  if (!dbExistedBeforeOpen) {
    db.run(
      "INSERT OR IGNORE INTO settings (key, value) VALUES ('last_seen_app_version', ?)",
      appVersion
    );
  }

  const getThemeSnapshot = (): UiPrefsSnapshot => {
    const preset = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'theme_preset'")?.value || "default";
    const mode = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'theme_mode'")?.value || "light";
    return { themePreset: preset, darkMode: mode === "dark" };
  };
  saveUiPrefs(DATA_DIR, getThemeSnapshot());

  const stringsStore = new DesktopStringsStore(DATA_DIR);
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  let syncService: OtzarFirebaseSyncService | null = null;
  app.use((req, res, next) => {
    if (req.method !== "GET" && /^\/api\/(books|cabinets|borrowers|loans|labels|ai-queue|ai\/reindex-embeddings|settings)/.test(req.path)) {
      res.on("finish", () => {
        if (res.statusCode < 400) {
          syncService?.notifyLocalMutation();
        }
      });
    }
    next();
  });

  // Health & DB verification
  app.get("/api/health", (_req, res) => {
    const books = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM books WHERE deleted_at IS NULL")?.c ?? 0;
    const cabinets = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM cabinets WHERE deleted_at IS NULL")?.c ?? 0;
    const borrowers = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM borrowers WHERE deleted_at IS NULL")?.c ?? 0;
    const activeLoans = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM loans WHERE return_date IS NULL AND deleted_at IS NULL")?.c ?? 0;
    const printQueue = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM books WHERE label_printed = 0 AND deleted_at IS NULL")?.c ?? 0;
    const aiQueue = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM ai_catalog_queue WHERE approval_status = 'pending' AND deleted_at IS NULL")?.c ?? 0;
    const recycleBooks = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM books WHERE deleted_at IS NOT NULL AND deleted_at != ''")?.c ?? 0;
    const recycleAi = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM ai_catalog_queue WHERE deleted_at IS NOT NULL AND deleted_at != ''")?.c ?? 0;
    res.json({
      ok: true,
      driver: db.driverName,
      dbPath: db.dbPath,
      dataDir: DATA_DIR,
      isElectron: Boolean(options.isElectron),
      appVersion,
      migratedFrom: options.migratedFrom ?? null,
      certSummary: options.certSummary ?? null,
      counts: { books, cabinets, borrowers, activeLoans, printQueue, aiQueue, recycleBin: recycleBooks + recycleAi },
    });
  });

  // Settings API (filters sensitive keys for regular kiosk users)
  app.get("/api/settings", (req, res) => {
    const admin = isAdminRequest(req);
    const rows = db.all<{ key: string; value: string }>("SELECT key, value FROM settings");
    const publicKeys = new Set(["library_name", "default_loan_days", "theme_preset", "theme_mode", "map_entrance", "room_dimensions", "volume_notation_rules", "ignored_missing_volumes"]);
    const out: Record<string, unknown> = {};
    const hasApiKey = hasConfiguredAiKeys(db);
    for (const r of rows) {
      if (r.key === "ai_api_key" || r.key === "ai_keys_pool") {
        if (!admin) continue;
      }
      if (r.key === "ai_keys_pool") continue;
      if (r.key === "admin_pin") continue;
      if (r.key === "firebase_password") continue;
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
    if ("theme_preset" in body || "theme_mode" in body) {
      saveUiPrefs(DATA_DIR, getThemeSnapshot());
    }
    if (["library_name", "default_loan_days", "map_entrance", "room_dimensions", "volume_notation_rules", "ignored_missing_volumes"].some((k) => k in body)) {
      void syncService?.pushLibraryMeta().catch(() => {});
    }
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
    const { code, main_subject = "", shelves_count = 5, x = 60, y = 60, width = 160, height = 64, width_cm = null, depth_cm = null, rotation = 0 } = req.body || {};
    if (!code || !String(code).trim()) {
      return res.status(400).json({ error: "יש להזין קוד ארון" });
    }
    const parsedWidthCm = width_cm != null && width_cm !== "" && Number(width_cm) > 0 ? Number(width_cm) : null;
    const parsedDepthCm = depth_cm != null && depth_cm !== "" && Number(depth_cm) > 0 ? Number(depth_cm) : null;
    try {
      const now = new Date().toISOString();
      const syncId = newSyncId();
      const info = db.run(
        `INSERT INTO cabinets (code, main_subject, shelves_count, x, y, width, height, width_cm, depth_cm, rotation, sync_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        String(code).trim(),
        String(main_subject).trim(),
        Math.max(1, Math.min(30, Number(shelves_count) || 5)),
        Number(x) || 60,
        Number(y) || 60,
        Math.max(40, Number(width) || 160),
        Math.max(40, Number(height) || 64),
        parsedWidthCm,
        parsedDepthCm,
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
        const wCm = c.width_cm != null && c.width_cm !== "" && Number(c.width_cm) > 0 ? Number(c.width_cm) : null;
        const dCm = c.depth_cm != null && c.depth_cm !== "" && Number(c.depth_cm) > 0 ? Number(c.depth_cm) : null;
        db.run(
          `UPDATE cabinets
           SET code = ?, main_subject = ?, shelves_count = ?, x = ?, y = ?, width = ?, height = ?, width_cm = COALESCE(?, width_cm), depth_cm = COALESCE(?, depth_cm), rotation = ?, updated_at = ?
           WHERE id = ?`,
          String(c.code || "").trim(),
          String(c.main_subject || "").trim(),
          Math.max(1, Math.min(30, Number(c.shelves_count) || 5)),
          Number(c.x) || 0,
          Number(c.y) || 0,
          Math.max(40, Number(c.width) || 140),
          Math.max(40, Number(c.height) || 60),
          wCm,
          dCm,
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
    const { code, main_subject = "", shelves_count = 5, x = 60, y = 60, width = 160, height = 64, width_cm, depth_cm, rotation = 0 } = req.body || {};
    if (!code || !String(code).trim()) {
      return res.status(400).json({ error: "יש להזין קוד ארון" });
    }
    const existingCab = db.get<{ width_cm: number | null; depth_cm: number | null }>("SELECT width_cm, depth_cm FROM cabinets WHERE id = ?", id);
    const parsedWidthCm = width_cm !== undefined ? (width_cm != null && width_cm !== "" && Number(width_cm) > 0 ? Number(width_cm) : null) : existingCab?.width_cm ?? null;
    const parsedDepthCm = depth_cm !== undefined ? (depth_cm != null && depth_cm !== "" && Number(depth_cm) > 0 ? Number(depth_cm) : null) : existingCab?.depth_cm ?? null;
    try {
      const now = new Date().toISOString();
      db.run(
        `UPDATE cabinets SET code = ?, main_subject = ?, shelves_count = ?, x = ?, y = ?, width = ?, height = ?, width_cm = ?, depth_cm = ?, rotation = ?, updated_at = ? WHERE id = ?`,
        String(code).trim(),
        String(main_subject).trim(),
        Math.max(1, Math.min(30, Number(shelves_count) || 5)),
        Number(x) || 0,
        Number(y) || 0,
        Math.max(40, Number(width) || 160),
        Math.max(40, Number(height) || 64),
        parsedWidthCm,
        parsedDepthCm,
        Number(rotation) || 0,
        now,
        id
      );
      const updated = db.get<Record<string, unknown>>("SELECT * FROM cabinets WHERE id = ?", id);
      if (updated?.sync_id) enqueueSyncOutbox(db, "cabinet", String(updated.sync_id), "upsert", { id });
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || stringsStore.t("errors.cabinetUpdateFailed") });
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

  app.post("/api/cabinets/:id/duplicate", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const orig = db.get<Record<string, unknown>>("SELECT * FROM cabinets WHERE id = ? AND deleted_at IS NULL", id);
    if (!orig) {
      return res.status(404).json({ error: "הארון לא נמצא" });
    }
    const copyBooks = Boolean(req.body?.copyBooks);
    const baseCode = String(req.body?.code || (String(orig.code || "ארון") + "-העתק")).trim();
    let newCode = baseCode;
    let suffix = 2;
    while (db.get("SELECT id FROM cabinets WHERE code = ?", newCode)) {
      newCode = `${baseCode}-${suffix}`;
      suffix++;
    }

    const now = new Date().toISOString();
    const cabSyncId = newSyncId();
    let newCabId = 0;
    let copiedBooksCount = 0;

    db.transaction(() => {
      const info = db.run(
        `INSERT INTO cabinets (code, main_subject, shelves_count, x, y, width, height, width_cm, depth_cm, rotation, sync_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newCode,
        String(orig.main_subject || ""),
        Math.max(1, Number(orig.shelves_count) || 5),
        (Number(orig.x) || 60) + 32,
        (Number(orig.y) || 60) + 32,
        Math.max(40, Number(orig.width) || 160),
        Math.max(40, Number(orig.height) || 64),
        orig.width_cm != null ? Number(orig.width_cm) : null,
        orig.depth_cm != null ? Number(orig.depth_cm) : null,
        Number(orig.rotation) || 0,
        cabSyncId,
        now
      );
      newCabId = Number(info.lastInsertRowid);
      enqueueSyncOutbox(db, "cabinet", cabSyncId, "upsert", { id: newCabId });

      if (copyBooks) {
        const srcBooks = db.all<Record<string, unknown>>(
          "SELECT * FROM books WHERE cabinet_id = ? AND deleted_at IS NULL ORDER BY shelf_number ASC, barcode ASC",
          id
        );
        if (srcBooks.length > 0) {
          const prefix = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'barcode_prefix'")?.value ?? "";
          let nextNum = parseInt(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'next_barcode'")?.value ?? "100001", 10) || 100001;
          for (const b of srcBooks) {
            while (db.get("SELECT barcode FROM books WHERE barcode = ?", prefix + String(nextNum))) nextNum++;
            const code = prefix + String(nextNum);
            nextNum++;
            const bSyncId = newSyncId();
            const tagsArr = parseTags(b.tags);
            const norm = buildNormalizedBookSearch([
              code,
              String(b.title || ""),
              String(b.set_name || ""),
              String(b.sub_series || ""),
              String(b.author || ""),
              String(b.volume || ""),
              String(b.coverage_range || ""),
              String(b.publisher || ""),
              String(b.pub_year || ""),
              String(b.edition || ""),
              String(b.category || ""),
              tagsArr.join(" "),
              String(b.notes || ""),
            ]);
            db.run(
              `INSERT INTO books (barcode, title, set_name, sub_series, set_global_number, author, volume, coverage_range, publisher, pub_year, edition, category, tags, normalized_search, cabinet_id, shelf_number, notes, status, label_printed, created_at, format_size, thickness_mm, pages_count, barcode_status, sync_id, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 0, ?, ?, ?, ?, 'assigned', ?, ?)`,
              code,
              String(b.title || ""),
              String(b.set_name || ""),
              String(b.sub_series || ""),
              b.set_global_number != null ? Number(b.set_global_number) : null,
              String(b.author || ""),
              String(b.volume || ""),
              String(b.coverage_range || ""),
              String(b.publisher || ""),
              String(b.pub_year || ""),
              String(b.edition || ""),
              String(b.category || ""),
              JSON.stringify(tagsArr),
              norm,
              newCabId,
              b.shelf_number != null ? Number(b.shelf_number) : 1,
              String(b.notes || ""),
              now,
              String(b.format_size || ""),
              b.thickness_mm != null ? Number(b.thickness_mm) : null,
              b.pages_count != null ? Number(b.pages_count) : null,
              bSyncId,
              now
            );
            enqueueSyncOutbox(db, "book", bSyncId, "upsert", { barcode: code });
            copiedBooksCount++;
          }
          db.run("INSERT INTO settings (key, value) VALUES ('next_barcode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(nextNum));
        }
      }
    });

    const created = db.get("SELECT *, (SELECT COUNT(*) FROM books b WHERE b.cabinet_id = cabinets.id AND b.deleted_at IS NULL) AS books_count FROM cabinets WHERE id = ?", newCabId);
    res.status(201).json({ ok: true, cabinet: created, copiedBooksCount });
  });

  app.post("/api/cabinets/:id/shelves/action", requireAdmin, (req, res) => {
    const sourceCabId = Number(req.params.id);
    const sourceCab = db.get<Record<string, unknown>>("SELECT * FROM cabinets WHERE id = ? AND deleted_at IS NULL", sourceCabId);
    if (!sourceCab) {
      return res.status(404).json({ error: "הארון לא נמצא" });
    }
    const action = String(req.body?.action || "").trim();
    const now = new Date().toISOString();

    if (action === "add_shelf") {
      const nextCount = Math.min(30, (Number(sourceCab.shelves_count) || 5) + 1);
      db.run("UPDATE cabinets SET shelves_count = ?, updated_at = ? WHERE id = ?", nextCount, now, sourceCabId);
      if (sourceCab.sync_id) enqueueSyncOutbox(db, "cabinet", String(sourceCab.sync_id), "upsert", { id: sourceCabId });
      return res.json({ ok: true, shelves_count: nextCount });
    }

    const sourceShelf = Math.max(1, Number(req.body?.sourceShelf) || 1);
    const targetCabId = Number(req.body?.targetCabinetId || sourceCabId);
    const targetCab = db.get<Record<string, unknown>>("SELECT * FROM cabinets WHERE id = ? AND deleted_at IS NULL", targetCabId);
    if (!targetCab) {
      return res.status(404).json({ error: "ארון היעד לא נמצא" });
    }
    const targetShelf = Math.max(1, Math.min(Number(targetCab.shelves_count) || 5, Number(req.body?.targetShelf) || 1));
    const filterBarcodes: string[] | null = Array.isArray(req.body?.barcodes)
      ? req.body.barcodes.map((b: unknown) => String(b).trim()).filter(Boolean)
      : null;

    const matchingBooks = db.all<Record<string, unknown>>(
      "SELECT * FROM books WHERE cabinet_id = ? AND shelf_number = ? AND deleted_at IS NULL ORDER BY barcode ASC",
      sourceCabId,
      sourceShelf
    ).filter((b) => !filterBarcodes || filterBarcodes.includes(String(b.barcode)));

    if (action === "move_books") {
      db.transaction(() => {
        for (const b of matchingBooks) {
          db.run("UPDATE books SET cabinet_id = ?, shelf_number = ?, updated_at = ? WHERE barcode = ?", targetCabId, targetShelf, now, String(b.barcode));
          if (b.sync_id) enqueueSyncOutbox(db, "book", String(b.sync_id), "upsert", { barcode: String(b.barcode) });
        }
      });
      return res.json({ ok: true, movedCount: matchingBooks.length });
    }

    if (action === "copy_books") {
      const prefix = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'barcode_prefix'")?.value ?? "";
      let nextNum = parseInt(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'next_barcode'")?.value ?? "100001", 10) || 100001;
      const createdBarcodes: string[] = [];
      db.transaction(() => {
        for (const b of matchingBooks) {
          while (db.get("SELECT barcode FROM books WHERE barcode = ?", prefix + String(nextNum))) nextNum++;
          const code = prefix + String(nextNum);
          nextNum++;
          const bSyncId = newSyncId();
          const tagsArr = parseTags(b.tags);
          const norm = buildNormalizedBookSearch([
            code,
            String(b.title || ""),
            String(b.set_name || ""),
            String(b.sub_series || ""),
            String(b.author || ""),
            String(b.volume || ""),
            String(b.coverage_range || ""),
            String(b.publisher || ""),
            String(b.pub_year || ""),
            String(b.edition || ""),
            String(b.category || ""),
            tagsArr.join(" "),
            String(b.notes || ""),
          ]);
          db.run(
            `INSERT INTO books (barcode, title, set_name, sub_series, set_global_number, author, volume, coverage_range, publisher, pub_year, edition, category, tags, normalized_search, cabinet_id, shelf_number, notes, status, label_printed, created_at, format_size, thickness_mm, pages_count, barcode_status, sync_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 0, ?, ?, ?, ?, 'assigned', ?, ?)`,
            code,
            String(b.title || ""),
            String(b.set_name || ""),
            String(b.sub_series || ""),
            b.set_global_number != null ? Number(b.set_global_number) : null,
            String(b.author || ""),
            String(b.volume || ""),
            String(b.coverage_range || ""),
            String(b.publisher || ""),
            String(b.pub_year || ""),
            String(b.edition || ""),
            String(b.category || ""),
            JSON.stringify(tagsArr),
            norm,
            targetCabId,
            targetShelf,
            String(b.notes || ""),
            now,
            String(b.format_size || ""),
            b.thickness_mm != null ? Number(b.thickness_mm) : null,
            b.pages_count != null ? Number(b.pages_count) : null,
            bSyncId,
            now
          );
          enqueueSyncOutbox(db, "book", bSyncId, "upsert", { barcode: code });
          createdBarcodes.push(code);
        }
        db.run("INSERT INTO settings (key, value) VALUES ('next_barcode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(nextNum));
      });
      return res.status(201).json({ ok: true, copiedCount: createdBarcodes.length, barcodes: createdBarcodes });
    }

    return res.status(400).json({ error: "פעולת מדף לא מוכרת" });
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

function readIgnoredMissingSet(db: DbClient): Set<string> {
    const raw = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'ignored_missing_volumes'")?.value;
    if (!raw) return new Set<string>();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.map((x) => String(x || "").trim()).filter(Boolean));
      }
    } catch {}
    return new Set<string>();
  }

  function writeIgnoredMissingSet(db: DbClient, keys: Set<string>) {
    db.run(
      "INSERT INTO settings (key, value) VALUES ('ignored_missing_volumes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(Array.from(keys))
    );
  }

  function resolvePreferredCoverageUnitForSet(db: DbClient, setName: string): CoverageUnit {
    const clean = String(setName || "").trim();
    if (!clean) return "any";
    const rows = db.all<{ coverage_range: string }>(
      "SELECT coverage_range FROM books WHERE LOWER(set_name) = LOWER(?) AND deleted_at IS NULL AND COALESCE(coverage_range, '') <> ''",
      clean
    );
    return inferDominantCoverageUnit(rows.map((r) => r.coverage_range));
  }

  app.post("/api/books", requireAdmin, (req, res) => {
    const {
      title,
      set_name = "",
      sub_series = "",
      set_global_number = null,
      author = "",
      volume = "",
      coverage_range = "",
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
    const parsedGlobalNum = set_global_number !== null && set_global_number !== "" && Number(set_global_number) > 0 ? Math.round(Number(set_global_number)) : null;

    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: stringsStore.t("errors.bookTitleRequired") });
    }

    const parsedThickness = thickness_mm !== null && thickness_mm !== "" && Number(thickness_mm) > 0 ? Number(thickness_mm) : null;
    const parsedPages = pages_count !== null && pages_count !== "" && Number(pages_count) > 0 ? Math.round(Number(pages_count)) : null;

    const count = Math.max(1, Math.min(200, Number(copiesCount) || 1));
    const prefix = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'barcode_prefix'")?.value ?? "";
    let nextNum = parseInt(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'next_barcode'")?.value ?? "100001", 10) || 100001;
    const cleanSetName = String(set_name || "").trim();
    const cleanSubSeries = String(sub_series || "").trim();
    const preferredCovUnit = cleanSetName ? resolvePreferredCoverageUnitForSet(db, cleanSetName) : "any";
    const normalizedCov = normalizeCoverageRange(String(coverage_range || ""), preferredCovUnit);
    let finalVolume = String(volume || "").trim();
    if (cleanSetName && finalVolume) {
      const sameSetRows = db.all<{ sub_series: string; volume: string; coverage_range: string; title: string }>(
        "SELECT sub_series, volume, coverage_range, title FROM books WHERE LOWER(set_name) = LOWER(?) AND deleted_at IS NULL",
        cleanSetName
      );
      if (shouldSuppressSingleVolumeLabel({ set_name: cleanSetName, sub_series: cleanSubSeries, volume: finalVolume, coverage_range: normalizedCov, title: String(title) }, [...sameSetRows, { sub_series: cleanSubSeries, volume: finalVolume, coverage_range: normalizedCov, title: String(title) }])) {
        finalVolume = "";
      }
    } else if (!cleanSetName && finalVolume && shouldSuppressSingleVolumeLabel({ sub_series: cleanSubSeries, volume: finalVolume, coverage_range: normalizedCov, title: String(title) }, [])) {
      finalVolume = "";
    }
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
        const norm = buildNormalizedBookSearch([code, title, cleanSetName, cleanSubSeries, author, finalVolume, normalizedCov, publisher, pub_year, edition, category, tagsArr.join(" "), notes]);
        db.run(
          `INSERT INTO books (barcode, title, set_name, sub_series, set_global_number, author, volume, coverage_range, publisher, pub_year, edition, category, tags, normalized_search, cabinet_id, shelf_number, notes, status, label_printed, created_at, format_size, thickness_mm, pages_count, barcode_status, sync_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
          code, title.trim(), cleanSetName, cleanSubSeries, parsedGlobalNum, String(author).trim(), finalVolume, normalizedCov, String(publisher).trim(),
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
      const embText = buildBookEmbeddingText({ title, set_name, sub_series, coverage_range, author, volume, publisher, pub_year, edition, category, tags: tagsArr, notes });
      void generateTextEmbedding(db, embText)
        .then((vec) => {
          const blob = float32ToBlob(vec);
          const embNow = new Date().toISOString();
          for (const bc of createdBarcodes) {
            db.run("UPDATE books SET embedding = ?, updated_at = ? WHERE barcode = ?", blob, embNow, bc);
            const row = db.get<{ sync_id: string }>("SELECT sync_id FROM books WHERE barcode = ?", bc);
            if (row?.sync_id) enqueueSyncOutbox(db, "book", row.sync_id, "upsert", { barcode: bc });
          }
          syncService?.notifyLocalMutation();
        })
        .catch(() => {});
    }

    res.status(201).json({ ok: true, barcodes: createdBarcodes, nextBarcode: prefix + String(nextNum) });
  });

  app.put("/api/books/:barcode", requireAdmin, (req, res) => {
    const barcode = req.params.barcode;
    const existing = db.get<Record<string, unknown>>("SELECT * FROM books WHERE barcode = ? AND deleted_at IS NULL", barcode);
    if (!existing) {
      return res.status(404).json({ error: stringsStore.t("errors.bookNotFound") });
    }
    const {
      title = existing.title,
      set_name = existing.set_name || "",
      sub_series = existing.sub_series || "",
      set_global_number = existing.set_global_number ?? null,
      author = existing.author,
      volume = existing.volume,
      coverage_range = existing.coverage_range || "",
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
    const parsedGlobalNum = set_global_number !== null && set_global_number !== "" && Number(set_global_number) > 0 ? Math.round(Number(set_global_number)) : null;
    const cleanSetName = String(set_name || "").trim();
    const cleanSubSeries = String(sub_series || "").trim();
    const preferredCovUnit = cleanSetName ? resolvePreferredCoverageUnitForSet(db, cleanSetName) : "any";
    const normalizedCov = normalizeCoverageRange(String(coverage_range || ""), preferredCovUnit);
    let finalVolume = String(volume || "").trim();
    if (cleanSetName && finalVolume) {
      const sameSetRows = db.all<{ barcode: string; sub_series: string; volume: string; coverage_range: string; title: string }>(
        "SELECT barcode, sub_series, volume, coverage_range, title FROM books WHERE LOWER(set_name) = LOWER(?) AND deleted_at IS NULL AND barcode <> ?",
        cleanSetName,
        barcode
      );
      if (shouldSuppressSingleVolumeLabel({ set_name: cleanSetName, sub_series: cleanSubSeries, volume: finalVolume, coverage_range: normalizedCov, title: String(title) }, [...sameSetRows, { sub_series: cleanSubSeries, volume: finalVolume, coverage_range: normalizedCov, title: String(title) }])) {
        finalVolume = "";
      }
    } else if (!cleanSetName && finalVolume && shouldSuppressSingleVolumeLabel({ sub_series: cleanSubSeries, volume: finalVolume, coverage_range: normalizedCov, title: String(title) }, [])) {
      finalVolume = "";
    }
    const now = new Date().toISOString();

    const tagsArr = tags !== undefined ? parseTags(tags) : parseTags(existing.tags);
    const norm = buildNormalizedBookSearch([
      barcode,
      String(title),
      cleanSetName,
      cleanSubSeries,
      String(author),
      finalVolume,
      normalizedCov,
      String(publisher),
      String(pub_year),
      String(edition),
      String(category),
      tagsArr.join(" "),
      String(notes),
    ]);

    db.run(
      `UPDATE books
       SET title = ?, set_name = ?, sub_series = ?, set_global_number = ?, author = ?, volume = ?, coverage_range = ?, publisher = ?, pub_year = ?, edition = ?, category = ?, tags = ?, normalized_search = ?, cabinet_id = ?, shelf_number = ?, notes = ?, status = ?, format_size = ?, thickness_mm = ?, pages_count = ?, barcode_status = ?, updated_at = ?
       WHERE barcode = ?`,
      String(title).trim(),
      cleanSetName,
      cleanSubSeries,
      parsedGlobalNum,
      String(author).trim(),
      finalVolume,
      normalizedCov,
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
        set_name: cleanSetName,
        sub_series: cleanSubSeries,
        coverage_range: normalizedCov,
        author: String(author),
        volume: finalVolume,
        publisher: String(publisher),
        pub_year: String(pub_year),
        edition: String(edition),
        category: String(category),
        tags: tagsArr,
        notes: String(notes),
      });
      void generateTextEmbedding(db, embText)
        .then((vec) => {
          const embNow = new Date().toISOString();
          db.run("UPDATE books SET embedding = ?, updated_at = ? WHERE barcode = ?", float32ToBlob(vec), embNow, barcode);
          if (existing.sync_id) {
            enqueueSyncOutbox(db, "book", String(existing.sync_id), "upsert", { barcode });
            syncService?.notifyLocalMutation();
          }
        })
        .catch(() => {});
    }

    res.json({ ok: true });
  });

  app.delete("/api/books/:barcode", requireAdmin, (req, res) => {
    const barcode = req.params.barcode;
    const existing = db.get<{ sync_id: string }>("SELECT sync_id FROM books WHERE barcode = ? AND deleted_at IS NULL", barcode);
    if (!existing) return res.status(404).json({ error: stringsStore.t("errors.bookNotFound") });
    const nowIso = new Date().toISOString();
    db.transaction(() => {
      if (existing?.sync_id) {
        enqueueSyncOutbox(db, "book", existing.sync_id, "delete", { barcode, deleted_at: nowIso });
      }
      db.run("UPDATE books SET deleted_at = ?, updated_at = ? WHERE barcode = ?", nowIso, nowIso, barcode);
    });
    res.json({ ok: true, recycled: true });
  });

  // Suggestions API for Authority Autocomplete (author, set_name, publisher, category)
  app.get("/api/catalog/suggestions", (req, res) => {
    const field = String(req.query.field || "author") as "author" | "set_name" | "publisher" | "category";
    const q = String(req.query.q || "");
    const suggestions = getAuthoritySuggestions(db, field, q, 25);
    res.json({ suggestions });
  });

  // Multi-volume series / set query with natural Torah volume sort
  app.get("/api/books/set/:setName", (req, res) => {
    const setName = String(req.params.setName || "").trim();
    if (!setName) return res.json({ books: [] });
    const rows = db.all<Record<string, unknown>>(
      `SELECT b.*, c.code AS cabinet_code, c.main_subject AS cabinet_subject
       FROM books b
       LEFT JOIN cabinets c ON b.cabinet_id = c.id
       WHERE b.set_name = ? AND b.deleted_at IS NULL`,
      setName
    );
    const customRules = readCustomVolumeNotationRules(db);
    rows.sort((a, b) =>
      compareSetBooks(
        {
          sub_series: String(a.sub_series || ""),
          set_global_number: a.set_global_number != null ? Number(a.set_global_number) : null,
          volume: String(a.volume || ""),
          title: String(a.title || ""),
        },
        {
          sub_series: String(b.sub_series || ""),
          set_global_number: b.set_global_number != null ? Number(b.set_global_number) : null,
          volume: String(b.volume || ""),
          title: String(b.title || ""),
        },
        customRules
      )
    );
    const cleanRows = rows.map((r) => {
      const { embedding: _drop, ...rest } = r;
      return { ...rest, tagsList: parseTags(r.tags) };
    });
    const ignoredKeys = readIgnoredMissingSet(db);
    const missingSlots = computeMissingSetSlots(
      cleanRows.map((r: any) => ({
        barcode: String(r.barcode || ""),
        title: String(r.title || ""),
        set_name: String(r.set_name || ""),
        sub_series: String(r.sub_series || ""),
        volume: String(r.volume || ""),
        coverage_range: String(r.coverage_range || ""),
        set_global_number: r.set_global_number != null ? Number(r.set_global_number) : null,
      })),
      setName,
      ignoredKeys
    );
    const dominantCoverageUnit = inferDominantCoverageUnit(cleanRows.map((r: any) => String(r.coverage_range || "")));
    res.json({ books: cleanRows, missingSlots, dominantCoverageUnit, ignoredKeys: Array.from(ignoredKeys) });
  });

  // Canonical details of a set for auto-pull in edit/manual forms
  app.get("/api/books/set-details", (req, res) => {
    const setName = String(req.query.setName || "").trim();
    if (!setName) return res.json({ found: false, details: null });
    const rows = db.all<Record<string, any>>(
      "SELECT * FROM books WHERE LOWER(set_name) = LOWER(?) AND deleted_at IS NULL",
      setName
    );
    if (rows.length === 0) {
      return res.json({ found: false, details: null });
    }
    const nonBorrowed = rows.filter((r) => r.status !== "borrowed");
    const refCount = nonBorrowed.filter((r) => r.status === "reference_only").length;
    const availCount = nonBorrowed.filter((r) => r.status === "available").length;
    const canonicalStatus = refCount > availCount ? "reference_only" : (nonBorrowed[0]?.status || "available");

    const pickFrequent = (key: string): string => {
      const counts = new Map<string, number>();
      for (const r of rows) {
        const val = String(r[key] || "").trim();
        if (val) counts.set(val, (counts.get(val) || 0) + 1);
      }
      let best = "";
      let max = 0;
      for (const [k, c] of counts) {
        if (c > max) { max = c; best = k; }
      }
      return best;
    };

    const author = pickFrequent("author");
    const publisher = pickFrequent("publisher");
    const pub_year = pickFrequent("pub_year");
    const edition = pickFrequent("edition");
    const category = pickFrequent("category");
    const format_size = pickFrequent("format_size");

    const allTags = new Set<string>();
    for (const r of rows) {
      for (const t of parseTags(r.tags)) allTags.add(t);
    }

    const latestBook = rows[rows.length - 1];
    const dominantCoverageUnit = inferDominantCoverageUnit(rows.map((r) => String(r.coverage_range || "")));
    const sampleBooks = rows.slice(0, 15).map((r) => ({
      title: String(r.title || ""),
      set_name: String(r.set_name || ""),
      sub_series: String(r.sub_series || ""),
      volume: String(r.volume || ""),
      coverage_range: String(r.coverage_range || ""),
    }));

    res.json({
      found: true,
      details: {
        set_name: setName,
        count: rows.length,
        status: canonicalStatus,
        author,
        publisher,
        pub_year,
        edition,
        category,
        format_size,
        tags: Array.from(allTags),
        cabinet_id: latestBook.cabinet_id ? Number(latestBook.cabinet_id) : null,
        shelf_number: latestBook.shelf_number ? Number(latestBook.shelf_number) : null,
        dominantCoverageUnit,
        sampleBooks,
      },
    });
  });

  // Summary of sets with active (non-ignored) missing volume slots + coverage-inferred volume suggestions
  app.get("/api/books/missing-sets-summary", (req, res) => {
    const setNames = db.all<{ set_name: string }>(
      "SELECT DISTINCT set_name FROM books WHERE set_name IS NOT NULL AND set_name <> '' AND deleted_at IS NULL"
    ).map((r) => r.set_name.trim()).filter(Boolean);

    const ignoredKeys = readIgnoredMissingSet(db);
    const missingSets: Array<{
      setName: string;
      count: number;
      missingCount: number;
      slots: any[];
    }> = [];
    const volumeSuggestions: CoverageVolumeSuggestion[] = [];

    for (const sName of setNames) {
      const setBooks = db.all<{
        barcode: string;
        title: string;
        set_name: string;
        sub_series: string;
        volume: string;
        coverage_range: string;
        set_global_number: number | null;
      }>(
        "SELECT barcode, title, set_name, sub_series, volume, coverage_range, set_global_number FROM books WHERE LOWER(set_name) = LOWER(?) AND deleted_at IS NULL",
        sName
      );
      const slots = computeMissingSetSlots(setBooks, sName, ignoredKeys);
      const activeSlots = slots.filter((s) => !s.ignored);
      if (activeSlots.length > 0) {
        missingSets.push({
          setName: sName,
          count: setBooks.length,
          missingCount: activeSlots.length,
          slots: activeSlots,
        });
      }
      const inferred = inferVolumesFromCoverage(setBooks, sName);
      if (inferred.length > 0) {
        volumeSuggestions.push(...inferred);
      }
    }

    res.json({ missingSets, volumeSuggestions });
  });

  // Apply coverage-inferred volume labels across multiple books in one transaction
  app.post("/api/books/apply-volume-suggestions", requireAdmin, (req, res) => {
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const cleanItems: Array<{ barcode: string; volume: string }> = [];
    const seenBarcodes = new Set<string>();
    for (const item of rawItems) {
      const bc = String(item?.barcode || "").trim();
      const vol = String(item?.volume || "").trim();
      if (!bc || !vol || seenBarcodes.has(bc)) continue;
      seenBarcodes.add(bc);
      cleanItems.push({ barcode: bc, volume: vol });
    }
    if (cleanItems.length === 0) {
      return res.status(400).json({ error: "לא סופקו ספרים להשלמת חלקים" });
    }

    const now = new Date().toISOString();
    let updatedCount = 0;

    db.transaction(() => {
      for (const item of cleanItems) {
        const existing = db.get<Record<string, any>>(
          "SELECT * FROM books WHERE barcode = ? AND deleted_at IS NULL",
          item.barcode
        );
        if (!existing) continue;
        const curVol = String(existing.volume || "").trim();
        if (curVol === item.volume) continue;

        const tagsArr = parseTags(existing.tags);
        const norm = buildNormalizedBookSearch([
          item.barcode,
          String(existing.title || ""),
          String(existing.set_name || ""),
          String(existing.sub_series || ""),
          String(existing.author || ""),
          item.volume,
          String(existing.coverage_range || ""),
          String(existing.publisher || ""),
          String(existing.pub_year || ""),
          String(existing.edition || ""),
          String(existing.category || ""),
          tagsArr.join(" "),
          String(existing.notes || ""),
        ]);

        db.run(
          "UPDATE books SET volume = ?, normalized_search = ?, updated_at = ? WHERE barcode = ?",
          item.volume,
          norm,
          now,
          item.barcode
        );
        if (existing.sync_id) {
          enqueueSyncOutbox(db, "book", String(existing.sync_id), "upsert", { barcode: item.barcode });
        }
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      syncService?.notifyLocalMutation();
    }
    res.json({ ok: true, updatedCount });
  });

  // Selective multi-book bulk update (only modifies fields explicitly present in req.body.fields)
  app.post("/api/books/bulk-update", requireAdmin, (req, res) => {
    const rawBarcodes = Array.isArray(req.body?.barcodes) ? req.body.barcodes : [];
    const barcodes: string[] = Array.from(new Set<string>(rawBarcodes.map((b: unknown) => String(b || "").trim()).filter(Boolean)));
    const fields = req.body?.fields && typeof req.body.fields === "object" ? (req.body.fields as Record<string, any>) : {};
    const tagsMode = req.body?.tagsMode === "replace" ? "replace" : "merge";

    if (barcodes.length === 0) {
      return res.status(400).json({ error: "לא נבחרו ספרים לעדכון" });
    }
    const fieldKeys = Object.keys(fields);
    if (fieldKeys.length === 0) {
      return res.status(400).json({ error: "לא סומן אף שדה לעדכון" });
    }

    const now = new Date().toISOString();
    let updatedCount = 0;

    db.transaction(() => {
      for (const bc of barcodes) {
        const existing = db.get<Record<string, any>>("SELECT * FROM books WHERE barcode = ? AND deleted_at IS NULL", bc);
        if (!existing) continue;

        const nextTitle = "title" in fields ? String(fields.title ?? "").trim() : String(existing.title || "");
        const nextSetName = "set_name" in fields ? String(fields.set_name ?? "").trim() : String(existing.set_name || "");
        const nextSubSeries = "sub_series" in fields ? String(fields.sub_series ?? "").trim() : String(existing.sub_series || "");
        const nextGlobalNum =
          "set_global_number" in fields
            ? (fields.set_global_number !== null && fields.set_global_number !== "" && Number(fields.set_global_number) > 0
                ? Math.round(Number(fields.set_global_number))
                : null)
            : (existing.set_global_number != null ? Number(existing.set_global_number) : null);
        const nextAuthor = "author" in fields ? String(fields.author ?? "").trim() : String(existing.author || "");
        let nextVolume = "volume" in fields ? String(fields.volume ?? "").trim() : String(existing.volume || "");
        const prefUnit = nextSetName ? resolvePreferredCoverageUnitForSet(db, nextSetName) : "any";
        const nextCoverage =
          "coverage_range" in fields
            ? normalizeCoverageRange(String(fields.coverage_range ?? "").trim(), prefUnit)
            : String(existing.coverage_range || "");
        const nextPublisher = "publisher" in fields ? String(fields.publisher ?? "").trim() : String(existing.publisher || "");
        const nextPubYear = "pub_year" in fields ? String(fields.pub_year ?? "").trim() : String(existing.pub_year || "");
        const nextEdition = "edition" in fields ? String(fields.edition ?? "").trim() : String(existing.edition || "");
        const nextCategory = "category" in fields ? String(fields.category ?? "").trim() : String(existing.category || "");
        const nextFormatSize = "format_size" in fields ? String(fields.format_size ?? "").trim() : String(existing.format_size || "");
        const nextThickness =
          "thickness_mm" in fields
            ? (fields.thickness_mm !== null && fields.thickness_mm !== "" && Number(fields.thickness_mm) > 0 ? Number(fields.thickness_mm) : null)
            : (existing.thickness_mm != null ? Number(existing.thickness_mm) : null);
        const nextPages =
          "pages_count" in fields
            ? (fields.pages_count !== null && fields.pages_count !== "" && Number(fields.pages_count) > 0 ? Math.round(Number(fields.pages_count)) : null)
            : (existing.pages_count != null ? Number(existing.pages_count) : null);
        const nextNotes = "notes" in fields ? String(fields.notes ?? "").trim() : String(existing.notes || "");
        const nextCabinetId =
          "cabinet_id" in fields
            ? (fields.cabinet_id !== null && fields.cabinet_id !== "" && Number(fields.cabinet_id) > 0 ? Number(fields.cabinet_id) : null)
            : (existing.cabinet_id != null ? Number(existing.cabinet_id) : null);
        const nextShelfNumber =
          "shelf_number" in fields
            ? (fields.shelf_number !== null && fields.shelf_number !== "" && Number(fields.shelf_number) > 0 ? Math.round(Number(fields.shelf_number)) : null)
            : (existing.shelf_number != null ? Number(existing.shelf_number) : null);

        // Protect books currently borrowed from bulk status override
        let nextStatus = String(existing.status || "available");
        if ("status" in fields && nextStatus !== "borrowed") {
          const st = String(fields.status || "").trim();
          if (["available", "borrowed", "reference_only", "lost"].includes(st)) {
            nextStatus = st;
          }
        }

        const curTags = parseTags(existing.tags);
        let nextTags = curTags;
        if ("tags" in fields) {
          const incTags = parseTags(fields.tags);
          nextTags = tagsMode === "replace" ? incTags : Array.from(new Set([...curTags, ...incTags])).filter(Boolean);
        }

        const norm = buildNormalizedBookSearch([
          bc,
          nextTitle,
          nextSetName,
          nextSubSeries,
          nextAuthor,
          nextVolume,
          nextCoverage,
          nextPublisher,
          nextPubYear,
          nextEdition,
          nextCategory,
          nextTags.join(" "),
          nextNotes,
        ]);

        db.run(
          `UPDATE books
           SET title = ?, set_name = ?, sub_series = ?, set_global_number = ?, author = ?, volume = ?, coverage_range = ?, publisher = ?, pub_year = ?, edition = ?, category = ?, tags = ?, normalized_search = ?, cabinet_id = ?, shelf_number = ?, notes = ?, status = ?, format_size = ?, thickness_mm = ?, pages_count = ?, updated_at = ?
           WHERE barcode = ?`,
          nextTitle || String(existing.title || ""),
          nextSetName,
          nextSubSeries,
          nextGlobalNum,
          nextAuthor,
          nextVolume,
          nextCoverage,
          nextPublisher,
          nextPubYear,
          nextEdition,
          nextCategory,
          JSON.stringify(nextTags),
          norm,
          nextCabinetId,
          nextShelfNumber,
          nextNotes,
          nextStatus,
          nextFormatSize,
          nextThickness,
          nextPages,
          now,
          bc
        );
        if (existing.sync_id) {
          enqueueSyncOutbox(db, "book", String(existing.sync_id), "upsert", { barcode: bc });
        }
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      syncService?.notifyLocalMutation();
    }
    res.json({ ok: true, updatedCount });
  });

  // Ignore / unignore a virtual missing volume slot
  app.post("/api/books/ignore-missing-volume", requireAdmin, (req, res) => {
    const rawKey = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    const setName = String(req.body?.setName || "").trim();
    const subSeries = String(req.body?.subSeries || "").trim();
    const slotType = req.body?.slotType === "global" ? "global" : "volume";
    const index = Number(req.body?.index || 0);
    const ignore = req.body?.ignore !== false;

    const key = rawKey || (setName && index > 0 ? makeMissingVolumeIgnoreKey(setName, subSeries, slotType, Math.round(index)) : "");
    if (!key) {
      return res.status(400).json({ error: "מזהה חסר לעדכון" });
    }
    const curSet = readIgnoredMissingSet(db);
    if (ignore) {
      curSet.add(key);
    } else {
      curSet.delete(key);
    }
    writeIgnoredMissingSet(db, curSet);
    void syncService?.pushLibraryMeta().catch(() => {});
    res.json({ ok: true, ignoredKeys: Array.from(curSet) });
  });

  // Normalize all coverage_range values across an entire set to uniform format
  app.post("/api/books/normalize-set-coverage", requireAdmin, (req, res) => {
    const setName = String(req.body?.setName || "").trim();
    const explicitUnit = String(req.body?.targetUnit || "").trim() as CoverageUnit | "";
    if (!setName) {
      return res.status(400).json({ error: "נדרש שם סט" });
    }
    const rows = db.all<Record<string, any>>(
      "SELECT * FROM books WHERE LOWER(set_name) = LOWER(?) AND deleted_at IS NULL",
      setName
    );
    const dominantUnit: CoverageUnit =
      explicitUnit && ["siman", "daf", "perek", "amud"].includes(explicitUnit)
        ? explicitUnit
        : inferDominantCoverageUnit(rows.map((r) => String(r.coverage_range || "")));

    const now = new Date().toISOString();
    let updatedCount = 0;

    db.transaction(() => {
      for (const b of rows) {
        const curCov = String(b.coverage_range || "").trim();
        if (!curCov) continue;
        const normalized = normalizeCoverageRange(curCov, dominantUnit);
        if (normalized && normalized !== curCov) {
          const tagsArr = parseTags(b.tags);
          const norm = buildNormalizedBookSearch([
            String(b.barcode),
            String(b.title || ""),
            String(b.set_name || ""),
            String(b.sub_series || ""),
            String(b.author || ""),
            String(b.volume || ""),
            normalized,
            String(b.publisher || ""),
            String(b.pub_year || ""),
            String(b.edition || ""),
            String(b.category || ""),
            tagsArr.join(" "),
            String(b.notes || ""),
          ]);
          db.run(
            "UPDATE books SET coverage_range = ?, normalized_search = ?, updated_at = ? WHERE barcode = ?",
            normalized,
            norm,
            now,
            b.barcode
          );
          if (b.sync_id) {
            enqueueSyncOutbox(db, "book", String(b.sync_id), "upsert", { barcode: String(b.barcode) });
          }
          updatedCount++;
        }
      }
    });

    if (updatedCount > 0) {
      syncService?.notifyLocalMutation();
    }
    res.json({ ok: true, updatedCount, dominantUnit });
  });

  // Clean spurious volume labels from single-volume units without coverage_range across a set
  app.post("/api/books/clean-set-single-volumes", requireAdmin, (req, res) => {
    const setName = String(req.body?.setName || "").trim();
    if (!setName) {
      return res.status(400).json({ error: "נדרש שם סט" });
    }
    const rows = db.all<Record<string, any>>(
      "SELECT * FROM books WHERE LOWER(set_name) = LOWER(?) AND deleted_at IS NULL",
      setName
    );
    const now = new Date().toISOString();
    let updatedCount = 0;

    db.transaction(() => {
      for (const b of rows) {
        if (!String(b.volume || "").trim()) continue;
        if (!shouldSuppressSingleVolumeLabel(
          {
            set_name: String(b.set_name || ""),
            sub_series: String(b.sub_series || ""),
            volume: String(b.volume || ""),
            coverage_range: String(b.coverage_range || ""),
            title: String(b.title || ""),
          },
          rows.map((r) => ({
            sub_series: String(r.sub_series || ""),
            volume: String(r.volume || ""),
            coverage_range: String(r.coverage_range || ""),
            title: String(r.title || ""),
          }))
        )) {
          continue;
        }
        const tagsArr = parseTags(b.tags);
        const norm = buildNormalizedBookSearch([
          String(b.barcode),
          String(b.title || ""),
          String(b.set_name || ""),
          String(b.sub_series || ""),
          String(b.author || ""),
          "",
          String(b.coverage_range || ""),
          String(b.publisher || ""),
          String(b.pub_year || ""),
          String(b.edition || ""),
          String(b.category || ""),
          tagsArr.join(" "),
          String(b.notes || ""),
        ]);
        db.run(
          "UPDATE books SET volume = '', normalized_search = ?, updated_at = ? WHERE barcode = ?",
          norm,
          now,
          b.barcode
        );
        if (b.sync_id) {
          enqueueSyncOutbox(db, "book", String(b.sync_id), "upsert", { barcode: String(b.barcode) });
        }
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      syncService?.notifyLocalMutation();
    }
    res.json({ ok: true, updatedCount });
  });

  // Stage 3: Circulation, Borrowers & CSV/Excel Import
  registerCirculationRoutes(app, db, stringsStore.t);

  // Stage 4: Catalog AI Queue, Image Compression & 768d Embeddings
  const aiHooks = registerCatalogAiRoutes(app, db, DATA_DIR, () => syncService?.notifyLocalMutation(), stringsStore.t);

  // Stage 5: A4 Barcode PDF Labels, Backup/Export & Admin PIN Auth
  registerLabelsAndAdminRoutes(app, db, DATA_DIR, stringsStore.t);

  // Stage 6: Auto-Update & GitHub Sync
  const updaterHooks: UpdaterRestartHooks = {};
  registerUpdaterRoutes(app, db, ROOT_DIR, DATA_DIR, updaterHooks, options.desktopUpdater, appVersion, stringsStore.t);

  // Stage 7: Bidirectional Firebase Firestore Delta Sync & Mobile Relay Listener
  syncService = new OtzarFirebaseSyncService(db, DATA_DIR, () => aiHooks.triggerQueueProcessing(), stringsStore);
  registerSyncRoutes(app, db, syncService, stringsStore.t);

  // Central Strings & Hot Overrides API
  registerStringsRoutes(app, stringsStore, syncService);
  void syncService.connect().catch(() => {});

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

  let serverClosed = false;

  const close = () => {
    if (serverClosed) return;
    serverClosed = true;
    try {
      updaterHooks.cancelStartupCheck?.();
    } catch {}
    try {
      void syncService?.stop();
    } catch {}
    try {
      (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      httpServer.close();
    } catch {}
    try {
      db.checkpoint();
    } catch {}
    try {
      db.close();
    } catch {}
  };

  const prepareAndCloseForUpdate = () => {
    const themeSnap = getThemeSnapshot();
    saveUiPrefs(DATA_DIR, themeSnap);
    if (serverClosed) {
      return { backupPath: "", ...themeSnap };
    }
    try {
      updaterHooks.cancelStartupCheck?.();
    } catch {}
    try {
      void syncService?.stop();
    } catch {}
    // 1. Synchronous WAL Checkpoint before backup
    db.checkpoint();
    // 2. Synchronous pre-update backup
    const backupPath = createBackupFile(db, DATA_DIR, "pre-update");
    if (!backupPath || !fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
      throw new Error(stringsStore.t("errors.backupFailed"));
    }
    // 3. Full synchronous teardown of Express & SQLite locks
    serverClosed = true;
    try {
      (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      httpServer.close();
    } catch {}
    db.close();
    return { backupPath, ...themeSnap };
  };

  updaterHooks.closeServer = close;
  scheduleStartupAutoUpdateCheck(db, ROOT_DIR, DATA_DIR, updaterHooks, options.desktopUpdater);

  const getSplashStrings = (targetVersion: string): UpdaterSplashStrings => {
    const cleanVer = (targetVersion || "").replace(/^v/i, "").trim();
    return {
      windowTitle: stringsStore.t("updater.splashWindowTitle"),
      brandLine: stringsStore.t("updater.splashBrandLine"),
      headline: cleanVer
        ? stringsStore.t("updater.splashHeadline", { version: cleanVer })
        : stringsStore.t("updater.splashHeadlineFallback"),
      extractingMessage: stringsStore.t("updater.splashExtractingMessage"),
      footerSafety: stringsStore.t("updater.splashFooterSafety"),
    };
  };

  return {
    app,
    port,
    url,
    dataDir: DATA_DIR,
    dbPath: db.dbPath,
    t: stringsStore.t,
    getSplashStrings,
    getThemeSnapshot,
    prepareAndCloseForUpdate,
    close,
  };
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
