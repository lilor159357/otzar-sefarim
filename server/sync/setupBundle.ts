import crypto from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import bwipjs from "bwip-js";
import type { DbClient } from "../db/adapter.ts";
import { enqueueSyncOutbox } from "../db/schema.ts";
import { reconcileNextBarcodeFromBooks, type OtzarFirebaseSyncService } from "./firebaseSync.ts";

export const TRANSFER_SETTINGS_KEYS = [
  "firebase_config",
  "firebase_email",
  "firebase_password",
  "firebase_enabled",
  "firebase_sync_embeddings",
  "ai_api_key",
  "ai_keys_pool",
  "ai_model",
  "ai_auto_fallback",
  "embedding_model",
  "ai_delay_ms",
  "library_name",
  "admin_pin",
  "default_loan_days",
  "barcode_prefix",
  "next_barcode",
  "label_config",
  "a4_template",
  "theme_mode",
  "theme_preset",
  "map_entrance",
  "update_remote_url",
  "github_release_token",
  "auto_update_check",
  "auto_update_install",
] as const;

export interface OtzarSetupBundleEnvelope {
  format: "otzar-sefarim-setup";
  version: 1;
  kdf: "pbkdf2-sha256";
  iterations: number;
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  exportedAt: string;
  libraryNameHint: string;
  projectIdHint: string;
}

export interface OtzarSetupPayload {
  version: 1;
  exportedAt: string;
  settings: Record<string, string>;
}

export interface SetupBundleSummary {
  hasFirebase: boolean;
  projectId: string | null;
  email: string | null;
  aiKeysCount: number;
  libraryName: string;
  hasReleaseToken: boolean;
  hasAdminPin: boolean;
}

function getSetting(db: DbClient, key: string, fallback = ""): string {
  return db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value ?? fallback;
}

function setSetting(db: DbClient, key: string, value: string): void {
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value
  );
}

function countAiKeys(settingsMap: Record<string, string>): number {
  const seen = new Set<string>();
  const single = String(settingsMap.ai_api_key || "").trim();
  if (single) seen.add(single);
  try {
    const arr = JSON.parse(settingsMap.ai_keys_pool || "[]");
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const k = typeof item === "string" ? item.trim() : String(item?.apiKey || item?.key || "").trim();
        if (k) seen.add(k);
      }
    }
  } catch {}
  return seen.size;
}

function extractProjectIdFromRaw(rawConfig: string): string | null {
  try {
    const parsed = JSON.parse(rawConfig || "{}");
    const pid = String(parsed?.projectId || "").trim();
    return pid || null;
  } catch {
    return null;
  }
}

export function getSetupBundleSummary(db: DbClient): SetupBundleSummary {
  const settingsMap: Record<string, string> = {};
  for (const key of TRANSFER_SETTINGS_KEYS) {
    const val = getSetting(db, key, "");
    if (val !== "") settingsMap[key] = val;
  }
  const projectId = extractProjectIdFromRaw(settingsMap.firebase_config || "");
  const email = String(settingsMap.firebase_email || "").trim() || null;
  const hasFirebase = Boolean(projectId && email && settingsMap.firebase_password);
  return {
    hasFirebase,
    projectId,
    email,
    aiKeysCount: countAiKeys(settingsMap),
    libraryName: settingsMap.library_name || "אוצר ספרים",
    hasReleaseToken: Boolean(String(settingsMap.github_release_token || "").trim()),
    hasAdminPin: Boolean(String(settingsMap.admin_pin || "").trim()),
  };
}

