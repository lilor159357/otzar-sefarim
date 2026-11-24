import fs from "fs";
import path from "path";
import crypto from "crypto";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
  writeBatch,
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";
import type { DbClient } from "../db/adapter.ts";
import {
  buildNormalizedBookSearch,
  DEMO_BOOK_BARCODES,
  DEMO_BOOK_TITLES,
  DEMO_BORROWER_NAMES,
  DEMO_CABINET_CODES,
  enqueueSyncOutbox,
  newSyncId,
} from "../db/schema.ts";

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
}

export interface SparkUsageStats {
  date: string;
  reads: number;
  writes: number;
  deletes: number;
  relayProcessed: number;
  limits: {
    reads: number;
    writes: number;
    deletes: number;
  };
}

export interface DemoCatalogStatus {
  demoBooksCount: number;
  duplicateDemoCount: number;
  isPureDemo: boolean;
}

export interface FirebaseSyncStatus {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  syncing: boolean;
  offline: boolean;
  projectId: string | null;
  email: string | null;
  uid: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingOutboxCount: number;
  pendingRelayLocalCount: number;
  pendingBarcodeBooksCount: number;
  syncEmbeddings: boolean;
  initialSeedDone: boolean;
  deviceId: string;
  demoStatus: DemoCatalogStatus;
  spark: SparkUsageStats;
}

const DEMO_TITLE_SET = new Set<string>(DEMO_BOOK_TITLES);
const DEMO_BARCODE_SET = new Set<string>(DEMO_BOOK_BARCODES);
const AI_BACKUP_KEYS = [
  "ai_api_key",
  "ai_keys_pool",
  "ai_model",
  "ai_auto_fallback",
  "embedding_model",
  "ai_delay_ms",
] as const;

export function detectLocalDemoStatus(db: DbClient): DemoCatalogStatus {
  const activeBooks = db.all<{
    barcode: string;
    title: string;
    author: string;
    volume: string;
    barcode_status: string;
    sync_id: string | null;
  }>("SELECT barcode, title, author, volume, barcode_status, sync_id FROM books WHERE deleted_at IS NULL");

  const assignedBySig = new Set<string>();
  for (const b of activeBooks) {
    if (!String(b.barcode || "").startsWith("MOB-") && b.barcode_status !== "pending_barcode") {
      assignedBySig.add(`${String(b.title || "").trim()}|${String(b.author || "").trim()}|${String(b.volume || "").trim()}`);
    }
  }

  let demoBooksCount = 0;
  let duplicateDemoCount = 0;
  for (const b of activeBooks) {
    const barcode = String(b.barcode || "").trim();
    const title = String(b.title || "").trim();
    const sid = String(b.sync_id || "").trim();
    const isDemoTitle = DEMO_TITLE_SET.has(title);
    const isDemoBook =
      sid.startsWith("demo-book-") ||
      (isDemoTitle && (DEMO_BARCODE_SET.has(barcode) || barcode.startsWith("MOB-")));
    if (isDemoBook) demoBooksCount++;

    const sig = `${title}|${String(b.author || "").trim()}|${String(b.volume || "").trim()}`;
    if (barcode.startsWith("MOB-") && (isDemoTitle || assignedBySig.has(sig))) {
      duplicateDemoCount++;
    }
  }

  const activeLoansCount =
    db.get<{ c: number }>("SELECT COUNT(*) AS c FROM loans WHERE deleted_at IS NULL")?.c ?? 0;
  const isPureDemo =
    activeBooks.length > 0 &&
    activeBooks.length <= 6 &&
    demoBooksCount === activeBooks.length &&
    duplicateDemoCount === 0 &&
    activeLoansCount === 0;

  return { demoBooksCount, duplicateDemoCount, isPureDemo };
}

function countUniqueAiKeysFromMap(map: Record<string, string>): number {
  const seen = new Set<string>();
  const single = String(map.ai_api_key || "").trim();
  if (single) seen.add(single);
  try {
    const arr = JSON.parse(map.ai_keys_pool || "[]");
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const k =
          typeof item === "string"
            ? item.trim()
            : String(item?.apiKey || item?.key || "").trim();
        if (k) seen.add(k);
      }
    }
  } catch {}
  return seen.size;
}

const SPARK_LIMITS = { reads: 50000, writes: 20000, deletes: 20000 };

export const FIRESTORE_RULES_TEMPLATE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isSignedIn() {
      return request.auth != null && request.auth.token.email != null;
    }

    function isValidSyncDoc() {
      return request.resource.data.sync_id is string
        && request.resource.data.sync_id.size() > 0
        && request.resource.data.updated_at is string
        && request.resource.data.updated_at.size() > 0;
    }

    match /cabinets/{syncId} {
      allow read: if isSignedIn();
      allow create, update: if isSignedIn() && isValidSyncDoc();
      allow delete: if isSignedIn();
    }

    match /books/{syncId} {
      allow read: if isSignedIn();
      allow create, update: if isSignedIn() && isValidSyncDoc();
      allow delete: if isSignedIn();
    }

    match /borrowers/{syncId} {
      allow read: if isSignedIn();
      allow create, update: if isSignedIn() && isValidSyncDoc();
      allow delete: if isSignedIn();
    }

    match /loans/{syncId} {
      allow read: if isSignedIn();
      allow create, update: if isSignedIn() && isValidSyncDoc();
      allow delete: if isSignedIn();
    }

    match /library_meta/{docId} {
      allow read, write: if isSignedIn();
    }

    match /ai_relay_queue/{relayId} {
      allow read, delete: if isSignedIn();
      allow create, update: if isSignedIn()
        && request.resource.data.relay_id is string
        && request.resource.data.image_base64 is string
        && request.resource.data.image_base64.size() > 0
        && request.resource.data.image_base64.size() <= 900000
        && request.resource.data.created_at is string;
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

export function parseFirebaseConfigInput(raw: unknown): FirebaseWebConfig | null {
  if (!raw) return null;
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      // Allow pasting JS snippet from Firebase Console: const firebaseConfig = { apiKey: "...", ... };
      const braceStart = trimmed.indexOf("{");
      const braceEnd = trimmed.lastIndexOf("}");
      if (braceStart >= 0 && braceEnd > braceStart) {
        const snippet = trimmed
          .slice(braceStart, braceEnd + 1)
          .replace(/\/\/.*$/gm, "")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
          .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
          .replace(/,\s*([}\]])/g, "$1");
        try {
          const parsed = JSON.parse(snippet);
          if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  if (!obj) return null;
  const apiKey = String(obj.apiKey || "").trim();
  const projectId = String(obj.projectId || "").trim();
  const appId = String(obj.appId || "").trim();
  if (!apiKey || !projectId || !appId) return null;
  return {
    apiKey,
    authDomain: String(obj.authDomain || `${projectId}.firebaseapp.com`).trim(),
    projectId,
    storageBucket: obj.storageBucket ? String(obj.storageBucket).trim() : undefined,
    messagingSenderId: obj.messagingSenderId ? String(obj.messagingSenderId).trim() : undefined,
    appId,
  };
}

function getSyncStateVal(db: DbClient, key: string, fallback = ""): string {
  return db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = ?", key)?.value ?? fallback;
}

function setSyncStateVal(db: DbClient, key: string, value: string): void {
  db.run(
    "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value
  );
}

function getSettingVal(db: DbClient, key: string, fallback = ""): string {
  return db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value ?? fallback;
}

function setSettingVal(db: DbClient, key: string, value: string): void {
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value
  );
}

function formatFirebaseErrorHe(err: unknown): string {
  const msg = String((err as any)?.message || err || "שגיאת חיבור לענן");
  const code = String((err as any)?.code || "");
  const combined = `${code} ${msg}`.toLowerCase();
  if (combined.includes("auth/invalid-credential") || combined.includes("wrong-password") || combined.includes("invalid-login-credentials")) {
    return "אימייל או סיסמה שגויים במשתמש ה-Firebase";
  }
  if (combined.includes("auth/user-not-found")) {
    return "משתמש המנהל לא נמצא בפרויקט (ניתן ליצור אותו דרך כפתור 'צור משתמש מנהל')";
  }
  if (combined.includes("auth/email-already-in-use")) {
    return "האימייל הזה כבר רשום בפרויקט — לחץ על 'שמור והתחבר'";
  }
  if (combined.includes("auth/weak-password")) {
    return "הסיסמה חלשה מדי (Firebase דורש לפחות 6 תווים)";
  }
  if (combined.includes("auth/operation-not-allowed")) {
    return "יש להפעיל שיטת התחברות Email/Password תחת Authentication ב-Firebase Console";
  }
  if (combined.includes("auth/invalid-api-key") || combined.includes("api_key_invalid")) {
    return "מפתח apiKey של פרויקט ה-Firebase אינו תקין";
  }
  if (combined.includes("permission-denied") || combined.includes("missing or insufficient permissions")) {
    return "אין הרשאת גישה ל-Firestore — יש לעדכן את כללי האבטחה (firestore.rules) בלשונית Rules";
  }
  if (combined.includes("not-found") && combined.includes("database")) {
    return "מסד הנתונים Firestore עדיין לא הופעל בפרויקט (יש ליצור Firestore Database ב-Console)";
  }
  if (
    combined.includes("network-request-failed") ||
    combined.includes("enotfound") ||
    combined.includes("etimedout") ||
    combined.includes("econnrefused") ||
    combined.includes("unavailable") ||
    combined.includes("fetch failed")
  ) {
    return "אין חיבור לרשת או שהגישה ל-Firebase חסומה כרגע — השינויים נשמרים בתור המקומי ויסתנכרנו בהמשך";
  }
  return msg;
}

