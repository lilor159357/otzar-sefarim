import type { Express } from "express";
import { requireAdmin } from "../auth/adminAuth.ts";
import { isValidStringKey } from "../../shared/strings/engine.ts";
import type { DesktopStringsStore } from "../strings/stringsStore.ts";
import type { OtzarFirebaseSyncService } from "../sync/firebaseSync.ts";

export function registerStringsRoutes(
  app: Express,
  stringsStore: DesktopStringsStore,
  syncService?: OtzarFirebaseSyncService
) {
  app.get("/api/strings", (_req, res) => {
    const snapshot = stringsStore.getSnapshot(true);
    res.json({
      ok: true,
      cloudConnected: syncService?.isCloudConnected() ?? false,
      ...snapshot,
    });
  });

  app.post("/api/strings/reload", async (_req, res) => {
    try {
      if (syncService?.isCloudConnected()) {
        await syncService.syncUiStrings();
      }
    } catch {}
    const snapshot = stringsStore.reloadFromDisk();
    res.json({
      ok: true,
      cloudConnected: syncService?.isCloudConnected() ?? false,
      ...snapshot,
    });
  });

  app.put("/api/strings/override", requireAdmin, async (req, res) => {
    const { key, value } = (req.body || {}) as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || !isValidStringKey(key)) {
      return res.status(400).json({ ok: false, error: stringsStore.t("errors.invalidStringKey") });
    }
    const result = stringsStore.saveLocalOverride(key, value);
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        reason: result.reason,
        error: result.error,
      });
    }
    const cloudRes = syncService
      ? await syncService.pushUiStringOverride(key, result.record)
      : { synced: false };
    const latestSnapshot = stringsStore.getSnapshot(false);
    res.json({
      ok: true,
      cloudConnected: syncService?.isCloudConnected() ?? false,
      cloudSynced: cloudRes.synced,
      record: result.record,
      ...latestSnapshot,
    });
  });

  app.delete("/api/strings/override/:key", requireAdmin, async (req, res) => {
    const key = String(req.params.key || "").trim();
    if (!isValidStringKey(key)) {
      return res.status(400).json({ ok: false, error: stringsStore.t("errors.invalidStringKey") });
    }
    stringsStore.resetLocalOverride(key);
    const cloudRes = syncService
      ? await syncService.deleteUiStringOverride(key)
      : { synced: false };
    const latestSnapshot = stringsStore.getSnapshot(false);
    res.json({
      ok: true,
      cloudConnected: syncService?.isCloudConnected() ?? false,
      cloudSynced: cloudRes.synced,
      ...latestSnapshot,
    });
  });
}