import crypto from "crypto";
import { GoogleGenAI, Type } from "@google/genai";
import type { DbClient } from "../db/adapter.ts";

export interface ExtractedBookMetadata {
  title: string;
  set_name?: string;
  sub_series?: string;
  set_global_number?: number | null;
  coverage_range?: string;
  author: string;
  volume: string;
  publisher: string;
  pub_year: string;
  edition: string;
  category: string;
  notes: string;
  tags: string[];
  canonical_author?: string;
  authority_suggestion?: { field: string; suggestion: string; confidence: number };
  authority_unified?: { field: string; original: string; matched: string };
}

export interface ExtractedShelfSetVolume {
  volume: string;
  sub_series?: string;
  set_global_number?: number | null;
  coverage_range?: string;
  copiesCount: number;
  notes?: string;
}

export interface ExtractedShelfSet {
  set_name: string;
  author: string;
  publisher: string;
  pub_year: string;
  edition: string;
  category: string;
  notes: string;
  tags: string[];
  volumes: ExtractedShelfSetVolume[];
}

export interface AiKeyEntry {
  id: string;
  label: string;
  apiKey: string;
  enabled: boolean;
}

export interface AiPoolKeyPublicStatus {
  id: string;
  label: string;
  maskedKey: string;
  enabled: boolean;
  status: "ready" | "cooldown" | "invalid" | "disabled";
  cooldownRemainingSec: number;
  callsLast60s: number;
  activeInFlight: number;
  totalRequests: number;
  lastUsedAt: string | null;
  lastError: string | null;
}

export interface AiRuntimeConfig {
  apiKey: string;
  hasAnyKey: boolean;
  aiModel: string;
  autoFallback: boolean;
  embeddingModel: string;
  delayMs: number;
}

const DEFAULT_VISION_FALLBACK_MODELS = [
  "gemini-3.5-flash",
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-4-hydrogen",
];

interface KeyRuntimeState {
  activeInFlight: number;
  recentTimestamps: number[];
  lastUsedAt: number;
  cooldownUntil: number;
  disabledInvalid: boolean;
  totalRequests: number;
  totalErrors: number;
  lastError: string | null;
}

const keyRuntimeMap = new Map<string, KeyRuntimeState>();

function getRuntimeKeyFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey.trim()).digest("hex").slice(0, 16);
}

function getRuntimeState(apiKey: string): KeyRuntimeState {
  const fp = getRuntimeKeyFingerprint(apiKey);
  let st = keyRuntimeMap.get(fp);
  if (!st) {
    st = {
      activeInFlight: 0,
      recentTimestamps: [],
      lastUsedAt: 0,
      cooldownUntil: 0,
      disabledInvalid: false,
      totalRequests: 0,
      totalErrors: 0,
      lastError: null,
    };
    keyRuntimeMap.set(fp, st);
  }
  const cutoff = Date.now() - 60_000;
  if (st.recentTimestamps.length > 0) {
    st.recentTimestamps = st.recentTimestamps.filter((t) => t > cutoff);
  }
  return st;
}

export function maskApiKey(raw: string): string {
  const k = raw.trim();
  if (k.length <= 8) return k ? "••••" : "";
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

function getSetting(db: DbClient, key: string, fallback = ""): string {
  return db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value ?? fallback;
}

export function getAiKeyPoolEntries(db: DbClient): AiKeyEntry[] {
  const rawPool = getSetting(db, "ai_keys_pool", "[]");
  const out: AiKeyEntry[] = [];
  try {
    const parsed = JSON.parse(rawPool);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const apiKey = String(item?.apiKey || "").trim();
        if (!apiKey) continue;
        out.push({
          id: String(item?.id || crypto.randomUUID()),
          label: String(item?.label || "").trim() || `חשבון ${out.length + 1}`,
          apiKey,
          enabled: item?.enabled !== false,
        });
      }
    }
  } catch {}

  if (out.length === 0) {
    const legacyKey = getSetting(db, "ai_api_key", "").trim();
    if (legacyKey) {
      out.push({ id: "legacy-local", label: "מפתח 1", apiKey: legacyKey, enabled: true });
    } else if (process.env.GEMINI_API_KEY?.trim()) {
      out.push({ id: "env-key", label: "מפתח מערכת", apiKey: process.env.GEMINI_API_KEY.trim(), enabled: true });
    }
  }
  return out;
}

export function hasConfiguredAiKeys(db: DbClient): boolean {
  return getAiKeyPoolEntries(db).some((k) => k.enabled && Boolean(k.apiKey));
}

export function saveAiKeyPool(
  db: DbClient,
  incoming: Array<{ id?: string; label?: string; apiKey?: string; enabled?: boolean }>
): AiKeyEntry[] {
  const existing = getAiKeyPoolEntries(db);
  const existingById = new Map(existing.map((e) => [e.id, e]));
  const saved: AiKeyEntry[] = [];
  const seenKeys = new Set<string>();

  for (const raw of incoming) {
    const id = String(raw?.id || "").trim() || crypto.randomUUID();
    const prev = existingById.get(id);
    const providedKey = typeof raw?.apiKey === "string" ? raw.apiKey.trim() : "";
    const resolvedKey = providedKey && !providedKey.includes("••••") ? providedKey : prev?.apiKey || "";
    if (!resolvedKey || seenKeys.has(resolvedKey)) continue;
    seenKeys.add(resolvedKey);

    // If user explicitly updated a key value, clear any prior invalid flag on it
    if (providedKey && !providedKey.includes("••••")) {
      const st = getRuntimeState(resolvedKey);
      st.disabledInvalid = false;
      st.cooldownUntil = 0;
      st.lastError = null;
    }

    saved.push({
      id,
      label: String(raw?.label || "").trim() || `חשבון ${saved.length + 1}`,
      apiKey: resolvedKey,
      enabled: raw?.enabled !== false,
    });
  }

  db.transaction(() => {
    db.run(
      "INSERT INTO settings (key, value) VALUES ('ai_keys_pool', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(saved)
    );
    // Keep ai_api_key synced with first enabled key only as legacy indicator (empty if none)
    const firstActive = saved.find((k) => k.enabled)?.apiKey || "";
    db.run(
      "INSERT INTO settings (key, value) VALUES ('ai_api_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      firstActive
    );
  });

  return saved;
}

