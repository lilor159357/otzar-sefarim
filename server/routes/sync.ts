import type { Express } from "express";
import type { DbClient } from "../db/adapter.ts";
import { isAdminRequest, requireAdmin } from "../auth/adminAuth.ts";
import { buildNormalizedBookSearch, enqueueSyncOutbox, newSyncId } from "../db/schema.ts";
import { FIRESTORE_RULES_TEMPLATE, type OtzarFirebaseSyncService } from "../sync/firebaseSync.ts";
import { fallbackT, type StringsTranslateFn } from "../../shared/strings/engine.ts";
import {
  cleanStartCatalogReset,
  exportEncryptedSetupBundle,
  exportMobilePairingQr,
  getSetupBundleSummary,
  importEncryptedSetupBundle,
} from "../sync/setupBundle.ts";

function parseTagsSafe(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p.map((t) => String(t).trim()).filter(Boolean);
    } catch {}
    return raw.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

export function registerSyncRoutes(app: Express, db: DbClient, syncService: OtzarFirebaseSyncService, t: StringsTranslateFn = fallbackT) {
  app.get("/api/sync/status", (req, res) => {
    const status = syncService.getStatus();
    if (!isAdminRequest(req)) {
      return res.json({
        enabled: status.enabled,
        connected: status.connected,
        offline: status.offline,
        syncing: status.syncing,
      });
    }
    const pubCfg = syncService.getPublicConfig();
    res.json({
      ...status,
      config: pubCfg.config,
      hasPassword: pubCfg.hasPassword,
    });
  });

  app.get("/api/sync/rules", requireAdmin, (_req, res) => {
    res.json({ rulesText: FIRESTORE_RULES_TEMPLATE });
  });

  app.post("/api/sync/config", requireAdmin, async (req, res) => {
    try {
      const {
        enabled = true,
        syncEmbeddings = true,
        configInput,
        email = "",
        password,
        createUserIfMissing = false,
        clearDemoData = true,
      } = req.body || {};
      const result = await syncService.testAndSaveConfig({
        enabled: Boolean(enabled),
        syncEmbeddings: Boolean(syncEmbeddings),
        configInput,
        email: String(email || ""),
        password: typeof password === "string" ? password : undefined,
        createUserIfMissing: Boolean(createUserIfMissing),
        clearDemoData: Boolean(clearDemoData),
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || t("errors.firebaseValidateFailed") });
    }
  });

  app.post("/api/sync/toggle", requireAdmin, async (req, res) => {
    try {
      const enabled = Boolean(req.body?.enabled);
      const syncEmbeddings = req.body?.syncEmbeddings !== undefined ? Boolean(req.body.syncEmbeddings) : undefined;
      const status = await syncService.setEnabled(enabled, syncEmbeddings);
      res.json({ ok: true, status });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || t("errors.syncToggleFailed") });
    }
  });

  app.post("/api/sync/run", requireAdmin, async (_req, res) => {
    try {
      const result = await syncService.syncNow();
      res.json({ ok: true, ...result, status: syncService.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || t("errors.syncRunFailed"), status: syncService.getStatus() });
    }
  });

  app.post("/api/sync/seed", requireAdmin, async (_req, res) => {
    try {
      const result = await syncService.seedAllToCloud();
      res.json({ ok: true, ...result, status: syncService.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || t("errors.syncInitialPushFailed"), status: syncService.getStatus() });
    }
  });

  app.post("/api/sync/test-relay", requireAdmin, async (_req, res) => {
    try {
      const result = await syncService.runRelayTest();
      res.json({ ...result, status: syncService.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || t("errors.syncQueueCheckFailed"), status: syncService.getStatus() });
    }
  });

  // Assign official sequential barcode to a mobile-created book (barcode_status = 'pending_barcode')
  app.post("/api/books/:barcode/assign-official-barcode", requireAdmin, (req, res) => {
    const oldBarcode = String(req.params.barcode || "").trim();
    const book = db.get<Record<string, unknown>>("SELECT * FROM books WHERE barcode = ? AND deleted_at IS NULL", oldBarcode);
    if (!book) {
      return res.status(404).json({ error: t("errors.bookNotFound") });
    }

    const prefix = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'barcode_prefix'")?.value ?? "";
    let nextNum = parseInt(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'next_barcode'")?.value ?? "100001", 10) || 100001;
    let newBarcode = "";
    const nowIso = new Date().toISOString();
    const syncId = String(book.sync_id || "") || newSyncId();

    db.transaction(() => {
      db.exec("PRAGMA defer_foreign_keys = ON;");
      while (db.get("SELECT barcode FROM books WHERE barcode = ?", prefix + String(nextNum))) {
        nextNum++;
      }
      newBarcode = prefix + String(nextNum);
      nextNum++;

      const tagsArr = parseTagsSafe(book.tags);
      const norm = buildNormalizedBookSearch([
        newBarcode,
        String(book.title || ""),
        String(book.set_name || ""),
        String(book.sub_series || ""),
        String(book.author || ""),
        String(book.volume || ""),
        String(book.coverage_range || ""),
        String(book.publisher || ""),
        String(book.pub_year || ""),
        String(book.edition || ""),
        String(book.category || ""),
        tagsArr.join(" "),
        String(book.notes || ""),
      ]);

      db.run(
        `UPDATE books
         SET barcode = ?, normalized_search = ?, barcode_status = 'assigned', label_printed = 0, sync_id = ?, updated_at = ?
         WHERE barcode = ?`,
        newBarcode,
        norm,
        syncId,
        nowIso,
        oldBarcode
      );
      db.run("UPDATE loans SET book_barcode = ?, updated_at = ? WHERE book_barcode = ?", newBarcode, nowIso, oldBarcode);
      db.run("INSERT INTO settings (key, value) VALUES ('next_barcode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(nextNum));
      enqueueSyncOutbox(db, "book", syncId, "upsert", { barcode: newBarcode });
    });

    syncService.notifyLocalMutation();
    res.json({
      ok: true,
      oldBarcode,
      newBarcode,
      nextBarcode: prefix + String(nextNum),
    });
  });

  app.get("/api/sync/setup-bundle/summary", requireAdmin, (_req, res) => {
    res.json(getSetupBundleSummary(db));
  });

  app.post("/api/sync/mobile-qr", requireAdmin, async (_req, res) => {
    try {
      const result = await exportMobilePairingQr(db);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || t("errors.qrCreateFailed") });
    }
  });

  app.post("/api/sync/setup-bundle/export", requireAdmin, (req, res) => {
    try {
      const passcode = String(req.body?.passcode || "");
      const result = exportEncryptedSetupBundle(db, passcode);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || t("errors.transferExportFailed") });
    }
  });

  app.post("/api/sync/setup-bundle/import", requireAdmin, async (req, res) => {
    try {
      const { bundleInput, passcode, clearDemoData = true } = req.body || {};
      const result = await importEncryptedSetupBundle({
        db,
        syncService,
        dataDir: syncService.getDataDir(),
        bundleInput,
        passcode: String(passcode || ""),
        clearDemoData: Boolean(clearDemoData),
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || t("errors.transferImportFailed") });
    }
  });

  app.post("/api/sync/cleanup-demo", requireAdmin, async (_req, res) => {
    try {
      const result = await syncService.cleanupDemoAndDuplicates();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || t("errors.demoCleanFailed") });
    }
  });

  app.get("/api/sync/ai-keys-backup/status", requireAdmin, async (_req, res) => {
    try {
      const result = await syncService.getAiKeysBackupStatus();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || t("errors.aiBackupCheckFailed") });
    }
  });

  app.post("/api/sync/ai-keys-backup", requireAdmin, async (req, res) => {
    try {
      const passcode = String(req.body?.passcode || "");
      const result = await syncService.backupAiKeysToCloud(passcode);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || t("errors.aiBackupUploadFailed") });
    }
  });

  app.post("/api/sync/ai-keys-restore", requireAdmin, async (req, res) => {
    try {
      const passcode = String(req.body?.passcode || "");
      const result = await syncService.restoreAiKeysFromCloud(passcode);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || t("errors.aiBackupRestoreFailed") });
    }
  });

  app.post("/api/sync/clean-start", requireAdmin, async (req, res) => {
    try {
      const confirmText = String(req.body?.confirmText || "");
      const result = await cleanStartCatalogReset({
        db,
        syncService,
        dataDir: syncService.getDataDir(),
        confirmText,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || t("errors.resetLibraryFailed") });
    }
  });
}