export async function exportMobilePairingQr(db: DbClient) {
  const fbConfigRaw = getSetting(db, "firebase_config", "").trim();
  const email = getSetting(db, "firebase_email", "").trim();
  const password = getSetting(db, "firebase_password", "");

  let parsedFb: Record<string, unknown> | null = null;
  try {
    parsedFb = JSON.parse(fbConfigRaw || "{}") as Record<string, unknown>;
  } catch {
    parsedFb = null;
  }

  const apiKey = String(parsedFb?.apiKey || "").trim();
  const projectId = String(parsedFb?.projectId || "").trim();
  const appId = String(parsedFb?.appId || "").trim();
  if (!apiKey || !projectId || !appId || !email || !password) {
    throw new Error("יש להגדיר חיבור Firebase פעיל (Config, אימייל וסיסמה) לפני יצירת ברקוד לחיבור הטלפון.");
  }

  const libraryName = getSetting(db, "library_name", "אוצר ספרים").trim() || "אוצר ספרים";
  const themePreset = getSetting(db, "theme_preset", "default").trim() || "default";
  const themeMode = getSetting(db, "theme_mode", "light").trim() === "dark" ? "dark" : "light";

  const fbPayload: Record<string, string> = {
    apiKey,
    projectId,
    appId,
    authDomain: String(parsedFb?.authDomain || `${projectId}.firebaseapp.com`).trim(),
  };
  if (parsedFb?.storageBucket) fbPayload.storageBucket = String(parsedFb.storageBucket).trim();
  if (parsedFb?.messagingSenderId) fbPayload.messagingSenderId = String(parsedFb.messagingSenderId).trim();

  const compactPayload = {
    v: 1,
    f: fbPayload,
    e: email,
    w: password,
    n: libraryName,
    tp: themePreset,
    tm: themeMode,
  };

  const compressed = zlib.deflateRawSync(Buffer.from(JSON.stringify(compactPayload), "utf8"));
  const pairingCode = `OTZAR-QR1:${compressed.toString("base64url")}`;

  const pngBuffer = await bwipjs.toBuffer({
    bcid: "qrcode",
    text: pairingCode,
    eclevel: "M",
    scale: 6,
    padding: 6,
    backgroundcolor: "FFFFFF",
  });

  return {
    ok: true,
    qrDataUrl: `data:image/png;base64,${pngBuffer.toString("base64")}`,
    pairingCode,
    libraryName,
    projectId,
    expiresInSec: 120,
  };
}

export function exportEncryptedSetupBundle(db: DbClient, passcodeRaw: string) {
  const passcode = String(passcodeRaw || "").trim();
  if (passcode.length < 4) {
    throw new Error("יש להזין קוד העברה בן 4 תווים לפחות (מומלץ 6 תווים ומעלה)");
  }

  const settingsMap: Record<string, string> = {};
  for (const key of TRANSFER_SETTINGS_KEYS) {
    const row = db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    if (row && row.value !== undefined) {
      settingsMap[key] = row.value;
    }
  }

  const summary = getSetupBundleSummary(db);
  const exportedAt = new Date().toISOString();
  const payload: OtzarSetupPayload = {
    version: 1,
    exportedAt,
    settings: settingsMap,
  };

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const iterations = 100000;
  const key = crypto.pbkdf2Sync(passcode, salt, iterations, 32, "sha256");

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelope: OtzarSetupBundleEnvelope = {
    format: "otzar-sefarim-setup",
    version: 1,
    kdf: "pbkdf2-sha256",
    iterations,
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    exportedAt,
    libraryNameHint: summary.libraryName,
    projectIdHint: summary.projectId || "",
  };

  const bundleJson = JSON.stringify(envelope, null, 2);
  const compressed = zlib.deflateRawSync(Buffer.from(JSON.stringify(envelope), "utf8"));
  const transferCode = `OTZAR-SETUP:${compressed.toString("base64url")}`;
  const dateTag = exportedAt.slice(0, 10);

  return {
    ok: true,
    fileName: `otzar-sefarim-setup-${dateTag}.otzar-setup`,
    bundleJson,
    transferCode,
    summary,
  };
}