export function getAiKeyPoolPublicStatus(db: DbClient): AiPoolKeyPublicStatus[] {
  const entries = getAiKeyPoolEntries(db);
  const now = Date.now();
  return entries.map((entry) => {
    const st = getRuntimeState(entry.apiKey);
    const cooldownRemainingSec = st.cooldownUntil > now ? Math.ceil((st.cooldownUntil - now) / 1000) : 0;
    let status: AiPoolKeyPublicStatus["status"] = "ready";
    if (!entry.enabled) status = "disabled";
    else if (st.disabledInvalid) status = "invalid";
    else if (cooldownRemainingSec > 0) status = "cooldown";

    return {
      id: entry.id,
      label: entry.label,
      maskedKey: maskApiKey(entry.apiKey),
      enabled: entry.enabled,
      status,
      cooldownRemainingSec,
      callsLast60s: st.recentTimestamps.length,
      activeInFlight: st.activeInFlight,
      totalRequests: st.totalRequests,
      lastUsedAt: st.lastUsedAt > 0 ? new Date(st.lastUsedAt).toISOString() : null,
      lastError: st.lastError,
    };
  });
}

export function getAiConfig(db: DbClient): AiRuntimeConfig {
  const entries = getAiKeyPoolEntries(db).filter((k) => k.enabled);
  const envKey = (process.env.GEMINI_API_KEY || "").trim();
  const primaryCandidate = entries[0]?.apiKey || envKey;

  return {
    apiKey: primaryCandidate,
    hasAnyKey: entries.length > 0 || Boolean(envKey),
    aiModel: getSetting(db, "ai_model", "gemini-3.5-flash").trim() || "gemini-3.5-flash",
    autoFallback: getSetting(db, "ai_auto_fallback", "true").trim() !== "false",
    embeddingModel: getSetting(db, "embedding_model", "gemini-embedding-001").trim() || "gemini-embedding-001",
    delayMs: Math.max(500, Number(getSetting(db, "ai_delay_ms", "4200")) || 4200),
  };
}

function createClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

export type GeminiErrorKind = "quota" | "overloaded" | "invalid_key" | "network" | "model" | "timeout" | "other";

export function classifyGeminiError(err: unknown): GeminiErrorKind {
  const msg = String((err as { message?: string })?.message || err || "").toLowerCase();
  if (
    msg.includes("fetch failed") ||
    msg.includes("enotfound") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("certificate") ||
    msg.includes("self-signed") ||
    msg.includes("network")
  ) {
    return "network";
  }
  if (
    msg.includes("503") ||
    msg.includes("unavailable") ||
    msg.includes("high demand") ||
    msg.includes("overloaded") ||
    msg.includes("temporarily unavailable") ||
    msg.includes("try again later") ||
    msg.includes("500") ||
    msg.includes("internal error") ||
    msg.includes("deadline_exceeded")
  ) {
    return "overloaded";
  }
  if (msg.includes("429") || msg.includes("resource_exhausted") || msg.includes("quota") || msg.includes("rate limit")) {
    return "quota";
  }
  if (
    msg.includes("403") ||
    msg.includes("permission_denied") ||
    msg.includes("api_key_invalid") ||
    msg.includes("api key not valid") ||
    msg.includes("401")
  ) {
    return "invalid_key";
  }
  if (msg.includes("404") || msg.includes("not_found")) {
    return "model";
  }
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("aborted") || msg.includes("aborterror")) {
    return "timeout";
  }
  return "other";
}

export function markApiKeySlowCooldown(apiKey: string, durationMs = 25_000, reason = "השהיה זמנית עקב חשיבה ארוכה / החלפה ידנית"): void {
  if (!apiKey) return;
  const st = getRuntimeState(apiKey);
  st.cooldownUntil = Math.max(st.cooldownUntil, Date.now() + durationMs);
  st.lastError = reason;
}

export function formatGeminiError(err: unknown): string {
  const msg = String((err as { message?: string })?.message || err || "");
  const kind = classifyGeminiError(err);
  if (kind === "timeout") {
    return "פג זמן ההמתנה לפענוח (Timeout) — ניתן לנסות שוב או להחליף מפתח בלחצן הרענון.";
  }
  if (kind === "invalid_key") {
    return "מפתח ה-API אינו תקין או שנדחתה ההרשאה (403). בדוק את המפתחות ברולטה בהגדרות.";
  }
  if (kind === "overloaded") {
    return "עומס זמני בשרתי המודל (503). המערכת ניסתה אוטומטית גם מפתחות ומודלי גיבוי — לחץ \"נסה שנית\" בעוד מספר רגעים.";
  }
  if (kind === "quota") {
    return "חריגה ממגבלת הבקשות הזמנית (429). המפתחות בהשהיה זמנית — המתן מעט או הוסף מפתח נוסף מחשבון אחר.";
  }
  if (kind === "model") {
    return "שם המודל שהוגדר אינו זמין (404). ניתן לבחור מודל אחר בהגדרות (למשל gemini-3.5-flash או gemini-2.5-flash).";
  }
  if (kind === "network") {
    return "אין חיבור זמין לשרתי Gemini (מצב אופליין או חסימת/תעודת סינון רשת כמו אתרוג).";
  }
  return msg || "שגיאה לא צפויה בפנייה ל-Gemini";
}