function isNetworkOfflineError(err: unknown): boolean {
  const combined = `${String((err as any)?.code || "")} ${String((err as any)?.message || err || "")}`.toLowerCase();
  return (
    combined.includes("network-request-failed") ||
    combined.includes("enotfound") ||
    combined.includes("etimedout") ||
    combined.includes("econnrefused") ||
    combined.includes("unavailable") ||
    combined.includes("fetch failed") ||
    combined.includes("offline")
  );
}

function parseTagsArray(raw: unknown): string[] {
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

export function reconcileNextBarcodeFromBooks(db: DbClient, minimumNext = 100001): number {
  const prefix = getSettingVal(db, "barcode_prefix", "");
  const currentVal = parseInt(getSettingVal(db, "next_barcode", "100001"), 10) || 100001;
  const rows = db.all<{ barcode: string }>("SELECT barcode FROM books WHERE deleted_at IS NULL");
  let maxNum = 0;
  for (const r of rows) {
    let raw = String(r.barcode || "").trim();
    if (prefix && raw.startsWith(prefix)) {
      raw = raw.slice(prefix.length);
    }
    if (/^\d+$/.test(raw)) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > maxNum && n < 900000000) {
        maxNum = n;
      }
    }
  }
  const safeNext = Math.max(minimumNext, currentVal, maxNum > 0 ? maxNum + 1 : 100001, 100001);
  setSettingVal(db, "next_barcode", String(safeNext));
  return safeNext;
}

export class OtzarFirebaseSyncService {
  private db: DbClient;
  private dataDir: string;
  private onRelayArrived: () => void;
  private app: FirebaseApp | null = null;
  private auth: Auth | null = null;
  private firestore: Firestore | null = null;
  private appSeq = 0;
  private unsubscribers: Unsubscribe[] = [];
  private relayProcessing = new Set<string>();
  private syncInFlight: Promise<{ pushed: number; pulled: number }> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private offline = false;
  private uid: string | null = null;
  private lastError: string | null = null;
  private deviceId: string;
  private stopped = false;

  constructor(db: DbClient, dataDir: string, onRelayArrived: () => void) {
    this.db = db;
    this.dataDir = dataDir;
    this.onRelayArrived = onRelayArrived;
    let devId = getSyncStateVal(db, "device_id", "");
    if (!devId) {
      devId = `desktop-${crypto.randomUUID().slice(0, 8)}`;
      setSyncStateVal(db, "device_id", devId);
    }
    this.deviceId = devId;
  }

  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private ensureSparkDateCurrent(): void {
    const today = this.todayUtc();
    const curDate = getSyncStateVal(this.db, "spark_date", "");
    if (curDate !== today) {
      this.db.transaction(() => {
        setSyncStateVal(this.db, "spark_date", today);
        setSyncStateVal(this.db, "spark_reads", "0");
        setSyncStateVal(this.db, "spark_writes", "0");
        setSyncStateVal(this.db, "spark_deletes", "0");
      });
    }
  }

  private addSparkUsage(delta: { reads?: number; writes?: number; deletes?: number; relayProcessed?: number }): void {
    this.ensureSparkDateCurrent();
    const bump = (key: string, amount: number) => {
      if (!amount) return;
      const cur = parseInt(getSyncStateVal(this.db, key, "0"), 10) || 0;
      setSyncStateVal(this.db, key, String(cur + amount));
    };
    bump("spark_reads", delta.reads || 0);
    bump("spark_writes", delta.writes || 0);
    bump("spark_deletes", delta.deletes || 0);
    bump("relay_processed_total", delta.relayProcessed || 0);
  }

  public getSparkStats(): SparkUsageStats {
    this.ensureSparkDateCurrent();
    return {
      date: getSyncStateVal(this.db, "spark_date", this.todayUtc()),
      reads: parseInt(getSyncStateVal(this.db, "spark_reads", "0"), 10) || 0,
      writes: parseInt(getSyncStateVal(this.db, "spark_writes", "0"), 10) || 0,
      deletes: parseInt(getSyncStateVal(this.db, "spark_deletes", "0"), 10) || 0,
      relayProcessed: parseInt(getSyncStateVal(this.db, "relay_processed_total", "0"), 10) || 0,
      limits: SPARK_LIMITS,
    };
  }

  private loadConfig(): {
    enabled: boolean;
    syncEmbeddings: boolean;
    config: FirebaseWebConfig | null;
    email: string;
    password: string;
  } {
    const enabled = getSettingVal(this.db, "firebase_enabled", "0") === "1";
    const syncEmbeddings = getSettingVal(this.db, "firebase_sync_embeddings", "1") !== "0";
    const config = parseFirebaseConfigInput(getSettingVal(this.db, "firebase_config", "{}"));
    const email = getSettingVal(this.db, "firebase_email", "").trim();
    const password = getSettingVal(this.db, "firebase_password", "");
    return { enabled, syncEmbeddings, config, email, password };
  }

  public getPublicConfig() {
    const cfg = this.loadConfig();
    return {
      enabled: cfg.enabled,
      syncEmbeddings: cfg.syncEmbeddings,
      config: cfg.config,
      email: cfg.email,
      hasPassword: Boolean(cfg.password),
    };
  }

  public getDataDir(): string {
    return this.dataDir;
  }

  public async verifyCredentials(
    configInput: unknown,
    emailInput: string,
    passwordInput: string
  ): Promise<{ config: FirebaseWebConfig; email: string; password: string }> {
    const parsedConfig = parseFirebaseConfigInput(configInput);
    if (!parsedConfig) {
      throw new Error("תצורת Firebase בחבילה אינה תקינה — נדרשים לפחות apiKey, projectId ו-appId");
    }
    const email = String(emailInput || "").trim();
    const password = String(passwordInput || "");
    if (!email || !password) {
      throw new Error("חסרים פרטי התחברות (אימייל/סיסמה) ל-Firebase");
    }
    const tempApp = initializeApp(parsedConfig, `otzar-preflight-${++this.appSeq}`);
    try {
      const tempAuth = getAuth(tempApp);
      const tempFs = initializeFirestore(tempApp, { experimentalForceLongPolling: true });
      await signInWithEmailAndPassword(tempAuth, email, password);
      await getDocs(query(collection(tempFs, "library_meta"), limit(1)));
      this.addSparkUsage({ reads: 1 });
      return { config: parsedConfig, email, password };
    } catch (err) {
      throw new Error(formatFirebaseErrorHe(err));
    } finally {
      try {
        await deleteApp(tempApp);
      } catch {}
    }
  }

  public async disconnect(): Promise<void> {
    await this.teardownClient();
  }

