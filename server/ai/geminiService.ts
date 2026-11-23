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

export interface AiRuntimeConfig {
  apiKey: string;
  aiModel: string;
  embeddingModel: string;
  delayMs: number;
}

export function getAiConfig(db: DbClient): AiRuntimeConfig {
  const getSetting = (key: string, fallback: string) =>
    db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value ?? fallback;

  const storedKey = getSetting("ai_api_key", "").trim();
  const envKey = (process.env.GEMINI_API_KEY || "").trim();

  return {
    apiKey: storedKey || envKey,
    aiModel: getSetting("ai_model", "gemini-4-hydrogen").trim() || "gemini-4-hydrogen",
    embeddingModel: getSetting("embedding_model", "gemini-embedding-001").trim() || "gemini-embedding-001",
    delayMs: Math.max(500, Number(getSetting("ai_delay_ms", "4200")) || 4200),
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

export function formatGeminiError(err: unknown): string {
  const msg = String((err as { message?: string })?.message || err || "");
  const lower = msg.toLowerCase();
  if (lower.includes("403") || lower.includes("permission_denied") || lower.includes("api_key_invalid") || lower.includes("api key not valid")) {
    return "מפתח ה-API אינו תקין או שנדחתה ההרשאה (403). בדוק את המפתח בהגדרות.";
  }
  if (lower.includes("429") || lower.includes("resource_exhausted") || lower.includes("quota")) {
    return "חריגה ממגבלת הבקשות הזמנית (429). המתן מעט או הגדל את ההשהיה בהגדרות.";
  }
  if (lower.includes("404") || lower.includes("not_found")) {
    return "שם המודל שהוגדר אינו זמין (404). ניתן להחליף מודל בהגדרות (למשל gemini-4-hydrogen).";
  }
  if (
    lower.includes("fetch failed") ||
    lower.includes("enotfound") ||
    lower.includes("econnrefused") ||
    lower.includes("etimedout") ||
    lower.includes("certificate") ||
    lower.includes("network")
  ) {
    return "אין חיבור זמין לשרתי Gemini (מצב אופליין או חסימת סינון רשת כמו אתרוג/נטפרי).";
  }
  return msg || "שגיאה לא צפויה בפנייה ל-Gemini";
}

export async function testGeminiConnection(db: DbClient): Promise<{ ok: boolean; model: string; latencyMs: number; message: string }> {
  const cfg = getAiConfig(db);
  if (!cfg.apiKey) {
    return {
      ok: false,
      model: cfg.aiModel,
      latencyMs: 0,
      message: "לא הוגדר מפתח Gemini API בהגדרות.",
    };
  }
  const t0 = Date.now();
  try {
    const ai = createClient(cfg.apiKey);
    const response = await ai.models.generateContent({
      model: cfg.aiModel,
      contents: "החזר רק את המילה: תקין",
    });
    const txt = (response.text || "").trim();
    return {
      ok: true,
      model: cfg.aiModel,
      latencyMs: Date.now() - t0,
      message: `החיבור תקין מול המודל ${cfg.aiModel} (${txt || "OK"})`,
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

export async function analyzeBookCoverImage(
  db: DbClient,
  imageInput: Buffer | Array<{ buffer: Buffer; mimeType?: string }>,
  mimeType = "image/jpeg"
): Promise<ExtractedBookMetadata> {
  const cfg = getAiConfig(db);
  if (!cfg.apiKey) {
    throw new Error("לא הוגדר מפתח Gemini API בהגדרות המערכת");
  }
  const images = Array.isArray(imageInput)
    ? imageInput
    : [{ buffer: imageInput, mimeType }];
  if (images.length === 0) {
    throw new Error("לא סופקו תמונות לפענוח");
  }

  const ai = createClient(cfg.apiKey);

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

  const response = await ai.models.generateContent({
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
  if (!cfg.apiKey) {
    throw new Error("לא הוגדר מפתח Gemini API");
  }
  const cleanText = String(text || "").trim();
  if (!cleanText) {
    throw new Error("טקסט ריק לאינדוקס");
  }

  const ai = createClient(cfg.apiKey);
  const result = await ai.models.embedContent({
    model: cfg.embeddingModel || "gemini-embedding-001",
    contents: cleanText,
    config: {
      outputDimensionality: 768,
    },
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