function selectLeastLoadedKey(entries: AiKeyEntry[], excludedKeys: Set<string>): AiKeyEntry | null {
  const now = Date.now();
  const candidates = entries.filter((e) => {
    if (!e.enabled || excludedKeys.has(e.apiKey)) return false;
    const st = getRuntimeState(e.apiKey);
    if (st.disabledInvalid) return false;
    if (st.cooldownUntil > now) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Pure Least-Recently-Used & Lowest-Recent-Load selection (no fixed primary key!)
  candidates.sort((a, b) => {
    const sa = getRuntimeState(a.apiKey);
    const sb = getRuntimeState(b.apiKey);
    if (sa.activeInFlight !== sb.activeInFlight) return sa.activeInFlight - sb.activeInFlight;
    if (sa.recentTimestamps.length !== sb.recentTimestamps.length) {
      return sa.recentTimestamps.length - sb.recentTimestamps.length;
    }
    return sa.lastUsedAt - sb.lastUsedAt;
  });

  return candidates[0];
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWithKeyRoulette<T>(
  db: DbClient,
  task: (apiKey: string, entry: AiKeyEntry, signal: AbortSignal) => Promise<T>,
  options?: {
    maxOverloadRetries?: number;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    onKeyPicked?: (entry: AiKeyEntry) => void;
  }
): Promise<{ result: T; usedEntry: AiKeyEntry }> {
  const entries = getAiKeyPoolEntries(db).filter((k) => k.enabled);
  if (entries.length === 0) {
    throw new Error("לא הוגדרו מפתחות Gemini API פעילים בהגדרות המערכת");
  }
  if (options?.abortSignal?.aborted) {
    throw new Error("aborted");
  }

  const tried = new Set<string>();
  let lastErr: unknown = null;
  let overloadAttempts = 0;
  const maxOverloadRetries = options?.maxOverloadRetries ?? 2;

  while (tried.size < entries.length) {
    if (options?.abortSignal?.aborted) {
      throw new Error("aborted");
    }
    const picked = selectLeastLoadedKey(entries, tried);
    if (!picked) break;

    tried.add(picked.apiKey);
    options?.onKeyPicked?.(picked);
    const st = getRuntimeState(picked.apiKey);
    const now = Date.now();
    st.activeInFlight += 1;
    st.recentTimestamps.push(now);
    st.lastUsedAt = now;
    st.totalRequests += 1;

    const attemptController = new AbortController();
    let timedOut = false;
    let userAborted = false;

    const onExternalAbort = () => {
      userAborted = true;
      attemptController.abort(new Error("aborted"));
    };
    if (options?.abortSignal) {
      options.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer =
      options?.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            attemptController.abort(new Error("timeout"));
          }, options.timeoutMs)
        : null;

    try {
      const taskPromise = task(picked.apiKey, picked, attemptController.signal);
      const racePromise =
        options?.timeoutMs && options.timeoutMs > 0
          ? Promise.race([
              taskPromise,
              new Promise<T>((_, reject) => {
                attemptController.signal.addEventListener(
                  "abort",
                  () => reject(new Error(userAborted ? "aborted" : "timeout")),
                  { once: true }
                );
              }),
            ])
          : taskPromise;

      const result = await racePromise;
      st.lastError = null;
      st.disabledInvalid = false;
      return { result, usedEntry: picked };
    } catch (err) {
      lastErr = err;
      st.totalErrors += 1;
      if (userAborted || options?.abortSignal?.aborted) {
        st.cooldownUntil = Math.max(st.cooldownUntil, Date.now() + 20_000);
        st.lastError = "הופסק ידנית לצורך רענון והחלפת מפתח";
        throw err;
      }
      const kind = timedOut ? "timeout" : classifyGeminiError(err);
      if (kind === "timeout") {
        st.cooldownUntil = Date.now() + 30_000;
        st.lastError = "חשיבה ארוכה מדי (Timeout) — המפתח הועבר להשהיה קצרה";
        if (tried.size < entries.length) {
          continue; // Rotate immediately to next healthy key!
        }
        throw new Error("timeout: פג זמן ההמתנה לפענוח ב-Gemini");
      }
      if (kind === "quota") {
        st.cooldownUntil = Date.now() + 60_000;
        st.lastError = "השהיה זמנית (60 שניות) עקב חריגת מכסה (429)";
        continue; // Try next least-loaded healthy key in the roulette
      }
      if (kind === "invalid_key") {
        st.disabledInvalid = true;
        st.lastError = "מפתח לא תקין או חסר הרשאה (403)";
        continue; // Try next key in the roulette
      }
      if (kind === "overloaded") {
        overloadAttempts += 1;
        st.lastError = "עומס רגעי בשרת המודל (503)";
        if (overloadAttempts < maxOverloadRetries && tried.size < entries.length) {
          await waitMs(650 + Math.round(Math.random() * 550));
          continue;
        }
        throw err;
      }
      if (kind === "network" || kind === "model") {
        st.lastError = formatGeminiError(err);
        throw err;
      }
      st.lastError = formatGeminiError(err);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      if (options?.abortSignal) {
        options.abortSignal.removeEventListener("abort", onExternalAbort);
      }
      st.activeInFlight = Math.max(0, st.activeInFlight - 1);
    }
  }

  // If all keys were exhausted/cooled down, surface clear explanation
  if (lastErr) throw lastErr;

  const now = Date.now();
  const cooldownLeft = entries
    .map((e) => getRuntimeState(e.apiKey))
    .filter((s) => !s.disabledInvalid && s.cooldownUntil > now)
    .map((s) => Math.ceil((s.cooldownUntil - now) / 1000));

  if (cooldownLeft.length > 0) {
    const minSec = Math.min(...cooldownLeft);
    throw new Error(`כל מפתחות ה-API בהשהיית מכסה זמנית (המפתח הבא יתפנה בעוד ${minSec} שניות).`);
  }
  throw new Error("אין מפתח API תקין זמין ברולטה כרגע. בדוק את תקינות המפתחות בהגדרות.");
}

export async function executeWithModelAndKeyFallback<T>(
  db: DbClient,
  primaryModel: string,
  allowFallback: boolean,
  task: (apiKey: string, modelName: string, entry: AiKeyEntry, signal: AbortSignal) => Promise<T>,
  options?: { abortSignal?: AbortSignal; timeoutMs?: number; onKeyPicked?: (entry: AiKeyEntry) => void }
): Promise<{ result: T; usedEntry: AiKeyEntry; usedModel: string; usedFallback: boolean }> {
  const cleanPrimary = primaryModel.trim() || "gemini-3.5-flash";
  const modelChain = allowFallback
    ? [cleanPrimary, ...DEFAULT_VISION_FALLBACK_MODELS.filter((m) => m !== cleanPrimary)]
    : [cleanPrimary];

  let lastErr: unknown = null;
  for (let i = 0; i < modelChain.length; i++) {
    if (options?.abortSignal?.aborted) {
      throw new Error("aborted");
    }
    const modelName = modelChain[i];
    const hasNext = i < modelChain.length - 1;
    try {
      const { result, usedEntry } = await executeWithKeyRoulette(
        db,
        (apiKey, entry, signal) => task(apiKey, modelName, entry, signal),
        {
          maxOverloadRetries: hasNext ? 1 : 2,
          abortSignal: options?.abortSignal,
          timeoutMs: options?.timeoutMs,
          onKeyPicked: options?.onKeyPicked,
        }
      );
      return {
        result,
        usedEntry,
        usedModel: modelName,
        usedFallback: modelName !== cleanPrimary,
      };
    } catch (err) {
      if (options?.abortSignal?.aborted) {
        throw err;
      }
      lastErr = err;
      const kind = classifyGeminiError(err);
      if (allowFallback && hasNext && (kind === "overloaded" || kind === "model" || kind === "timeout")) {
        console.warn(`[AI] Model ${modelName} failed (${kind}); failing over to ${modelChain[i + 1]}`);
        await waitMs(350);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("שגיאה בפנייה למודל ה-AI");
}

export async function testSinglePoolKey(
  db: DbClient,
  idOrRawKey: string
): Promise<{ ok: boolean; model: string; latencyMs: number; message: string }> {
  const cfg = getAiConfig(db);
  const entries = getAiKeyPoolEntries(db);
  const found = entries.find((e) => e.id === idOrRawKey || e.apiKey === idOrRawKey);
  const keyToTest = found?.apiKey || (idOrRawKey.startsWith("AIza") ? idOrRawKey : "");
  if (!keyToTest) {
    return { ok: false, model: cfg.aiModel, latencyMs: 0, message: "המפתח לא נמצא לבדיקה" };
  }
  const t0 = Date.now();
  const st = getRuntimeState(keyToTest);
  const modelsToTry = cfg.autoFallback
    ? [cfg.aiModel, ...DEFAULT_VISION_FALLBACK_MODELS.filter((m) => m !== cfg.aiModel).slice(0, 2)]
    : [cfg.aiModel];

  let lastErr: unknown = null;
  for (let i = 0; i < modelsToTry.length; i++) {
    const modelName = modelsToTry[i];
    try {
      const ai = createClient(keyToTest);
      const resp = await ai.models.generateContent({
        model: modelName,
        contents: "השב במילה אחת בעברית: תקין",
      });
      const reply = (resp.text || "").trim();
      st.disabledInvalid = false;
      st.cooldownUntil = 0;
      st.lastError = null;
      st.lastUsedAt = Date.now();
      st.totalRequests += 1;
      const fallbackNote = modelName !== cfg.aiModel ? ` (נבדק דרך מודל גיבוי ${modelName} עקב עומס ב-${cfg.aiModel})` : "";
      return {
        ok: true,
        model: modelName,
        latencyMs: Date.now() - t0,
        message: `${found?.label || "המפתח"} תקין ומחובר${fallbackNote} (תגובה: ${reply || "OK"})`,
      };
    } catch (err) {
      lastErr = err;
      const kind = classifyGeminiError(err);
      if (i < modelsToTry.length - 1 && (kind === "overloaded" || kind === "model")) {
        continue;
      }
      break;
    }
  }

  const kind = classifyGeminiError(lastErr);
  const msg = formatGeminiError(lastErr);
  if (kind === "invalid_key") st.disabledInvalid = true;
  if (kind === "quota") st.cooldownUntil = Date.now() + 60_000;
  st.lastError = msg;
  return { ok: false, model: cfg.aiModel, latencyMs: Date.now() - t0, message: msg };
}

export async function testGeminiConnection(
  db: DbClient
): Promise<{ ok: boolean; model: string; latencyMs: number; message: string; usedLabel?: string }> {
  const cfg = getAiConfig(db);
  if (!cfg.hasAnyKey) {
    return {
      ok: false,
      model: cfg.aiModel,
      latencyMs: 0,
      message: "לא הוגדר אף מפתח Gemini API בהגדרות.",
    };
  }
  const t0 = Date.now();
  try {
    const { result, usedEntry, usedModel, usedFallback } = await executeWithModelAndKeyFallback(
      db,
      cfg.aiModel,
      cfg.autoFallback,
      async (apiKey, modelName) => {
        const ai = createClient(apiKey);
        const resp = await ai.models.generateContent({
          model: modelName,
          contents: "השב במילה אחת בעברית: תקין",
        });
        return (resp.text || "").trim();
      }
    );
    const fallbackNote = usedFallback ? ` · מודל גיבוי: ${usedModel}` : "";
    return {
      ok: true,
      model: usedModel,
      latencyMs: Date.now() - t0,
      usedLabel: usedEntry.label,
      message: `החיבור תקין דרך ${usedEntry.label}${fallbackNote} (תגובה: ${result || "OK"})`,
    };
  } catch (err) {
    return {
      ok: false,
      model: cfg.aiModel,
      latencyMs: Date.now() - t0,
      message: formatGeminiError(err),
    };
  }
}

export interface CoverImagePart {
  buffer: Buffer;
  mimeType?: string;
}

export async function analyzeBookCoverImage(
  db: DbClient,
  imageInput: Buffer | CoverImagePart[],
  mimeType = "image/jpeg",
  options?: { abortSignal?: AbortSignal; timeoutMs?: number; customPrompt?: string; onKeyPicked?: (entry: AiKeyEntry) => void }
): Promise<ExtractedBookMetadata> {
  const cfg = getAiConfig(db);
  if (!cfg.hasAnyKey) {
    throw new Error("לא הוגדר מפתח Gemini API בהגדרות המערכת");
  }
  const images = Array.isArray(imageInput)
    ? imageInput
    : [{ buffer: imageInput, mimeType }];
  if (images.length === 0) {
    throw new Error("לא סופקו תמונות לפענוח");
  }

  const systemPrompt =
    "אתה ספרן תורני מומחה בישיבה. תפקידך לפענח צילומי שערי ספרים תורניים (כולל אותיות מרובעות, כתב רש״י וראשי תיבות תורניים כמו שו״ע, רמב״ם, משנ״ב, ש״ס, שו״ת). אם מצורפות מספר תמונות, כולן דפים שונים של אותו ספר (למשל שער ראשי, גב שער עם שנת הוצאה ומהדורה, כריכה, שדרה או תוכן עניינים) — מזג את הפרטים מכל התמונות לרשומה אחת מלאה ומדויקת. הפרד בין שם הסט הגדול (set_name), תת-הסדרה/חלק ראשי/מסכת בתוך הסט אם יש היררכיה (sub_series, כגון 'מסכת שבת' או 'אורח חיים'), סימון הכרך המדויק כפי שמופיע על הספר גם אם בכוכביות/ספרות רומיות/אותיות (volume, למשל 'חלק א׳', '**', 'II'), המספר הכללי של הכרך בסדרה הגדולה אם צוין (set_global_number, מספר שלם או 0 אם לא ידוע), וטווח הסימנים/דפים/פרקים שהכרך מכסה אם מופיע על השער או בתוכן (coverage_range, כגון 'סימנים א׳–קנ״ב' או 'דפים ב׳–ל״ו'). החזר JSON מדויק בלבד בעברית.";

  const baseUserPrompt =
    "פענח את דפי הספר המצולמים וחלץ: title, set_name, sub_series, set_global_number, volume, coverage_range, author, publisher, pub_year, edition, category, notes, ו-5 עד 10 tags. אם שדה לא מופיע באף תמונה השאר מחרוזת ריקה (או 0 עבור set_global_number).";
  const userPrompt = options?.customPrompt?.trim()
    ? `${baseUserPrompt}\nהנחיית עריכה מיוחדת מהמשתמש: ${options.customPrompt.trim()}`
    : baseUserPrompt;

  const imageParts = images.map((img) => ({
    inlineData: {
      mimeType: img.mimeType || "image/jpeg",
      data: img.buffer.toString("base64"),
    },
  }));

  const { result: response } = await executeWithModelAndKeyFallback(
    db,
    cfg.aiModel,
    cfg.autoFallback,
    async (apiKey, activeModel, _entry, signal) => {
      const ai = createClient(apiKey);
      return ai.models.generateContent({
        model: activeModel,
        contents: {
          parts: [
            ...imageParts,
            { text: userPrompt },
          ],
        },
        config: {
          abortSignal: signal,
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: "שם הספר המלא" },
              set_name: { type: Type.STRING, description: "שם הסט או הסדרה הראשית אם הספר שייך לסט רב-כרכי, ריק אם ספר בודד" },
              sub_series: { type: Type.STRING, description: "תת-סדרה, מסכת או חטיבה בתוך הסט (כגון 'מסכת שבת' או 'אורח חיים'), ריק אם אין" },
              set_global_number: { type: Type.INTEGER, description: "מספר הכרך הכללי בסדרה הגדולה (מספר שלם בלבד, או 0 אם לא ידוע)" },
              volume: { type: Type.STRING, description: "סימון הכרך/חלק המדויק כפי שמופיע בספר (*, **, II, חלק א׳, כרך ב׳ וכו׳)" },
              coverage_range: { type: Type.STRING, description: "טווח סימנים, דפים, פרקים או עמודים (כגון 'סימנים א׳–קנ״ב' או 'דפים ב׳–ס״ד'), ריק אם אין" },
              author: { type: Type.STRING, description: "שם המחבר או המפרש" },
              publisher: { type: Type.STRING, description: "הוצאה לאור או מכון" },
              pub_year: { type: Type.STRING, description: "שנת הוצאה (עברי או לועזי) אם מופיעה בשער" },
              edition: { type: Type.STRING, description: "מהדורה אם מופיעה בשער" },
              category: { type: Type.STRING, description: "קטגוריה ראשית באוצר הספרים" },
              notes: { type: Type.STRING, description: "פרטי מהדורה או מפרשים עיקריים" },
              tags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "5 עד 10 תגיות נושא, כינויים וראשי תיבות לחיפוש",
              },
            },
            required: ["title", "author", "volume", "publisher", "pub_year", "edition", "category", "notes", "tags"],
          },
        },
      });
    },
    { abortSignal: options?.abortSignal, timeoutMs: options?.timeoutMs ?? 45_000, onKeyPicked: options?.onKeyPicked }
  );

  const rawText = (response.text || "{}").trim();
  const parsed = JSON.parse(rawText) as Partial<ExtractedBookMetadata>;
  const rawGlobalNum = Number(parsed.set_global_number);

  return {
    title: String(parsed.title || "").trim(),
    set_name: String(parsed.set_name || "").trim(),
    sub_series: String(parsed.sub_series || "").trim(),
    set_global_number: Number.isFinite(rawGlobalNum) && rawGlobalNum > 0 ? Math.round(rawGlobalNum) : null,
    coverage_range: String(parsed.coverage_range || "").trim(),
    author: String(parsed.author || "").trim(),
    volume: String(parsed.volume || "").trim(),
    publisher: String(parsed.publisher || "").trim(),
    pub_year: String(parsed.pub_year || "").trim(),
    edition: String(parsed.edition || "").trim(),
    category: String(parsed.category || "").trim() || "כללי",
    notes: String(parsed.notes || "").trim(),
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
      : [],
  };
}


export interface ExistingSetContext {
  set_name?: string;
  author?: string;
  publisher?: string;
  pub_year?: string;
  edition?: string;
  category?: string;
  tags?: string[];
}

export async function analyzeShelfSetImages(
  db: DbClient,
  titlePageInput: CoverImagePart | CoverImagePart[],
  spineImageParts: CoverImagePart[],
  existingSetContext?: ExistingSetContext,
  options?: { abortSignal?: AbortSignal; timeoutMs?: number; onKeyPicked?: (entry: AiKeyEntry) => void }
): Promise<ExtractedShelfSet> {
  const cfg = getAiConfig(db);
  if (!cfg.hasAnyKey) {
    throw new Error("לא הוגדר מפתח Gemini API בהגדרות המערכת");
  }

  const titleParts = Array.isArray(titlePageInput)
    ? titlePageInput
    : titlePageInput
    ? [titlePageInput]
    : [];
  const allParts = [
    ...titleParts.map((p) => ({
      inlineData: {
        mimeType: p.mimeType || "image/jpeg",
        data: p.buffer.toString("base64"),
      },
    })),
    ...spineImageParts.map((p) => ({
      inlineData: {
        mimeType: p.mimeType || "image/jpeg",
        data: p.buffer.toString("base64"),
      },
    })),
  ];
  if (allParts.length === 0) {
    throw new Error("לא סופקו תמונות לפענוח הסט");
  }
  const systemPrompt =
    titleParts.length === 0 && existingSetContext?.set_name
      ? `אתה ספרן תורני מומחה בישיבה. לפניך ${spineImageParts.length} תמונות של שדרות כרכים נוספים מהסט הקיים "${existingSetContext.set_name}" (מחבר: ${existingSetContext.author || "לא צוין"}, הוצאה: ${existingSetContext.publisher || "לא צוינה"}). פרטי הסט הכלליים כבר שמורים במאגר ואין תמונת שער מצורפת.\nתפקידך:\n1. השאר את פרטי הסט הכלליים כפי שסופקו (או השלם קטגוריה ותגיות אם חסר).\n2. זהה בעיון מתוך שדרות הספרים שעל המדף לפי הסדר מהמדף את רשימת כל הכרכים והחלקים המופיעים בתמונות אלו (volumes). לכל כרך ציין: volume (הסימון על השדרה גם אם *, **, II, א׳-1, ברכות), sub_series (אם יש תת-סדרה/מסכת, כגון 'מסכת שבת' או 'אורח חיים'), set_global_number (מספר סידורי כללי בסדרה אם מופיע על השדרה, אחרת 0), ו-coverage_range (טווח סימנים/דפים/פרקים אם נראה על השדרה). אם כרך מופיע פעמיים, ציין copiesCount: 2.`
      : `אתה ספרן תורני מומחה בישיבה. לפניך ${allParts.length} צילומים של סט ספרים: ${titleParts.length === 1 ? "התמונה הראשונה היא עמוד שער מייצג של הסט" : `${titleParts.length} התמונות הראשונות הן צילומי השער ופרטי המהדורה/ההוצאה של הסט (כגון עמוד שער ראשי, גב השער, דף הסכמות)`}, ושאר ${spineImageParts.length} התמונות הן צילום שדרות כרכי הסט העומדים על המדף בספרייה.\nתפקידך:\n1. מזג את המידע מכל תמונות השער והפרטים וחלץ את פרטי הסט הכלליים: שם הסט (set_name), שם המחבר/מפרש (author), הוצאה/מכון (publisher), שנת הוצאה (pub_year), מהדורה (edition), קטגוריה ראשית (category), הערות (notes) ותגיות (tags).\n2. זהה בעיון מתוך שדרות הספרים שעל המדף את רשימת כל הכרכים המופיעים לפי סדר עמידתם על המדף (volumes). לכל כרך חלץ גם sub_series (תת-סדרה/מסכת אם קיימת), set_global_number (מספר כרך כללי אם מצוין על השדרה, אחרת 0), ו-coverage_range (טווח סימנים/דפים אם כתוב על השדרה). אם כרך מסוים מופיע פעמיים על המדף, ציין copiesCount: 2.`;
  const userPrompt =
    titleParts.length === 0 && existingSetContext?.set_name
      ? `פענח את תמונות השדרות של הסט הקיים "${existingSetContext.set_name}" וחלץ את רשימת כל הכרכים והעותקים שעל המדף בפורמט JSON מדויק.`
      : "פענח את צילומי השער והפרטים ואת צילומי השדרות של הסט, וחלץ את פרטי הסט ורשימת כל הכרכים שעל המדף בפורמט JSON מדויק.";
  const { result: response } = await executeWithModelAndKeyFallback(
    db,
    cfg.aiModel,
    cfg.autoFallback,
    async (apiKey, activeModel, _entry, signal) => {
      const ai = createClient(apiKey);
      return ai.models.generateContent({
        model: activeModel,
        contents: {
          parts: [...allParts, { text: userPrompt }],
        },
        config: {
          abortSignal: signal,
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              set_name: { type: Type.STRING, description: "שם הסט או הסדרה" },
              author: { type: Type.STRING, description: "שם המחבר או המפרש הראשי" },
              publisher: { type: Type.STRING, description: "הוצאה לאור או מכון" },
              pub_year: { type: Type.STRING, description: "שנת הוצאה אם מופיעה בשער" },
              edition: { type: Type.STRING, description: "מהדורה" },
              category: { type: Type.STRING, description: "קטגוריה ראשית" },
              notes: { type: Type.STRING, description: "הערות" },
              tags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "5 עד 10 תגיות חיפוש",
              },
              volumes: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    volume: { type: Type.STRING, description: "סימון הכרך או החלק כפי שמופיע בשדרה (*, **, II, א׳, כרך ג׳ וכו׳)" },
                    sub_series: { type: Type.STRING, description: "תת-סדרה, מסכת או חטיבה בתוך הסט אם קיימת" },
                    set_global_number: { type: Type.INTEGER, description: "מספר כרך כללי בסדרה הגדולה (מספר שלם או 0 אם אין)" },
                    coverage_range: { type: Type.STRING, description: "טווח סימנים, דפים או פרקים אם נראה על השדרה" },
                    copiesCount: { type: Type.INTEGER, description: "מספר העותקים של כרך זה שנראים על המדף (ברירת מחדל 1)" },
                    notes: { type: Type.STRING, description: "הערה על הכרך במידה ויש" },
                  },
                  required: ["volume"],
                },
                description: "רשימת הכרכים שעל המדף לפי סדר הופעתם על המדף",
              },
            },
            required: ["set_name", "author", "publisher", "category", "volumes"],
          },
        },
      });
    },
    { abortSignal: options?.abortSignal, timeoutMs: options?.timeoutMs ?? 60_000, onKeyPicked: options?.onKeyPicked }
  );

  const rawText = (response.text || "{}").trim();
  const parsed = JSON.parse(rawText) as Partial<ExtractedShelfSet>;
  const rawVolumes = Array.isArray(parsed.volumes) ? parsed.volumes : [];
  return {
    set_name: String(parsed.set_name || existingSetContext?.set_name || "").trim(),
    author: String(parsed.author || existingSetContext?.author || "").trim(),
    publisher: String(parsed.publisher || existingSetContext?.publisher || "").trim(),
    pub_year: String(parsed.pub_year || existingSetContext?.pub_year || "").trim(),
    edition: String(parsed.edition || existingSetContext?.edition || "").trim(),
    category: String(parsed.category || "").trim() || "כללי",
    notes: String(parsed.notes || "").trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    volumes: rawVolumes.map((v) => {
      const gn = Number(v.set_global_number);
      return {
        volume: String(v.volume || "").trim(),
        sub_series: v.sub_series ? String(v.sub_series).trim() : "",
        set_global_number: Number.isFinite(gn) && gn > 0 ? Math.round(gn) : null,
        coverage_range: v.coverage_range ? String(v.coverage_range).trim() : "",
        copiesCount: Math.max(1, Number(v.copiesCount) || 1),
        notes: v.notes ? String(v.notes).trim() : undefined,
      };
    }),
  };
}