export function decryptSetupBundle(bundleInput: unknown, passcodeRaw: string): OtzarSetupPayload {
  const passcode = String(passcodeRaw || "").trim();
  if (!passcode) {
    throw new Error("יש להזין את קוד ההעברה לפענוח החבילה");
  }

  let envelope: OtzarSetupBundleEnvelope | null = null;
  if (typeof bundleInput === "object" && bundleInput !== null) {
    envelope = bundleInput as OtzarSetupBundleEnvelope;
  } else if (typeof bundleInput === "string") {
    const trimmed = bundleInput.trim();
    if (!trimmed) {
      throw new Error("חבילת ההעברה ריקה");
    }
    if (trimmed.startsWith("OTZAR-SETUP:")) {
      try {
        const b64 = trimmed.slice("OTZAR-SETUP:".length).trim();
        const raw = zlib.inflateRawSync(Buffer.from(b64, "base64url")).toString("utf8");
        envelope = JSON.parse(raw) as OtzarSetupBundleEnvelope;
      } catch {
        throw new Error("קוד ההעברה אינו תקין או שנגזר חלקית");
      }
    } else {
      try {
        envelope = JSON.parse(trimmed) as OtzarSetupBundleEnvelope;
      } catch {
        throw new Error("קובץ ההעברה אינו בפורמט JSON תקין");
      }
    }
  }

  if (
    !envelope ||
    envelope.format !== "otzar-sefarim-setup" ||
    envelope.version !== 1 ||
    envelope.cipher !== "aes-256-gcm" ||
    !envelope.salt ||
    !envelope.iv ||
    !envelope.authTag ||
    !envelope.ciphertext
  ) {
    throw new Error("הקובץ או הקוד שהוזן אינו חבילת הקמה של אוצר ספרים");
  }

  try {
    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const authTag = Buffer.from(envelope.authTag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    const iterations = Math.min(500000, Math.max(10000, Number(envelope.iterations) || 100000));
    const key = crypto.pbkdf2Sync(passcode, salt, iterations, 32, "sha256");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(decrypted) as OtzarSetupPayload;
    if (!parsed || typeof parsed.settings !== "object") {
      throw new Error("מבנה פנימי פגום");
    }
    return parsed;
  } catch {
    throw new Error("קוד ההעברה שגוי או שהחבילה פגומה — הנתונים המקומיים לא שונו");
  }
}

function collectAiQueueImagePaths(db: DbClient, dataDir: string): string[] {
  const aiImagesRoot = path.resolve(dataDir, "ai_images");
  const rows = db.all<{ image_path: string; extra_images_json: string }>(
    "SELECT image_path, extra_images_json FROM ai_catalog_queue"
  );
  const paths: string[] = [];
  for (const r of rows) {
    const candidates: string[] = [];
    if (r.image_path) candidates.push(String(r.image_path));
    if (r.extra_images_json) {
      try {
        const arr = JSON.parse(r.extra_images_json);
        if (Array.isArray(arr)) {
          for (const x of arr) if (x) candidates.push(String(x));
        }
      } catch {}
    }
    for (const c of candidates) {
      const resolved = path.resolve(c);
      if (resolved.startsWith(aiImagesRoot + path.sep) && fs.existsSync(resolved)) {
        paths.push(resolved);
      }
    }
  }
  return paths;
}

export async function importEncryptedSetupBundle(params: {
  db: DbClient;
  syncService: OtzarFirebaseSyncService;
  dataDir: string;
  bundleInput: unknown;
  passcode: string;
  clearDemoData: boolean;
}) {
  const { db, syncService, dataDir, bundleInput, passcode, clearDemoData } = params;

  // 1. Decrypt & validate envelope before touching anything
  const payload = decryptSetupBundle(bundleInput, passcode);
  const importedSettings = payload.settings || {};

  const fbConfigRaw = String(importedSettings.firebase_config || "").trim();
  const fbEmail = String(importedSettings.firebase_email || "").trim();
  const fbPassword = String(importedSettings.firebase_password || "");
  const hasFirebaseInBundle = Boolean(extractProjectIdFromRaw(fbConfigRaw) && fbEmail && fbPassword);

  // 2. Pre-flight Firebase Auth + Firestore verification BEFORE any local demo deletion or settings write
  let verifiedProjectId: string | null = null;
  if (hasFirebaseInBundle) {
    try {
      const verified = await syncService.verifyCredentials(fbConfigRaw, fbEmail, fbPassword);
      verifiedProjectId = verified.config.projectId;
    } catch (err: any) {
      throw new Error(
        `בדיקת החיבור לענן נכשלה לפני שינוי הנתונים (${err?.message || "שגיאת רשת או הרשאה"}). הנתונים המקומיים נשמרו ולא נמחקו.`
      );
    }
  }

  // Only clear demo data if Firebase is present & verified so we never leave an empty offline DB
  const shouldClearDemo = Boolean(clearDemoData && hasFirebaseInBundle);
  const aiImagesToDelete = shouldClearDemo ? collectAiQueueImagePaths(db, dataDir) : [];

  // 3. Disconnect any previous Firebase client cleanly before updating settings
  await syncService.disconnect();

  // 4. Atomic SQLite transaction: pure local demo cleanup (ZERO tombstones, ZERO sync_outbox) + settings write
  db.transaction(() => {
    if (shouldClearDemo) {
      db.run("DELETE FROM loans");
      db.run("DELETE FROM books");
      db.run("DELETE FROM borrowers");
      db.run("DELETE FROM cabinets");
      db.run("DELETE FROM ai_catalog_queue");
      db.run("DELETE FROM sync_outbox");
    }

    db.run("DELETE FROM sync_state WHERE key LIKE 'cursor_%' OR key = 'initial_seed_done'");

    for (const key of TRANSFER_SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(importedSettings, key)) {
        setSetting(db, key, String(importedSettings[key] ?? ""));
      }
    }

    if (hasFirebaseInBundle) {
      setSetting(db, "firebase_enabled", "1");
    }
  });

  // Best-effort cleanup of local AI queue images only after transaction succeeds
  for (const p of aiImagesToDelete) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }

  // 5. Connect & auto-pull full library from Firestore
  if (hasFirebaseInBundle) {
    const conn = await syncService.connect();
    if (!conn.ok) {
      throw new Error(`ההגדרות נשמרו אך החיבור לענן נקטע: ${conn.error || "שגיאת תקשורת"}`);
    }
    db.run(
      "INSERT INTO sync_state (key, value) VALUES ('initial_seed_done', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
  }

  // 6. Safe next_barcode calculation: max(importedNextBarcode, maxNumericBarcode + 1)
  const importedNext = parseInt(String(importedSettings.next_barcode || "100001"), 10) || 100001;
  const safeNextBarcode = reconcileNextBarcodeFromBooks(db, importedNext);

  const booksCount = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM books WHERE deleted_at IS NULL")?.c ?? 0;
  const cabinetsCount = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM cabinets WHERE deleted_at IS NULL")?.c ?? 0;
  const borrowersCount = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM borrowers WHERE deleted_at IS NULL")?.c ?? 0;
  const loansCount = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM loans WHERE deleted_at IS NULL")?.c ?? 0;
  const aiKeysCount = countAiKeys(importedSettings);

  return {
    ok: true,
    message: hasFirebaseInBundle
      ? "חבילת ההקמה יובאה בהצלחה, החיבור ל-Firebase אומת והמאגר נמשך אוטומטית מהענן!"
      : "הגדרות המערכת ומפתחות ה-AI יובאו בהצלחה (חבילה זו אינה כוללת חיבור Firebase).",
    clearedDemoData: shouldClearDemo,
    projectId: verifiedProjectId,
    importedCounts: {
      cabinets: cabinetsCount,
      books: booksCount,
      borrowers: borrowersCount,
      loans: loansCount,
      aiKeysCount,
    },
    nextBarcode: safeNextBarcode,
    deleteFileReminder: true,
    status: syncService.getStatus(),
  };
}

