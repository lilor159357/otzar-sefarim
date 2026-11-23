import crypto from "crypto";
import { GoogleGenAI, Type } from "@google/genai";
import type { DbClient } from "../db/adapter.ts";

export interface ExtractedBookMetadata {
  title: string;
  author: string;
  volume: string;
  publisher: string;
  pub_year: string;
  edition: string;
  category: string;
  notes: string;
  tags: string[];
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
  embeddingModel: string;
  delayMs: number;
}

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
    aiModel: getSetting(db, "ai_model", "gemini-4-hydrogen").trim() || "gemini-4-hydrogen",
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

function classifyGeminiError(err: unknown): "quota" | "invalid_key" | "network" | "model" | "other" {
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
  return "other";
}

export function formatGeminiError(err: unknown): string {
  const msg = String((err as { message?: string })?.message || err || "");
  const kind = classifyGeminiError(err);
  if (kind === "invalid_key") {
    return "מפתח ה-API אינו תקין או שנדחתה ההרשאה (403). בדוק את המפתחות ברולטה בהגדרות.";
  }
  if (kind === "quota") {
    return "חריגה ממגבלת הבקשות הזמנית (429). המפתחות בהשהיה זמנית — המתן מעט או הוסף מפתח נוסף מחשבון אחר.";
  }
  if (kind === "model") {
    return "שם המודל שהוגדר אינו זמין (404). ניתן להחליף מודל בהגדרות (למשל gemini-4-hydrogen).";
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

export async function executeWithKeyRoulette<T>(
  db: DbClient,
  task: (apiKey: string, entry: AiKeyEntry) => Promise<T>
): Promise<{ result: T; usedEntry: AiKeyEntry }> {
  const entries = getAiKeyPoolEntries(db).filter((k) => k.enabled);
  if (entries.length === 0) {
    throw new Error("לא הוגדרו מפתחות Gemini API פעילים בהגדרות המערכת");
  }

  const tried = new Set<string>();
  let lastErr: unknown = null;

  while (tried.size < entries.length) {
    const picked = selectLeastLoadedKey(entries, tried);
    if (!picked) break;

    tried.add(picked.apiKey);
    const st = getRuntimeState(picked.apiKey);
    const now = Date.now();
    st.activeInFlight += 1;
    st.recentTimestamps.push(now);
    st.lastUsedAt = now;
    st.totalRequests += 1;

    try {
      const result = await task(picked.apiKey, picked);
      st.lastError = null;
      st.disabledInvalid = false;
      return { result, usedEntry: picked };
    } catch (err) {
      lastErr = err;
      st.totalErrors += 1;
      const kind = classifyGeminiError(err);
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
      if (kind === "network" || kind === "model") {
        // Network/Etrog SSL or invalid model affects all keys equally — fail fast
        st.lastError = formatGeminiError(err);
        throw err;
      }
      st.lastError = formatGeminiError(err);
      throw err;
    } finally {
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
  try {
    const ai = createClient(keyToTest);
    const resp = await ai.models.generateContent({
      model: cfg.aiModel,
      contents: "השב במילה אחת בעברית: תקין",
    });
    const reply = (resp.text || "").trim();
    st.disabledInvalid = false;
    st.cooldownUntil = 0;
    st.lastError = null;
    st.lastUsedAt = Date.now();
    st.totalRequests += 1;
    return {
      ok: true,
      model: cfg.aiModel,
      latencyMs: Date.now() - t0,
      message: `${found?.label || "המפתח"} תקין ומחובר (תגובה: ${reply || "OK"})`,
    };
  } catch (err) {
    const kind = classifyGeminiError(err);
    const msg = formatGeminiError(err);
    if (kind === "invalid_key") st.disabledInvalid = true;
    if (kind === "quota") st.cooldownUntil = Date.now() + 60_000;
    st.lastError = msg;
    return { ok: false, model: cfg.aiModel, latencyMs: Date.now() - t0, message: msg };
  }
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
    const { result, usedEntry } = await executeWithKeyRoulette(db, async (apiKey) => {
      const ai = createClient(apiKey);
      const resp = await ai.models.generateContent({
        model: cfg.aiModel,
        contents: "השב במילה אחת בעברית: תקין",
      });
      return (resp.text || "").trim();
    });
    return {
      ok: true,
      model: cfg.aiModel,
      latencyMs: Date.now() - t0,
      usedLabel: usedEntry.label,
      message: `החיבור תקין דרך ${usedEntry.label} (תגובה: ${result || "OK"})`,
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
  mimeType = "image/jpeg"
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
    "אתה ספרן תורני מומחה בישיבה. תפקידך לפענח צילומי שערי ספרים תורניים (כולל אותיות מרובעות, כתב רש״י וראשי תיבות תורניים כמו שו״ע, רמב״ם, משנ״ב, ש״ס, שו״ת). אם מצורפות מספר תמונות, כולן דפים שונים של אותו ספר (למשל שער ראשי, גב שער עם שנת הוצאה ומהדורה, כריכה או תוכן עניינים) — מזג את הפרטים מכל התמונות לרשומה אחת מלאה ומדויקת. החזר JSON מדויק בלבד בעברית. בשדה tags צור 5 עד 10 תגיות חיפוש שימושיות (נושאים, מסכתות, סימנים, כינויים וראשי תיבות נפוצים).";

  const userPrompt =
    "פענח את דפי הספר המצולמים וחלץ: שם הספר (title), שם המחבר/מפרש (author), כרך/חלק/מסכת (volume), הוצאה/מכון (publisher), שנת הוצאה (pub_year - עברי או לועזי אם מופיעה באחד הדפים), מהדורה (edition - למשל מהדורה מתוקנת, מורחבת, שניה, עוז והדר), קטגוריה ראשית (category - למשל ש״ס בבלי, הלכה, רמב״ם, תנ״ך, שו״ת, מוסר ומחשבה, חסידות), הערות קצרות (notes), ו-5 עד 10 תגיות חיפוש (tags). אם שדה לא מופיע באף תמונה השאר מחרוזת ריקה.";

  const imageParts = images.map((img) => ({
    inlineData: {
      mimeType: img.mimeType || "image/jpeg",
      data: img.buffer.toString("base64"),
    },
  }));

  const { result: response } = await executeWithKeyRoulette(db, async (apiKey) => {
    const ai = createClient(apiKey);
    return ai.models.generateContent({
      model: cfg.aiModel,
      contents: {
        parts: [
          ...imageParts,
          { text: userPrompt },
        ],
      },
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING, description: "שם הספר המלא" },
            author: { type: Type.STRING, description: "שם המחבר או המפרש" },
            volume: { type: Type.STRING, description: "כרך, חלק או מסכת" },
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
  });

  const rawText = (response.text || "{}").trim();
  const parsed = JSON.parse(rawText) as Partial<ExtractedBookMetadata>;

  return {
    title: String(parsed.title || "").trim(),
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

export function buildBookEmbeddingText(book: {
  title?: string;
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
    book.author ? `מחבר: ${book.author}` : "",
    book.volume ? `כרך: ${book.volume}` : "",
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