export async function generateTextEmbedding(db: DbClient, text: string): Promise<Float32Array> {
  const cfg = getAiConfig(db);
  if (!cfg.hasAnyKey) {
    throw new Error("לא הוגדר מפתח Gemini API");
  }
  const cleanText = String(text || "").trim();
  if (!cleanText) {
    throw new Error("טקסט ריק לאינדוקס");
  }

  const { result } = await executeWithKeyRoulette(db, async (apiKey) => {
    const ai = createClient(apiKey);
    return ai.models.embedContent({
      model: cfg.embeddingModel || "gemini-embedding-001",
      contents: cleanText,
      config: {
        outputDimensionality: 768,
      },
    });
  });

  const values = result.embeddings?.[0]?.values;
  if (!values || values.length === 0) {
    throw new Error("לא התקבל וקטור ממודל ה-Embeddings");
  }
  return Float32Array.from(values);
}

export function float32ToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToFloat32(raw: unknown): Float32Array | null {
  if (!raw) return null;
  try {
    if (raw instanceof Float32Array) return raw;
    if (Buffer.isBuffer(raw)) {
      if (raw.byteLength < 4 || raw.byteLength % 4 !== 0) return null;
      const copy = Buffer.from(raw);
      return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
    }
    if (raw instanceof Uint8Array) {
      if (raw.byteLength < 4 || raw.byteLength % 4 !== 0) return null;
      const copy = Uint8Array.from(raw);
      return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
    }
    if (raw instanceof ArrayBuffer) {
      if (raw.byteLength < 4 || raw.byteLength % 4 !== 0) return null;
      return new Float32Array(raw);
    }
  } catch {
    return null;
  }
  return null;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export async function reanalyzeApprovedBook(
  db: DbClient,
  existingBook: {
    title?: string;
    set_name?: string;
    sub_series?: string;
    set_global_number?: number | null;
    coverage_range?: string;
    author?: string;
    volume?: string;
    publisher?: string;
    pub_year?: string;
    edition?: string;
    category?: string;
    notes?: string;
    tags?: string[];
  },
  images: CoverImagePart[],
  customPrompt?: string,
  options?: { abortSignal?: AbortSignal; timeoutMs?: number; onKeyPicked?: (entry: AiKeyEntry) => void }
): Promise<ExtractedBookMetadata> {
  const cfg = getAiConfig(db);
  if (!cfg.hasAnyKey) {
    throw new Error("לא הוגדר מפתח Gemini API בהגדרות המערכת");
  }
  const existingSnapshot = JSON.stringify({
    title: existingBook.title || "",
    set_name: existingBook.set_name || "",
    sub_series: existingBook.sub_series || "",
    set_global_number: existingBook.set_global_number ?? null,
    volume: existingBook.volume || "",
    coverage_range: existingBook.coverage_range || "",
    author: existingBook.author || "",
    publisher: existingBook.publisher || "",
    pub_year: existingBook.pub_year || "",
    edition: existingBook.edition || "",
    category: existingBook.category || "",
    notes: existingBook.notes || "",
    tags: existingBook.tags || [],
  });

  const systemPrompt =
    "אתה ספרן תורני מומחה בישיבה שמבצע טיוב ותיקון נתונים של ספר שכבר מאושר בקטלוג. לפניך הנתונים הקיימים של הספר, ובמידה וצורפו תמונות שמורות או חדשות של השער/שדרה — העזר בהן. הקפד במיוחד על חילוץ והפרדה של סט (set_name), תת-סדרה/מסכת (sub_series), מספר כרך כללי (set_global_number), סימון כרך מדויק (volume), טווח סימנים/דפים (coverage_range), ותיקון שגיאות כתיב/מהדורה/מחבר. החזר JSON מדויק בלבד בעברית.";
  const userPrompt = `נתוני הספר הנוכחיים בקטלוג:
${existingSnapshot}
${customPrompt?.trim() ? `\nבקשת העריכה של הספרן: ${customPrompt.trim()}` : "\nבצע בדיקה, דיוק והשלמה של כל שדות הספר (במיוחד כותר, סט, תת-סדרה, טווח סימנים/דפים, שנת הוצאה, מהדורה ותגיות)."}
החזר את כל השדות המעודכנים בפורמט JSON מלא.`;

  const imageParts = images.map((img) => ({
    inlineData: {
      mimeType: img.mimeType || "image/jpeg",
      data: img.buffer.toString("base64"),
    },
  }));

  const { result: response } = await executeWithModelAndKeyFallback(
    db,
    cfg.aiModel,
    cfg.autoFallback,
    async (apiKey, activeModel, _entry, signal) => {
      const ai = createClient(apiKey);
      return ai.models.generateContent({
        model: activeModel,
        contents: {
          parts: [...imageParts, { text: userPrompt }],
        },
        config: {
          abortSignal: signal,
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              set_name: { type: Type.STRING },
              sub_series: { type: Type.STRING },
              set_global_number: { type: Type.INTEGER },
              volume: { type: Type.STRING },
              coverage_range: { type: Type.STRING },
              author: { type: Type.STRING },
              publisher: { type: Type.STRING },
              pub_year: { type: Type.STRING },
              edition: { type: Type.STRING },
              category: { type: Type.STRING },
              notes: { type: Type.STRING },
              tags: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ["title", "author", "volume", "publisher", "pub_year", "edition", "category", "notes", "tags"],
          },
        },
      });
    },
    { abortSignal: options?.abortSignal, timeoutMs: options?.timeoutMs ?? 45_000, onKeyPicked: options?.onKeyPicked }
  );

  const rawText = (response.text || "{}").trim();
  const parsed = JSON.parse(rawText) as Partial<ExtractedBookMetadata>;
  const rawGlobalNum = Number(parsed.set_global_number);

  return {
    title: String(parsed.title || "").trim(),
    set_name: String(parsed.set_name || "").trim(),
    sub_series: String(parsed.sub_series || "").trim(),
    set_global_number: Number.isFinite(rawGlobalNum) && rawGlobalNum > 0 ? Math.round(rawGlobalNum) : null,
    coverage_range: String(parsed.coverage_range || "").trim(),
    author: String(parsed.author || "").trim(),
    volume: String(parsed.volume || "").trim(),
    publisher: String(parsed.publisher || "").trim(),
    pub_year: String(parsed.pub_year || "").trim(),
    edition: String(parsed.edition || "").trim(),
    category: String(parsed.category || "").trim() || "כללי",
    notes: String(parsed.notes || "").trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12) : [],
  };
}