  public getStatus(): FirebaseSyncStatus {
    const cfg = this.loadConfig();
    const configured = Boolean(cfg.config && cfg.email && cfg.password);
    const pendingOutboxCount =
      this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM sync_outbox WHERE synced_at IS NULL")?.c ?? 0;
    const pendingRelayLocalCount =
      this.db.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM ai_catalog_queue WHERE source_relay_id IS NOT NULL AND approval_status = 'pending'"
      )?.c ?? 0;
    const pendingBarcodeBooksCount =
      this.db.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM books WHERE barcode_status = 'pending_barcode' AND deleted_at IS NULL"
      )?.c ?? 0;
    return {
      enabled: cfg.enabled,
      configured,
      connected: this.connected,
      syncing: Boolean(this.syncInFlight),
      offline: this.offline,
      projectId: cfg.config?.projectId || null,
      email: cfg.email || null,
      uid: this.uid,
      lastSyncAt: getSyncStateVal(this.db, "last_sync_at", "") || null,
      lastError: this.lastError,
      pendingOutboxCount,
      pendingRelayLocalCount,
      pendingBarcodeBooksCount,
      syncEmbeddings: cfg.syncEmbeddings,
      initialSeedDone: getSyncStateVal(this.db, "initial_seed_done", "0") === "1",
      deviceId: this.deviceId,
      demoStatus: detectLocalDemoStatus(this.db),
      spark: this.getSparkStats(),
    };
  }

  private async teardownClient(): Promise<void> {
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {}
    }
    this.unsubscribers = [];
    this.connected = false;
    this.uid = null;
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.auth) {
      try {
        await signOut(this.auth);
      } catch {}
      this.auth = null;
    }
    this.firestore = null;
    if (this.app) {
      try {
        await deleteApp(this.app);
      } catch {}
      this.app = null;
    }
  }

  private scheduleReconnect(delayMs = 20000): void {
    if (this.stopped || this.reconnectTimer) return;
    const cfg = this.loadConfig();
    if (!cfg.enabled || !cfg.config || !cfg.email || !cfg.password) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        void this.connect();
      }
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  public async connect(): Promise<{ ok: boolean; error?: string }> {
    if (this.stopped) return { ok: false, error: "stopped" };
    await this.teardownClient();
    const cfg = this.loadConfig();
    if (!cfg.enabled) {
      this.lastError = null;
      this.offline = false;
      return { ok: false, error: "הסנכרון כבוי בהגדרות" };
    }
    if (!cfg.config || !cfg.email || !cfg.password) {
      this.lastError = "חסרים פרטי פרויקט Firebase או פרטי התחברות מנהל";
      return { ok: false, error: this.lastError };
    }

    try {
      const appName = `otzar-sync-${++this.appSeq}`;
      const app = initializeApp(cfg.config, appName);
      const auth = getAuth(app);
      const fsClient = initializeFirestore(app, {
        experimentalForceLongPolling: true,
      });

      const cred = await signInWithEmailAndPassword(auth, cfg.email, cfg.password);
      this.app = app;
      this.auth = auth;
      this.firestore = fsClient;
      this.uid = cred.user.uid;
      this.connected = true;
      this.offline = false;
      this.lastError = null;

      this.startRealtimeListeners();
      // Background periodic delta sync + outbox safety sweep every 45s
      this.periodicTimer = setInterval(() => {
        if (this.connected && !this.syncInFlight) {
          void this.syncNow().catch(() => {});
        }
      }, 45000);
      this.periodicTimer.unref?.();

      // Immediate delta sync on connect
      await this.syncNow();
      return { ok: true };
    } catch (err) {
      this.connected = false;
      this.offline = isNetworkOfflineError(err);
      this.lastError = formatFirebaseErrorHe(err);
      if (this.offline) {
        this.scheduleReconnect(20000);
      }
      return { ok: false, error: this.lastError };
    }
  }

  public async testAndSaveConfig(params: {
    enabled: boolean;
    syncEmbeddings: boolean;
    configInput: unknown;
    email: string;
    password?: string;
    createUserIfMissing?: boolean;
    clearDemoData?: boolean;
  }): Promise<{ ok: boolean; clearedDemoData: boolean; message: string; status: FirebaseSyncStatus }> {
    const parsedConfig = parseFirebaseConfigInput(params.configInput);
    if (!parsedConfig) {
      throw new Error("תצורת Firebase אינה תקינה — נדרשים לפחות apiKey, projectId ו-appId");
    }
    const email = String(params.email || "").trim();
    const existingPassword = getSettingVal(this.db, "firebase_password", "");
    const password = params.password !== undefined && params.password !== "" ? params.password : existingPassword;
    if (!email || !password) {
      throw new Error("יש להזין אימייל וסיסמה של משתמש המנהל ב-Firebase");
    }

    let cloudHasLibraryData = false;
    // Test connection with a dedicated temporary Firebase app instance
    const tempApp = initializeApp(parsedConfig, `otzar-test-${++this.appSeq}`);
    try {
      const tempAuth = getAuth(tempApp);
      const tempFs = initializeFirestore(tempApp, { experimentalForceLongPolling: true });
      if (params.createUserIfMissing) {
        try {
          await createUserWithEmailAndPassword(tempAuth, email, password);
        } catch (createErr: any) {
          if (String(createErr?.code || "").includes("email-already-in-use")) {
            await signInWithEmailAndPassword(tempAuth, email, password);
          } else {
            throw createErr;
          }
        }
      } else {
        await signInWithEmailAndPassword(tempAuth, email, password);
      }

      // Verify Firestore access and check if cloud already has library data
      await getDocs(query(collection(tempFs, "library_meta"), limit(1)));
      const [cloudBooksSnap, cloudCabsSnap] = await Promise.all([
        getDocs(query(collection(tempFs, "books"), limit(1))),
        getDocs(query(collection(tempFs, "cabinets"), limit(1))),
      ]);
      cloudHasLibraryData = !cloudBooksSnap.empty || !cloudCabsSnap.empty;
      this.addSparkUsage({ reads: 3 });
    } catch (err) {
      throw new Error(formatFirebaseErrorHe(err));
    } finally {
      try {
        await deleteApp(tempApp);
      } catch {}
    }

    const demoStatus = detectLocalDemoStatus(this.db);
    const shouldClearDemo = Boolean(
      params.enabled && params.clearDemoData !== false && cloudHasLibraryData && demoStatus.isPureDemo
    );

    await this.teardownClient();

    this.db.transaction(() => {
      if (shouldClearDemo) {
        this.db.run("DELETE FROM loans");
        this.db.run("DELETE FROM books");
        this.db.run("DELETE FROM borrowers");
        this.db.run("DELETE FROM cabinets");
        this.db.run("DELETE FROM sync_outbox");
        this.db.run("DELETE FROM sync_state WHERE key LIKE 'cursor_%' OR key = 'initial_seed_done'");
      }
      setSettingVal(this.db, "firebase_config", JSON.stringify(parsedConfig));
      setSettingVal(this.db, "firebase_email", email);
      setSettingVal(this.db, "firebase_password", password);
      setSettingVal(this.db, "firebase_enabled", params.enabled ? "1" : "0");
      setSettingVal(this.db, "firebase_sync_embeddings", params.syncEmbeddings ? "1" : "0");
    });

    if (params.enabled) {
      const conn = await this.connect();
      return {
        ok: conn.ok,
        clearedDemoData: shouldClearDemo,
        message: conn.ok
          ? shouldClearDemo
            ? "החיבור אומת! נתוני הדמו המקומיים הוסרו אוטומטית והספרייה נמשכה מהענן."
            : "החיבור ל-Firebase Auth ו-Firestore אומת בהצלחה והסנכרון פעיל!"
          : conn.error || "הפרטים נשמרו אך החיבור נכשל",
        status: this.getStatus(),
      };
    } else {
      await this.teardownClient();
      return {
        ok: true,
        clearedDemoData: false,
        message: "הפרטים אומתו ונשמרו (הסנכרון האוטומטי כבוי כרגע).",
        status: this.getStatus(),
      };
    }
  }

  public async setEnabled(enabled: boolean, syncEmbeddings?: boolean): Promise<FirebaseSyncStatus> {
    setSettingVal(this.db, "firebase_enabled", enabled ? "1" : "0");
    if (syncEmbeddings !== undefined) {
      setSettingVal(this.db, "firebase_sync_embeddings", syncEmbeddings ? "1" : "0");
    }
    if (enabled) {
      await this.connect();
    } else {
      await this.teardownClient();
      this.lastError = null;
      this.offline = false;
    }
    return this.getStatus();
  }

  public notifyLocalMutation(): void {
    const cfg = this.loadConfig();
    if (!cfg.enabled || !this.connected) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.syncNow().catch(() => {});
    }, 1200);
    this.flushTimer.unref?.();
  }

  private startRealtimeListeners(): void {
    if (!this.firestore) return;
    const fsClient = this.firestore;

    // 1. Real-time listener on ai_relay_queue (compressed cover photos from Android APK)
    const relayQuery = query(collection(fsClient, "ai_relay_queue"), orderBy("created_at", "asc"), limit(20));
    const unsubRelay = onSnapshot(
      relayQuery,
      (snap) => {
        if (snap.empty) return;
        this.addSparkUsage({ reads: snap.docChanges().filter((c) => c.type === "added" || c.type === "modified").length || 1 });
        for (const d of snap.docs) {
          void this.processRelayDocument(d.id, d.data());
        }
      },
      (err) => {
        this.lastError = formatFirebaseErrorHe(err);
        if (isNetworkOfflineError(err)) {
          this.offline = true;
          this.connected = false;
          this.scheduleReconnect(20000);
        }
      }
    );
    this.unsubscribers.push(unsubRelay);

    // 2. Economical incremental listeners (only documents changed AFTER current cursor -> 0 idle reads)
    const entities: Array<{ col: string; entity: "cabinet" | "book" | "borrower" | "loan" }> = [
      { col: "cabinets", entity: "cabinet" },
      { col: "borrowers", entity: "borrower" },
      { col: "books", entity: "book" },
      { col: "loans", entity: "loan" },
    ];
    for (const { col, entity } of entities) {
      const cursor = getSyncStateVal(this.db, `cursor_${entity}`, "");
      const q = cursor
        ? query(collection(fsClient, col), where("updated_at", ">", cursor), orderBy("updated_at", "asc"), limit(100))
        : query(collection(fsClient, col), orderBy("updated_at", "asc"), limit(100));
      let isFirstSnapshot = true;
      const unsub = onSnapshot(
        q,
        (snap) => {
          if (isFirstSnapshot) {
            isFirstSnapshot = false;
            return; // Initial state is handled cleanly by pullDeltaChanges()
          }
          const changes = snap.docChanges().filter((c) => c.type === "added" || c.type === "modified");
          if (changes.length === 0) return;
          this.addSparkUsage({ reads: changes.length });
          let maxUpdatedAt = getSyncStateVal(this.db, `cursor_${entity}`, "");
          let applied = 0;
          this.db.transaction(() => {
            for (const ch of changes) {
              const data = ch.doc.data();
              if (data.source_device === this.deviceId) continue;
              if (this.applyRemoteDoc(entity, ch.doc.id, data)) applied++;
              const u = String(data.updated_at || "");
              if (u && u > maxUpdatedAt) maxUpdatedAt = u;
            }
            if (maxUpdatedAt) setSyncStateVal(this.db, `cursor_${entity}`, maxUpdatedAt);
          });
          if (applied > 0) {
            setSyncStateVal(this.db, "last_sync_at", new Date().toISOString());
          }
        },
        () => {
          // Non-fatal: periodic delta pull still covers recovery
        }
      );
      this.unsubscribers.push(unsub);
    }
  }

  private async processRelayDocument(relayId: string, data: Record<string, unknown>): Promise<void> {
    if (!this.firestore) return;
    if (this.relayProcessing.has(relayId)) return;
    this.relayProcessing.add(relayId);
    try {
      // Idempotency check in SQLite
      const already = this.db.get<{ id: number }>("SELECT id FROM ai_catalog_queue WHERE source_relay_id = ?", relayId);
      if (already) {
        await deleteDoc(doc(this.firestore, "ai_relay_queue", relayId));
        this.addSparkUsage({ deletes: 1 });
        return;
      }

      const aiImagesDir = path.join(this.dataDir, "ai_images");
      fs.mkdirSync(aiImagesDir, { recursive: true });

      const saveB64 = (rawInput: unknown, mimeInput: unknown): string | null => {
        const raw = String(rawInput || "").trim();
        if (!raw) return null;
        const clean = raw.includes(",") ? raw.split(",")[1] : raw;
        const mime = String(mimeInput || "image/jpeg").toLowerCase();
        const ext = mime.includes("webp") ? ".webp" : mime.includes("png") ? ".png" : ".jpg";
        const fileName = `relay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
        const dest = path.join(aiImagesDir, fileName);
        fs.writeFileSync(dest, Buffer.from(clean, "base64"));
        return dest;
      };

      const savedPaths: string[] = [];
      const mainPath = saveB64(data.image_base64, data.mime_type);
      if (mainPath) savedPaths.push(mainPath);
      if (Array.isArray(data.extra_images_base64)) {
        for (const extra of data.extra_images_base64) {
          const ep = saveB64(extra, data.mime_type);
          if (ep) savedPaths.push(ep);
        }
      }
      if (savedPaths.length === 0) {
        await deleteDoc(doc(this.firestore, "ai_relay_queue", relayId));
        this.addSparkUsage({ deletes: 1 });
        return;
      }

      // Resolve optional default cabinet + shelf sent from mobile shooting session
      let defaultCabId: number | null = null;
      const cabSyncId = String(data.default_cabinet_sync_id || "").trim();
      const cabCode = String(data.default_cabinet_code || "").trim();
      if (cabSyncId) {
        defaultCabId =
          this.db.get<{ id: number }>("SELECT id FROM cabinets WHERE sync_id = ? AND deleted_at IS NULL", cabSyncId)?.id ?? null;
      }
      if (!defaultCabId && cabCode) {
        defaultCabId =
          this.db.get<{ id: number }>("SELECT id FROM cabinets WHERE code = ? AND deleted_at IS NULL", cabCode)?.id ?? null;
      }
      const rawShelf = Number(data.default_shelf_number);
      const defaultShelf = Number.isFinite(rawShelf) && rawShelf > 0 ? Math.round(rawShelf) : null;

      const [firstPath, ...extraPaths] = savedPaths;
      const createdAt = String(data.created_at || new Date().toISOString());
      const setBatchId = data.set_batch_id ? String(data.set_batch_id).trim() : null;
      const isShelfSet = data.is_shelf_set ? 1 : 0;
      const presetSetName = data.preset_set_name ? String(data.preset_set_name).trim() : "";
      const initialMeta: Record<string, unknown> = {};
      if (presetSetName) initialMeta.set_name = presetSetName;
      if (isShelfSet === 1 && typeof data.title_images_count === "number" && Number.isFinite(data.title_images_count)) {
        initialMeta._title_images_count = Math.max(0, Math.round(data.title_images_count));
      }
      const initialExtractedJson = Object.keys(initialMeta).length > 0 ? JSON.stringify(initialMeta) : "";

      this.db.run(
        `INSERT INTO ai_catalog_queue
         (image_path, extra_images_json, default_cabinet_id, default_shelf_number, source_relay_id, set_batch_id, is_shelf_set, extracted_json, processing_status, approval_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?)`,
        firstPath,
        JSON.stringify(extraPaths),
        defaultCabId,
        defaultShelf,
        relayId,
        setBatchId,
        isShelfSet,
        initialExtractedJson,
        createdAt
      );

      // Immediately delete temporary document from Firestore so Spark Plan stays clean
      await deleteDoc(doc(this.firestore, "ai_relay_queue", relayId));
      this.addSparkUsage({ deletes: 1, relayProcessed: 1 });
      setSyncStateVal(this.db, "last_sync_at", new Date().toISOString());
      this.onRelayArrived();
    } catch (err) {
      this.lastError = formatFirebaseErrorHe(err);
    } finally {
      this.relayProcessing.delete(relayId);
    }
  }

  public async seedAllToCloud(): Promise<{ queued: number; pushed: number; pulled: number }> {
    const cfg = this.loadConfig();
    if (!cfg.enabled || !this.connected) {
      const conn = await this.connect();
      if (!conn.ok) throw new Error(conn.error || "Firebase אינו מחובר");
    }

    const pendingSet = new Set(
      this.db
        .all<{ k: string }>("SELECT entity_type || ':' || sync_id AS k FROM sync_outbox WHERE synced_at IS NULL")
        .map((r) => r.k)
    );

    let queued = 0;
    this.db.transaction(() => {
      const cabs = this.db.all<{ id: number; sync_id: string }>(
        "SELECT id, sync_id FROM cabinets WHERE deleted_at IS NULL"
      );
      for (const c of cabs) {
        const sid = c.sync_id || newSyncId();
        if (!c.sync_id) this.db.run("UPDATE cabinets SET sync_id = ? WHERE id = ?", sid, c.id);
        if (!pendingSet.has(`cabinet:${sid}`)) {
          enqueueSyncOutbox(this.db, "cabinet", sid, "upsert", { id: c.id });
          queued++;
        }
      }

      const borrowers = this.db.all<{ id: number; sync_id: string }>(
        "SELECT id, sync_id FROM borrowers WHERE deleted_at IS NULL"
      );
      for (const b of borrowers) {
        const sid = b.sync_id || newSyncId();
        if (!b.sync_id) this.db.run("UPDATE borrowers SET sync_id = ? WHERE id = ?", sid, b.id);
        if (!pendingSet.has(`borrower:${sid}`)) {
          enqueueSyncOutbox(this.db, "borrower", sid, "upsert", { id: b.id });
          queued++;
        }
      }

      const books = this.db.all<{ barcode: string; sync_id: string }>(
        "SELECT barcode, sync_id FROM books WHERE deleted_at IS NULL"
      );
      for (const bk of books) {
        const sid = bk.sync_id || newSyncId();
        if (!bk.sync_id) this.db.run("UPDATE books SET sync_id = ? WHERE barcode = ?", sid, bk.barcode);
        if (!pendingSet.has(`book:${sid}`)) {
          enqueueSyncOutbox(this.db, "book", sid, "upsert", { barcode: bk.barcode });
          queued++;
        }
      }

      const loans = this.db.all<{ id: number; sync_id: string }>(
        "SELECT id, sync_id FROM loans WHERE deleted_at IS NULL"
      );
      for (const l of loans) {
        const sid = l.sync_id || newSyncId();
        if (!l.sync_id) this.db.run("UPDATE loans SET sync_id = ? WHERE id = ?", sid, l.id);
        if (!pendingSet.has(`loan:${sid}`)) {
          enqueueSyncOutbox(this.db, "loan", sid, "upsert", { id: l.id });
          queued++;
        }
      }
    });

    await this.pushLibraryMeta();
    const res = await this.syncNow();
    setSyncStateVal(this.db, "initial_seed_done", "1");
    return { queued, ...res };
  }

  private async pushLibraryMeta(): Promise<void> {
    if (!this.firestore) return;
    const libraryName = getSettingVal(this.db, "library_name", "אוצר ספרים");
    const defaultLoanDays = parseInt(getSettingVal(this.db, "default_loan_days", "14"), 10) || 14;
    let mapEntrance: unknown = { wall: "bottom", offset: 50 };
    try {
      mapEntrance = JSON.parse(getSettingVal(this.db, "map_entrance", "{}"));
    } catch {}
    await setDoc(
      doc(this.firestore, "library_meta", "settings"),
      {
        library_name: libraryName,
        default_loan_days: defaultLoanDays,
        map_entrance: mapEntrance,
        updated_at: new Date().toISOString(),
        source_device: this.deviceId,
      },
      { merge: true }
    );
    this.addSparkUsage({ writes: 1 });
  }

  public async syncNow(): Promise<{ pushed: number; pulled: number }> {
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = (async () => {
      const cfg = this.loadConfig();
      if (!cfg.enabled) return { pushed: 0, pulled: 0 };
      if (!this.connected || !this.firestore) {
        const conn = await this.connect();
        if (!conn.ok || !this.firestore) {
          return { pushed: 0, pulled: 0 };
        }
      }
      try {
        const pushed = await this.pushOutboxAll();
        const pulled = await this.pullDeltaAll();
        this.offline = false;
        this.lastError = null;
        setSyncStateVal(this.db, "last_sync_at", new Date().toISOString());
        return { pushed, pulled };
      } catch (err) {
        this.lastError = formatFirebaseErrorHe(err);
        if (isNetworkOfflineError(err)) {
          this.offline = true;
          this.connected = false;
          this.scheduleReconnect(20000);
        }
        throw new Error(this.lastError);
      } finally {
        this.syncInFlight = null;
      }
    })();
    return this.syncInFlight;
  }

  private async pushOutboxAll(): Promise<number> {
    if (!this.firestore) return 0;
    const cfg = this.loadConfig();
    let totalPushed = 0;

    for (let round = 0; round < 25; round++) {
      const rows = this.db.all<{
        id: number;
        entity_type: "book" | "cabinet" | "borrower" | "loan";
        sync_id: string;
        operation: "upsert" | "delete";
        payload_json: string;
      }>("SELECT id, entity_type, sync_id, operation, payload_json FROM sync_outbox WHERE synced_at IS NULL ORDER BY id ASC LIMIT 250");

      if (rows.length === 0) break;

      // Collapse duplicate outbox events for the same entity in this batch
      const dedup = new Map<
        string,
        {
          entity_type: "book" | "cabinet" | "borrower" | "loan";
          sync_id: string;
          operation: "upsert" | "delete";
          payload_json: string;
        }
      >();
      const allIds: number[] = [];
      for (const r of rows) {
        allIds.push(r.id);
        dedup.set(`${r.entity_type}:${r.sync_id}`, r);
      }

      const batch = writeBatch(this.firestore);
      let batchOps = 0;
      const nowIso = new Date().toISOString();

      for (const item of dedup.values()) {
        const colName =
          item.entity_type === "cabinet"
            ? "cabinets"
            : item.entity_type === "book"
            ? "books"
            : item.entity_type === "borrower"
            ? "borrowers"
            : "loans";
        const ref = doc(this.firestore, colName, item.sync_id);
        let payloadMeta: Record<string, unknown> = {};
        try {
          payloadMeta = JSON.parse(item.payload_json || "{}");
        } catch {}

        if (item.operation === "delete") {
          const delAt = String(payloadMeta.deleted_at || nowIso);
          batch.set(
            ref,
            {
              sync_id: item.sync_id,
              deleted_at: delAt,
              updated_at: delAt,
              source_device: this.deviceId,
            },
            { merge: true }
          );
          batchOps++;
          continue;
        }

        if (item.entity_type === "cabinet") {
          const cab = this.db.get<Record<string, unknown>>("SELECT * FROM cabinets WHERE sync_id = ?", item.sync_id);
          if (!cab || cab.deleted_at) {
            const delAt = String(cab?.deleted_at || nowIso);
            batch.set(ref, { sync_id: item.sync_id, deleted_at: delAt, updated_at: delAt, source_device: this.deviceId }, { merge: true });
          } else {
            batch.set(
              ref,
              {
                sync_id: item.sync_id,
                code: String(cab.code || ""),
                main_subject: String(cab.main_subject || ""),
                shelves_count: Number(cab.shelves_count) || 5,
                x: Number(cab.x) || 0,
                y: Number(cab.y) || 0,
                width: Number(cab.width) || 150,
                height: Number(cab.height) || 64,
                rotation: Number(cab.rotation) || 0,
                updated_at: String(cab.updated_at || nowIso),
                deleted_at: null,
                source_device: this.deviceId,
              },
              { merge: true }
            );
          }
          batchOps++;
        } else if (item.entity_type === "borrower") {
          const br = this.db.get<Record<string, unknown>>("SELECT * FROM borrowers WHERE sync_id = ?", item.sync_id);
          if (!br || br.deleted_at) {
            const delAt = String(br?.deleted_at || nowIso);
            batch.set(ref, { sync_id: item.sync_id, deleted_at: delAt, updated_at: delAt, source_device: this.deviceId }, { merge: true });
          } else {
            batch.set(
              ref,
              {
                sync_id: item.sync_id,
                full_name: String(br.full_name || ""),
                shiur_group: String(br.shiur_group || ""),
                phone: String(br.phone || ""),
                notes: String(br.notes || ""),
                created_at: String(br.created_at || nowIso),
                updated_at: String(br.updated_at || nowIso),
                deleted_at: null,
                source_device: this.deviceId,
              },
              { merge: true }
            );
          }
          batchOps++;
        } else if (item.entity_type === "book") {
          const bk = this.db.get<Record<string, unknown>>(
            `SELECT b.*, c.sync_id AS cabinet_sync_id, c.code AS cabinet_code
             FROM books b
             LEFT JOIN cabinets c ON b.cabinet_id = c.id AND c.deleted_at IS NULL
             WHERE b.sync_id = ?`,
            item.sync_id
          );
          if (!bk || bk.deleted_at) {
            const delAt = String(bk?.deleted_at || nowIso);
            batch.set(
              ref,
              {
                sync_id: item.sync_id,
                barcode: String(bk?.barcode || payloadMeta.barcode || ""),
                deleted_at: delAt,
                updated_at: delAt,
                source_device: this.deviceId,
              },
              { merge: true }
            );
          } else {
            const docPayload: Record<string, unknown> = {
              sync_id: item.sync_id,
              barcode: String(bk.barcode || ""),
              barcode_status: String(bk.barcode_status || "assigned"),
              title: String(bk.title || ""),
              set_name: String(bk.set_name || ""),
              author: String(bk.author || ""),
              volume: String(bk.volume || ""),
              publisher: String(bk.publisher || ""),
              pub_year: String(bk.pub_year || ""),
              edition: String(bk.edition || ""),
              category: String(bk.category || ""),
              tags: parseTagsArray(bk.tags),
              format_size: String(bk.format_size || ""),
              thickness_mm: bk.thickness_mm != null ? Number(bk.thickness_mm) : null,
              pages_count: bk.pages_count != null ? Number(bk.pages_count) : null,
              cabinet_sync_id: bk.cabinet_sync_id ? String(bk.cabinet_sync_id) : null,
              cabinet_code: bk.cabinet_code ? String(bk.cabinet_code) : null,
              shelf_number: bk.shelf_number != null ? Number(bk.shelf_number) : null,
              notes: String(bk.notes || ""),
              status: String(bk.status || "available"),
              label_printed: Number(bk.label_printed) ? 1 : 0,
              created_at: String(bk.created_at || nowIso),
              updated_at: String(bk.updated_at || nowIso),
              deleted_at: null,
              source_device: this.deviceId,
            };
            if (cfg.syncEmbeddings && bk.embedding) {
              const rawBuf = bk.embedding instanceof Uint8Array ? Buffer.from(bk.embedding) : Buffer.from(bk.embedding as ArrayBuffer);
              if (rawBuf.length > 0) {
                docPayload.embedding_b64 = rawBuf.toString("base64");
              }
            }
            batch.set(ref, docPayload, { merge: true });
          }
          batchOps++;
        } else if (item.entity_type === "loan") {
          const ln = this.db.get<Record<string, unknown>>(
            `SELECT l.*, b.sync_id AS book_sync_id, br.sync_id AS borrower_sync_id
             FROM loans l
             LEFT JOIN books b ON l.book_barcode = b.barcode
             LEFT JOIN borrowers br ON l.borrower_id = br.id
             WHERE l.sync_id = ?`,
            item.sync_id
          );
          if (!ln || ln.deleted_at) {
            const delAt = String(ln?.deleted_at || nowIso);
            batch.set(ref, { sync_id: item.sync_id, deleted_at: delAt, updated_at: delAt, source_device: this.deviceId }, { merge: true });
          } else {
            batch.set(
              ref,
              {
                sync_id: item.sync_id,
                book_sync_id: ln.book_sync_id ? String(ln.book_sync_id) : null,
                book_barcode: String(ln.book_barcode || ""),
                borrower_sync_id: ln.borrower_sync_id ? String(ln.borrower_sync_id) : null,
                loan_date: String(ln.loan_date || nowIso),
                due_date: String(ln.due_date || nowIso),
                return_date: ln.return_date ? String(ln.return_date) : null,
                updated_at: String(ln.updated_at || nowIso),
                deleted_at: null,
                source_device: this.deviceId,
              },
              { merge: true }
            );
          }
          batchOps++;
        }
      }

      if (batchOps > 0) {
        await batch.commit();
        this.addSparkUsage({ writes: batchOps });
        totalPushed += batchOps;
      }

      const placeholders = allIds.map(() => "?").join(",");
      this.db.run(`UPDATE sync_outbox SET synced_at = ? WHERE id IN (${placeholders})`, nowIso, ...allIds);
    }

    return totalPushed;
  }

  private async pullDeltaAll(): Promise<number> {
    if (!this.firestore) return 0;
    let totalPulled = 0;
    const order: Array<{ col: string; entity: "cabinet" | "borrower" | "book" | "loan" }> = [
      { col: "cabinets", entity: "cabinet" },
      { col: "borrowers", entity: "borrower" },
      { col: "books", entity: "book" },
      { col: "loans", entity: "loan" },
    ];

    for (const { col, entity } of order) {
      let cursor = getSyncStateVal(this.db, `cursor_${entity}`, "");
      for (let page = 0; page < 25; page++) {
        const q = cursor
          ? query(collection(this.firestore, col), where("updated_at", ">", cursor), orderBy("updated_at", "asc"), limit(200))
          : query(collection(this.firestore, col), orderBy("updated_at", "asc"), limit(200));

        const snap = await getDocs(q);
        if (snap.empty) break;
        this.addSparkUsage({ reads: snap.size });

        let nextCursor = cursor;
        this.db.transaction(() => {
          for (const d of snap.docs) {
            const data = d.data();
            const u = String(data.updated_at || "");
            if (u && u > nextCursor) nextCursor = u;
            if (data.source_device === this.deviceId) continue;
            if (this.applyRemoteDoc(entity, d.id, data)) {
              totalPulled++;
            }
          }
          if (nextCursor && nextCursor !== cursor) {
            setSyncStateVal(this.db, `cursor_${entity}`, nextCursor);
          }
        });
        cursor = nextCursor;
        if (snap.size < 200) break;
      }
    }

    if (totalPulled > 0) {
      reconcileNextBarcodeFromBooks(this.db);
    }

    return totalPulled;
  }

  private applyRemoteDoc(
    entity: "cabinet" | "borrower" | "book" | "loan",
    docId: string,
    data: Record<string, unknown>
  ): boolean {
    const syncId = String(data.sync_id || docId).trim();
    const remoteUpdated = String(data.updated_at || "");
    if (!syncId || !remoteUpdated) return false;
    const deletedAt = data.deleted_at ? String(data.deleted_at) : null;

    if (entity === "cabinet") {
      const code = String(data.code || "").trim();
      const existing =
        this.db.get<Record<string, unknown>>("SELECT * FROM cabinets WHERE sync_id = ?", syncId) ||
        (code ? this.db.get<Record<string, unknown>>("SELECT * FROM cabinets WHERE code = ? AND deleted_at IS NULL", code) : undefined);

      if (existing && String(existing.updated_at || "") >= remoteUpdated) {
        return false;
      }
      if (deletedAt) {
        if (existing) {
          this.db.run(
            "UPDATE cabinets SET deleted_at = ?, updated_at = ?, sync_id = COALESCE(sync_id, ?) WHERE id = ?",
            deletedAt,
            remoteUpdated,
            syncId,
            existing.id as number
          );
          return true;
        }
        return false;
      }
      if (!code) return false;
      if (existing) {
        this.db.run(
          `UPDATE cabinets
           SET code = ?, main_subject = ?, shelves_count = ?, x = ?, y = ?, width = ?, height = ?, rotation = ?, sync_id = ?, updated_at = ?, deleted_at = NULL
           WHERE id = ?`,
          code,
          String(data.main_subject || ""),
          Math.max(1, Number(data.shelves_count) || 5),
          Number(data.x) || 40,
          Number(data.y) || 40,
          Math.max(40, Number(data.width) || 150),
          Math.max(40, Number(data.height) || 64),
          Number(data.rotation) || 0,
          syncId,
          remoteUpdated,
          existing.id as number
        );
      } else {
        this.db.run(
          `INSERT INTO cabinets (code, main_subject, shelves_count, x, y, width, height, rotation, sync_id, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          code,
          String(data.main_subject || ""),
          Math.max(1, Number(data.shelves_count) || 5),
          Number(data.x) || 40,
          Number(data.y) || 40,
          Math.max(40, Number(data.width) || 150),
          Math.max(40, Number(data.height) || 64),
          Number(data.rotation) || 0,
          syncId,
          remoteUpdated
        );
      }
      return true;
    }

    if (entity === "borrower") {
      const existing = this.db.get<Record<string, unknown>>("SELECT * FROM borrowers WHERE sync_id = ?", syncId);
      if (existing && String(existing.updated_at || "") >= remoteUpdated) return false;
      if (deletedAt) {
        if (existing) {
          this.db.run("UPDATE borrowers SET deleted_at = ?, updated_at = ? WHERE id = ?", deletedAt, remoteUpdated, existing.id as number);
          return true;
        }
        return false;
      }
      const fullName = String(data.full_name || "").trim();
      if (!fullName) return false;
      if (existing) {
        this.db.run(
          `UPDATE borrowers SET full_name = ?, shiur_group = ?, phone = ?, notes = ?, updated_at = ?, deleted_at = NULL WHERE id = ?`,
          fullName,
          String(data.shiur_group || ""),
          String(data.phone || ""),
          String(data.notes || ""),
          remoteUpdated,
          existing.id as number
        );
      } else {
        this.db.run(
          `INSERT INTO borrowers (full_name, shiur_group, phone, notes, created_at, sync_id, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          fullName,
          String(data.shiur_group || ""),
          String(data.phone || ""),
          String(data.notes || ""),
          String(data.created_at || remoteUpdated),
          syncId,
          remoteUpdated
        );
      }
      return true;
    }

    if (entity === "book") {
      const existing = this.db.get<Record<string, unknown>>("SELECT * FROM books WHERE sync_id = ?", syncId);
      if (existing && String(existing.updated_at || "") >= remoteUpdated) return false;

      if (deletedAt) {
        if (existing) {
          this.db.run("UPDATE books SET deleted_at = ?, updated_at = ? WHERE sync_id = ?", deletedAt, remoteUpdated, syncId);
          return true;
        }
        return false;
      }

      const title = String(data.title || "").trim();
      if (!title) return false;

      const cabSyncId = data.cabinet_sync_id ? String(data.cabinet_sync_id).trim() : "";
      const cabCode = data.cabinet_code ? String(data.cabinet_code).trim() : "";
      let cabId: number | null = null;
      if (cabSyncId) {
        cabId = this.db.get<{ id: number }>("SELECT id FROM cabinets WHERE sync_id = ? AND deleted_at IS NULL", cabSyncId)?.id ?? null;
      }
      if (!cabId && cabCode) {
        cabId = this.db.get<{ id: number }>("SELECT id FROM cabinets WHERE code = ? AND deleted_at IS NULL", cabCode)?.id ?? null;
      }

      const tagsArr = parseTagsArray(data.tags);
      let targetBarcode = String(data.barcode || "").trim();
      let barcodeStatus = String(data.barcode_status || "assigned") === "pending_barcode" ? "pending_barcode" : "assigned";
      if (!targetBarcode) {
        targetBarcode = `MOB-${syncId.slice(0, 8).toUpperCase()}`;
        barcodeStatus = "pending_barcode";
      }

      // Guard against rare barcode collision across offline devices (free stale soft-deleted or untouched demo rows first)
      const collision = this.db.get<{ sync_id: string; deleted_at: string | null; title: string }>(
        "SELECT sync_id, deleted_at, title FROM books WHERE barcode = ?",
        targetBarcode
      );
      if (collision && collision.sync_id !== syncId) {
        if (collision.deleted_at) {
          this.db.run("DELETE FROM loans WHERE book_barcode = ?", targetBarcode);
          this.db.run("DELETE FROM books WHERE sync_id = ? AND deleted_at IS NOT NULL", collision.sync_id);
        } else {
          const isUntouchedDemoCollision =
            String(collision.sync_id || "").startsWith("demo-book-") ||
            (DEMO_BARCODE_SET.has(targetBarcode) && DEMO_TITLE_SET.has(String(collision.title || "").trim()));
          const colLoans =
            this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM loans WHERE book_barcode = ? AND deleted_at IS NULL", targetBarcode)?.c ?? 0;
          if (isUntouchedDemoCollision && colLoans === 0) {
            this.db.run("DELETE FROM loans WHERE book_barcode = ?", targetBarcode);
            this.db.run("DELETE FROM books WHERE sync_id = ?", collision.sync_id);
          } else {
            targetBarcode = `MOB-${syncId.slice(0, 8).toUpperCase()}`;
            barcodeStatus = "pending_barcode";
          }
        }
      }

      const norm = buildNormalizedBookSearch([
        targetBarcode,
        title,
        String(data.author || ""),
        String(data.volume || ""),
        String(data.publisher || ""),
        String(data.pub_year || ""),
        String(data.edition || ""),
        String(data.category || ""),
        tagsArr.join(" "),
        String(data.notes || ""),
      ]);

      let embBlob: Uint8Array | null | undefined = undefined;
      if (typeof data.embedding_b64 === "string" && data.embedding_b64.length > 0) {
        embBlob = Buffer.from(data.embedding_b64, "base64");
      }

      if (existing) {
        const oldBarcode = String(existing.barcode);
        if (oldBarcode !== targetBarcode) {
          this.db.exec("PRAGMA defer_foreign_keys = ON;");
          this.db.run("UPDATE loans SET book_barcode = ? WHERE book_barcode = ?", targetBarcode, oldBarcode);
        }
        this.db.run(
          `UPDATE books
           SET barcode = ?, title = ?, set_name = ?, author = ?, volume = ?, publisher = ?, pub_year = ?, edition = ?, category = ?,
               tags = ?, normalized_search = ?, cabinet_id = ?, shelf_number = ?, notes = ?, status = ?, label_printed = ?,
               format_size = ?, thickness_mm = ?, pages_count = ?, barcode_status = ?, updated_at = ?, deleted_at = NULL
               ${embBlob !== undefined ? ", embedding = ?" : ""}
           WHERE sync_id = ?`,
          targetBarcode,
          title,
          String(data.set_name || ""),
          String(data.author || ""),
          String(data.volume || ""),
          String(data.publisher || ""),
          String(data.pub_year || ""),
          String(data.edition || ""),
          String(data.category || ""),
          JSON.stringify(tagsArr),
          norm,
          cabId,
          data.shelf_number != null ? Number(data.shelf_number) : null,
          String(data.notes || ""),
          String(data.status || "available"),
          Number(data.label_printed) ? 1 : 0,
          String(data.format_size || ""),
          data.thickness_mm != null ? Number(data.thickness_mm) : null,
          data.pages_count != null ? Number(data.pages_count) : null,
          barcodeStatus,
          remoteUpdated,
          ...(embBlob !== undefined ? [embBlob] : []),
          syncId
        );
      } else {
        this.db.run(
          `INSERT INTO books
           (barcode, title, set_name, author, volume, publisher, pub_year, edition, category, tags, normalized_search, embedding,
            cabinet_id, shelf_number, notes, status, label_printed, created_at, format_size, thickness_mm, pages_count,
            barcode_status, sync_id, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          targetBarcode,
          title,
          String(data.set_name || ""),
          String(data.author || ""),
          String(data.volume || ""),
          String(data.publisher || ""),
          String(data.pub_year || ""),
          String(data.edition || ""),
          String(data.category || ""),
          JSON.stringify(tagsArr),
          norm,
          embBlob ?? null,
          cabId,
          data.shelf_number != null ? Number(data.shelf_number) : null,
          String(data.notes || ""),
          String(data.status || "available"),
          Number(data.label_printed) ? 1 : 0,
          String(data.created_at || remoteUpdated),
          String(data.format_size || ""),
          data.thickness_mm != null ? Number(data.thickness_mm) : null,
          data.pages_count != null ? Number(data.pages_count) : null,
          barcodeStatus,
          syncId,
          remoteUpdated
        );
      }
      return true;
    }

    if (entity === "loan") {
      const existing = this.db.get<Record<string, unknown>>("SELECT * FROM loans WHERE sync_id = ?", syncId);
      if (existing && String(existing.updated_at || "") >= remoteUpdated) return false;
      if (deletedAt) {
        if (existing) {
          this.db.run("UPDATE loans SET deleted_at = ?, updated_at = ? WHERE id = ?", deletedAt, remoteUpdated, existing.id as number);
          return true;
        }
        return false;
      }

      const bookSyncId = data.book_sync_id ? String(data.book_sync_id).trim() : "";
      const borrowerSyncId = data.borrower_sync_id ? String(data.borrower_sync_id).trim() : "";
      const bookRow =
        (bookSyncId ? this.db.get<{ barcode: string }>("SELECT barcode FROM books WHERE sync_id = ?", bookSyncId) : undefined) ||
        (data.book_barcode ? this.db.get<{ barcode: string }>("SELECT barcode FROM books WHERE barcode = ?", String(data.book_barcode)) : undefined);
      const borrowerRow = borrowerSyncId
        ? this.db.get<{ id: number }>("SELECT id FROM borrowers WHERE sync_id = ?", borrowerSyncId)
        : undefined;

      if (!bookRow || !borrowerRow) return false;

      const returnDate = data.return_date ? String(data.return_date) : null;
      if (existing) {
        this.db.run(
          "UPDATE loans SET book_barcode = ?, borrower_id = ?, loan_date = ?, due_date = ?, return_date = ?, updated_at = ?, deleted_at = NULL WHERE id = ?",
          bookRow.barcode,
          borrowerRow.id,
          String(data.loan_date || remoteUpdated),
          String(data.due_date || remoteUpdated),
          returnDate,
          remoteUpdated,
          existing.id as number
        );
      } else {
        this.db.run(
          "INSERT INTO loans (book_barcode, borrower_id, loan_date, due_date, return_date, sync_id, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
          bookRow.barcode,
          borrowerRow.id,
          String(data.loan_date || remoteUpdated),
          String(data.due_date || remoteUpdated),
          returnDate,
          syncId,
          remoteUpdated
        );
      }
      return true;
    }

    return false;
  }

  public async runRelayTest(): Promise<{ ok: boolean; relayId: string; localQueueId: number; deletedFromCloud: boolean }> {
    if (!this.connected || !this.firestore) {
      const conn = await this.connect();
      if (!conn.ok || !this.firestore) {
        throw new Error(conn.error || "Firebase אינו מחובר");
      }
    }
    const relayId = `test-relay-${Date.now()}`;
    // Valid 1x1 JPEG base64 test payload simulating compressed mobile capture
    const sampleJpegB64 =
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
    const firstCab = this.db.get<{ id: number; sync_id: string; code: string }>(
      "SELECT id, sync_id, code FROM cabinets WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1"
    );

    await setDoc(doc(this.firestore, "ai_relay_queue", relayId), {
      relay_id: relayId,
      image_base64: sampleJpegB64,
      mime_type: "image/jpeg",
      default_cabinet_sync_id: firstCab?.sync_id || null,
      default_cabinet_code: firstCab?.code || null,
      default_shelf_number: 2,
      created_at: new Date().toISOString(),
      device_id: "mobile-test-sim",
    });
    this.addSparkUsage({ writes: 1 });

    // Wait up to 12 seconds for real-time listener to ingest locally & delete from Firestore
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const localRow = this.db.get<{ id: number }>(
        "SELECT id FROM ai_catalog_queue WHERE source_relay_id = ?",
        relayId
      );
      if (localRow) {
        const cloudSnap = await getDoc(doc(this.firestore, "ai_relay_queue", relayId));
        this.addSparkUsage({ reads: 1 });
        if (!cloudSnap.exists()) {
          return {
            ok: true,
            relayId,
            localQueueId: localRow.id,
            deletedFromCloud: true,
          };
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("מסמך הניסוי עלה לענן אך לא נקלט/נמחק תוך 12 שניות");
  }

  public async cleanupDemoAndDuplicates(): Promise<{
    ok: boolean;
    deletedDemoBooks: number;
    deletedDuplicateBooks: number;
    deletedDemoBorrowers: number;
    deletedDemoCabinets: number;
    skippedWithLoans: number;
    status: FirebaseSyncStatus;
  }> {
    const allBooks = this.db.all<{
      barcode: string;
      title: string;
      author: string;
      volume: string;
      barcode_status: string;
      sync_id: string | null;
    }>("SELECT barcode, title, author, volume, barcode_status, sync_id FROM books WHERE deleted_at IS NULL");

    const assignedBySig = new Set<string>();
    for (const b of allBooks) {
      if (!String(b.barcode || "").startsWith("MOB-") && b.barcode_status !== "pending_barcode") {
        assignedBySig.add(`${String(b.title || "").trim()}|${String(b.author || "").trim()}|${String(b.volume || "").trim()}`);
      }
    }

    const demoCabSet = new Set<string>(DEMO_CABINET_CODES);
    const demoBorrowerSet = new Set<string>(DEMO_BORROWER_NAMES);
    const nowIso = new Date().toISOString();
    const cfg = this.loadConfig();

    let deletedDemoBooks = 0;
    let deletedDuplicateBooks = 0;
    let deletedDemoBorrowers = 0;
    let deletedDemoCabinets = 0;
    let skippedWithLoans = 0;

    this.db.transaction(() => {
      for (const b of allBooks) {
        const barcode = String(b.barcode || "").trim();
        const title = String(b.title || "").trim();
        const sid = String(b.sync_id || "").trim() || newSyncId();
        const isDemo =
          sid.startsWith("demo-book-") ||
          (DEMO_TITLE_SET.has(title) && (DEMO_BARCODE_SET.has(barcode) || barcode.startsWith("MOB-")));
        const sig = `${title}|${String(b.author || "").trim()}|${String(b.volume || "").trim()}`;
        const isMobDuplicate = barcode.startsWith("MOB-") && assignedBySig.has(sig);

        if (!isDemo && !isMobDuplicate) continue;

        const activeLoans =
          this.db.get<{ c: number }>(
            "SELECT COUNT(*) AS c FROM loans WHERE book_barcode = ? AND return_date IS NULL AND deleted_at IS NULL",
            barcode
          )?.c ?? 0;
        if (activeLoans > 0) {
          skippedWithLoans++;
          continue;
        }

        const loanRows = this.db.all<{ id: number; sync_id: string | null }>(
          "SELECT id, sync_id FROM loans WHERE book_barcode = ? AND deleted_at IS NULL",
          barcode
        );
        for (const lr of loanRows) {
          this.db.run("UPDATE loans SET deleted_at = ?, updated_at = ? WHERE id = ?", nowIso, nowIso, lr.id);
          if (cfg.enabled && lr.sync_id) {
            enqueueSyncOutbox(this.db, "loan", lr.sync_id, "delete", { deleted_at: nowIso });
          }
        }

        this.db.run(
          "UPDATE books SET deleted_at = ?, updated_at = ?, sync_id = COALESCE(sync_id, ?) WHERE barcode = ?",
          nowIso,
          nowIso,
          sid,
          barcode
        );
        if (cfg.enabled) {
          enqueueSyncOutbox(this.db, "book", sid, "delete", { barcode, deleted_at: nowIso });
        }
        if (isMobDuplicate && !isDemo) {
          deletedDuplicateBooks++;
        } else {
          deletedDemoBooks++;
        }
      }

      // Remove untouched demo borrowers with 0 loans
      const borrowers = this.db.all<{ id: number; full_name: string; sync_id: string | null }>(
        "SELECT id, full_name, sync_id FROM borrowers WHERE deleted_at IS NULL"
      );
      for (const br of borrowers) {
        const sid = String(br.sync_id || "").trim();
        if (!sid.startsWith("demo-borrower-") && !demoBorrowerSet.has(String(br.full_name || "").trim())) continue;
        const loanCount =
          this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM loans WHERE borrower_id = ? AND deleted_at IS NULL", br.id)?.c ?? 0;
        if (loanCount > 0) continue;
        this.db.run("UPDATE borrowers SET deleted_at = ?, updated_at = ? WHERE id = ?", nowIso, nowIso, br.id);
        if (cfg.enabled && sid) {
          enqueueSyncOutbox(this.db, "borrower", sid, "delete", { deleted_at: nowIso });
        }
        deletedDemoBorrowers++;
      }

      // Remove empty demo cabinets only if no active books remain in them
      const cabinets = this.db.all<{ id: number; code: string; sync_id: string | null }>(
        "SELECT id, code, sync_id FROM cabinets WHERE deleted_at IS NULL"
      );
      for (const cab of cabinets) {
        const sid = String(cab.sync_id || "").trim();
        if (!sid.startsWith("demo-cabinet-") && !demoCabSet.has(String(cab.code || "").trim())) continue;
        const booksInCab =
          this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM books WHERE cabinet_id = ? AND deleted_at IS NULL", cab.id)?.c ?? 0;
        if (booksInCab > 0) continue;
        this.db.run("UPDATE cabinets SET deleted_at = ?, updated_at = ? WHERE id = ?", nowIso, nowIso, cab.id);
        if (cfg.enabled && sid) {
          enqueueSyncOutbox(this.db, "cabinet", sid, "delete", { deleted_at: nowIso });
        }
        deletedDemoCabinets++;
      }

      const remainingBooks =
        this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM books WHERE deleted_at IS NULL")?.c ?? 0;
      if (remainingBooks === 0) {
        setSettingVal(this.db, "next_barcode", "100001");
      } else {
        reconcileNextBarcodeFromBooks(this.db);
      }
    });

    if (cfg.enabled && this.connected) {
      try {
        await this.syncNow();
      } catch {}
    }

    return {
      ok: true,
      deletedDemoBooks,
      deletedDuplicateBooks,
      deletedDemoBorrowers,
      deletedDemoCabinets,
      skippedWithLoans,
      status: this.getStatus(),
    };
  }

  public async getAiKeysBackupStatus(): Promise<{
    connected: boolean;
    exists: boolean;
    keysCount: number;
    updatedAt: string | null;
    aiModel: string | null;
  }> {
    if (!this.connected || !this.firestore) {
      return { connected: false, exists: false, keysCount: 0, updatedAt: null, aiModel: null };
    }
    const snap = await getDoc(doc(this.firestore, "library_meta", "ai_keys_backup"));
    this.addSparkUsage({ reads: 1 });
    if (!snap.exists()) {
      return { connected: true, exists: false, keysCount: 0, updatedAt: null, aiModel: null };
    }
    const d = snap.data() || {};
    return {
      connected: true,
      exists: true,
      keysCount: Number(d.keys_count) || 0,
      updatedAt: d.updated_at ? String(d.updated_at) : null,
      aiModel: d.ai_model ? String(d.ai_model) : null,
    };
  }

  public async backupAiKeysToCloud(passcodeRaw: string): Promise<{
    ok: boolean;
    keysCount: number;
    updatedAt: string;
  }> {
    const passcode = String(passcodeRaw || "").trim();
    if (passcode.length < 4) {
      throw new Error("יש להזין סיסמת הצפנה בת 4 תווים לפחות לגיבוי המפתחות");
    }
    if (!this.connected || !this.firestore) {
      const conn = await this.connect();
      if (!conn.ok || !this.firestore) {
        throw new Error(conn.error || "Firebase אינו מחובר");
      }
    }
    const settingsMap: Record<string, string> = {};
    for (const k of AI_BACKUP_KEYS) {
      const val = getSettingVal(this.db, k, "");
      if (val !== "") settingsMap[k] = val;
    }
    const keysCount = countUniqueAiKeysFromMap(settingsMap);
    if (keysCount === 0) {
      throw new Error("לא נמצאו מפתחות Gemini מוגדרים במחשב זה לגיבוי");
    }
    const updatedAt = new Date().toISOString();
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const iterations = 100000;
    const encKey = crypto.pbkdf2Sync(passcode, salt, iterations, 32, "sha256");
    const cipher = crypto.createCipheriv("aes-256-gcm", encKey, iv);
    const plaintext = Buffer.from(JSON.stringify({ version: 1, settings: settingsMap, updatedAt }), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    await setDoc(doc(this.firestore, "library_meta", "ai_keys_backup"), {
      format: "otzar-ai-keys-v1",
      cipher: "aes-256-gcm",
      kdf: "pbkdf2-sha256",
      iterations,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      auth_tag: authTag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      keys_count: keysCount,
      ai_model: settingsMap.ai_model || "gemini-4-hydrogen",
      updated_at: updatedAt,
      source_device: this.deviceId,
    });
    this.addSparkUsage({ writes: 1 });
    return { ok: true, keysCount, updatedAt };
  }

  public async restoreAiKeysFromCloud(passcodeRaw: string): Promise<{
    ok: boolean;
    keysCount: number;
    aiModel: string;
    updatedAt: string | null;
  }> {
    const passcode = String(passcodeRaw || "").trim();
    if (!passcode) {
      throw new Error("יש להזין את סיסמת הפענוח לשחזור המפתחות");
    }
    if (!this.connected || !this.firestore) {
      const conn = await this.connect();
      if (!conn.ok || !this.firestore) {
        throw new Error(conn.error || "Firebase אינו מחובר");
      }
    }
    const snap = await getDoc(doc(this.firestore, "library_meta", "ai_keys_backup"));
    this.addSparkUsage({ reads: 1 });
    if (!snap.exists()) {
      throw new Error("לא נמצא גיבוי מוצפן של מפתחות Gemini בענן");
    }
    const docData = snap.data() || {};
    if (
      docData.format !== "otzar-ai-keys-v1" ||
      !docData.salt ||
      !docData.iv ||
      !docData.auth_tag ||
      !docData.ciphertext
    ) {
      throw new Error("מבנה גיבוי המפתחות בענן אינו תקין");
    }
    let parsed: { version: number; settings: Record<string, string>; updatedAt?: string };
    try {
      const salt = Buffer.from(String(docData.salt), "base64");
      const iv = Buffer.from(String(docData.iv), "base64");
      const authTag = Buffer.from(String(docData.auth_tag), "base64");
      const ciphertext = Buffer.from(String(docData.ciphertext), "base64");
      const iterations = Math.min(500000, Math.max(10000, Number(docData.iterations) || 100000));
      const decKey = crypto.pbkdf2Sync(passcode, salt, iterations, 32, "sha256");
      const decipher = crypto.createDecipheriv("aes-256-gcm", decKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      parsed = JSON.parse(decrypted);
      if (!parsed || typeof parsed.settings !== "object") {
        throw new Error("invalid");
      }
    } catch {
      throw new Error("סיסמת הפענוח שגויה או שגיבוי המפתחות פגום");
    }

    this.db.transaction(() => {
      for (const k of AI_BACKUP_KEYS) {
        if (Object.prototype.hasOwnProperty.call(parsed.settings, k)) {
          setSettingVal(this.db, k, String(parsed.settings[k] ?? ""));
        }
      }
    });
    const keysCount = countUniqueAiKeysFromMap(parsed.settings);
    return {
      ok: true,
      keysCount,
      aiModel: parsed.settings.ai_model || "gemini-4-hydrogen",
      updatedAt: docData.updated_at ? String(docData.updated_at) : null,
    };
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.teardownClient();
  }
}