export async function cleanStartCatalogReset(params: {
  db: DbClient;
  syncService: OtzarFirebaseSyncService;
  dataDir: string;
  confirmText: string;
}) {
  const { db, syncService, dataDir, confirmText } = params;
  const trimmed = String(confirmText || "").trim();
  const currentPin = getSetting(db, "admin_pin", "1234").trim();

  if (trimmed !== "אפס" && trimmed.toUpperCase() !== "RESET" && trimmed !== currentPin) {
    throw new Error("לאישור האיפוס יש להקליד 'אפס' (או את קוד ה-PIN של המנהל)");
  }

  const booksRows = db.all<{ barcode: string; sync_id: string | null }>("SELECT barcode, sync_id FROM books");
  const loansRows = db.all<{ id: number; sync_id: string | null }>("SELECT id, sync_id FROM loans");
  const aiQueueCount = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM ai_catalog_queue")?.c ?? 0;
  const aiImagesToDelete = collectAiQueueImagePaths(db, dataDir);
  const firebaseEnabled = syncService.getStatus().enabled;
  const nowIso = new Date().toISOString();

  db.transaction(() => {
    db.run("DELETE FROM sync_outbox WHERE entity_type IN ('book', 'loan') AND synced_at IS NULL");

    if (firebaseEnabled) {
      for (const ln of loansRows) {
        if (ln.sync_id) {
          enqueueSyncOutbox(db, "loan", String(ln.sync_id), "delete", { deleted_at: nowIso });
        }
      }
      for (const bk of booksRows) {
        if (bk.sync_id) {
          enqueueSyncOutbox(db, "book", String(bk.sync_id), "delete", { barcode: bk.barcode, deleted_at: nowIso });
        }
      }
    }

    db.run("DELETE FROM loans");
    db.run("DELETE FROM books");
    db.run("DELETE FROM ai_catalog_queue");
    setSetting(db, "next_barcode", "100001");
  });

  let freedImages = 0;
  for (const p of aiImagesToDelete) {
    try {
      fs.unlinkSync(p);
      freedImages++;
    } catch {}
  }

  if (firebaseEnabled) {
    try {
      await syncService.syncNow();
    } catch {}
  }

  return {
    ok: true,
    deletedBooks: booksRows.length,
    deletedLoans: loansRows.length,
    deletedAiQueue: aiQueueCount,
    freedImages,
    nextBarcode: 100001,
    status: syncService.getStatus(),
  };
}