export async function generateSmartShelfPlanWithAi(
  db: DbClient,
  librarySummaryJson: string,
  options?: { abortSignal?: AbortSignal; timeoutMs?: number }
): Promise<{
  summary: string;
  moves: Array<{
    title: string;
    description: string;
    reason: string;
    severity: "info" | "warning" | "high";
    fromCabinetCode?: string;
    fromShelf?: number;
    toCabinetCode?: string;
    toShelf?: number;
    setName?: string;
    barcodes?: string[];
  }>;
}> {
  const cfg = getAiConfig(db);
  if (!cfg.hasAnyKey) {
    throw new Error("לא הוגדר מפתח Gemini API");
  }
  const systemPrompt =
    "אתה יועץ ארגון וסדר תורני של אוצר ספרים בישיבה. לפניך תמונת מצב מספרית של החדר, הארונות (כולל רוחב מדפים בס״מ ונושא ראשי), אחוזי תפוסה של כל מדף, סטים מפוצלים וספרים לא משויכים. הצע מהלכי סידור קונקרטיים וריאליים לפי ס״מ פנויים ונושא ארון, רק עבור ארונות ומדפים שבאמת קיימים בסיכום. החזר JSON בעברית בלבד.";

  const { result: response } = await executeWithModelAndKeyFallback(
    db,
    cfg.aiModel,
    cfg.autoFallback,
    async (apiKey, activeModel, _entry, signal) => {
      const ai = createClient(apiKey);
      return ai.models.generateContent({
        model: activeModel,
        contents: `להלן נתוני המדפים והספרים של אוצר הספרים:\n${librarySummaryJson}\nהפק עד 8 המלצות סידור והעברת מדפים חכמות (עם קוד ארון ומספר מדף מקור ויעד מדויקים כשניתן ליישום אוטומטי).`,
        config: {
          abortSignal: signal,
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING, description: "סיכום קצר של מצב הספרייה" },
              moves: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    description: { type: Type.STRING },
                    reason: { type: Type.STRING },
                    severity: { type: Type.STRING },
                    fromCabinetCode: { type: Type.STRING },
                    fromShelf: { type: Type.INTEGER },
                    toCabinetCode: { type: Type.STRING },
                    toShelf: { type: Type.INTEGER },
                    setName: { type: Type.STRING },
                    barcodes: { type: Type.ARRAY, items: { type: Type.STRING } },
                  },
                  required: ["title", "description", "reason", "severity"],
                },
              },
            },
            required: ["summary", "moves"],
          },
        },
      });
    },
    { abortSignal: options?.abortSignal, timeoutMs: options?.timeoutMs ?? 45_000 }
  );

  const rawText = (response.text || "{}").trim();
  const parsed = JSON.parse(rawText) as { summary?: string; moves?: Array<Record<string, unknown>> };
  const moves = Array.isArray(parsed.moves)
    ? parsed.moves.map((m) => ({
        title: String(m.title || "המלצת סידור").trim(),
        description: String(m.description || "").trim(),
        reason: String(m.reason || "").trim(),
        severity: (m.severity === "high" || m.severity === "warning" ? m.severity : "info") as "info" | "warning" | "high",
        fromCabinetCode: m.fromCabinetCode ? String(m.fromCabinetCode).trim() : undefined,
        fromShelf: Number(m.fromShelf) > 0 ? Number(m.fromShelf) : undefined,
        toCabinetCode: m.toCabinetCode ? String(m.toCabinetCode).trim() : undefined,
        toShelf: Number(m.toShelf) > 0 ? Number(m.toShelf) : undefined,
        setName: m.setName ? String(m.setName).trim() : undefined,
        barcodes: Array.isArray(m.barcodes) ? m.barcodes.map((b) => String(b).trim()).filter(Boolean) : undefined,
      }))
    : [];
  return {
    summary: String(parsed.summary || "").trim(),
    moves,
  };
}

export function buildBookEmbeddingText(book: {
  title?: string;
  set_name?: string;
  sub_series?: string;
  coverage_range?: string;
  author?: string;
  volume?: string;
  publisher?: string;
  pub_year?: string;
  edition?: string;
  category?: string;
  tags?: string | string[];
  notes?: string;
}): string {
  const tagsStr = Array.isArray(book.tags)
    ? book.tags.join(", ")
    : (() => {
        try {
          const p = JSON.parse(String(book.tags || "[]"));
          return Array.isArray(p) ? p.join(", ") : String(book.tags || "");
        } catch {
          return String(book.tags || "");
        }
      })();
  return [
    book.title ? `ספר: ${book.title}` : "",
    book.set_name ? `סט/סדרה: ${book.set_name}` : "",
    book.sub_series ? `תת-סדרה: ${book.sub_series}` : "",
    book.author ? `מחבר: ${book.author}` : "",
    book.volume ? `כרך: ${book.volume}` : "",
    book.coverage_range ? `טווח סימנים/דפים: ${book.coverage_range}` : "",
    book.category ? `קטגוריה: ${book.category}` : "",
    tagsStr ? `נושאים ותגיות: ${tagsStr}` : "",
    book.publisher ? `הוצאה: ${book.publisher}` : "",
    book.edition ? `מהדורה: ${book.edition}` : "",
    book.pub_year ? `שנת הוצאה: ${book.pub_year}` : "",
    book.notes ? `הערות: ${book.notes}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}
