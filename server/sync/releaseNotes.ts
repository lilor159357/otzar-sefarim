import fs from "fs";
import path from "path";

export interface CleanedReleaseNotes {
  summary: string;
  highlights: string[];
}

export interface PendingUpdateNotes {
  targetVersion: string;
  previousVersion?: string;
  summary: string;
  highlights: string[];
  themePreset?: string;
  darkMode?: boolean;
  savedAt: string;
}

export interface UiPrefsSnapshot {
  themePreset: string;
  darkMode: boolean;
}

const VERSION_HIGHLIGHTS_FALLBACK: Record<string, string[]> = {
  "1.0.20": [
    "שדרוג מודלי AI וגיבוי אוטומטי ב-503: gemini-3.5-flash-lite לשערים, gemini-3.8-flash לצילומי מדף, ומעבר חלק למודל גיבוי בעומסי 503.",
    "טעינה חיה של מודלים נתמכים (models.list) וכפתור 'בדוק מודל' ישירות מהגדרות ה-AI, לצד בקרי Timeout, קירור והשהיית מפתחות.",
    "פענוח מחדש מיידי מתוך התור ומסך הסקירה תוך שימור מלא של כל התמונות המצורפות והארון/מדף.",
    "סינכרון שדות בטוח לכל הסט (☑ לכל הסט עם מיזוג תגיות מחייב והחרגת שם הסט) ובונה תבניות שם בסימון עכבר עם עמודת כרך.",
  ],
  "1.0.19": [
    "שדרוג שלב ההעשרה ברשת למודל הרשמי gemini-flash-lite-latest (Gemini 3.5 Flash-Lite) ללא צריכה ממכסת המודלים הראשיים.",
  ],
  "1.0.18": [
    "דיוק סטים ומקראות גדולות ב-AI: חיוב שמות תוכן מפורשים (בראשית, שמות, מסכתות) והוספת גודל/פורמט ושנה לכל כרך בסכמת הפענוח.",
    "בידול אוטומטי בין סטים זהים ממהדורות שונות (שילוב המהדורה/ההוצאה בסוגריים ומניעת התנגשות).",
  ],
  "1.0.17": [
    "דיווח תקלות ובאגים מאובטח ישירות ל-GitHub ולמייל המפתח (אוסף bug_reports + GitHub Action אוטומטי ללא סודות בקוד).",
    "שיפור משמעותי בדיוק פענוח סטים ומקראות גדולות: שמות כרכים מפורשים (בראשית, שמות, מסכתות), חילוץ גודל/פורמט ושנה לכל כרך.",
    "משיכת פרטי סט אוטומטית מלאה + מיזוג תגיות בסיס עם תגיות כרך ייחודיות (בקטלוג AI, בהוספה ידנית ובעריכה).",
    "תחימת גבולות קשיחה לעורך המפה הדו-ממדית (מניעת בריחת ארונות מחוץ למפה כולל בסיבוב), וכפתורי רענון תור והחלה על מקבץ משופרים.",
    "השלמה ביבליוגרפית מהאינטרנט (gemini-flash-lite-latest + חיפוש גוגל) ומיון וסינון ספרים מתקדם לפי כל הפרמטרים.",
  ],
  "1.0.16": [
    "תיקון התנגשות קוד ארון בסנכרון ענן (UNIQUE constraint failed: cabinets.code): מנגנון מיזוג ושיוך חכם לארונות שנמחקו או נוצרו מחדש ומניעת חסימת סנכרון.",
  ],
  "1.0.15": [
    "שדרוג מפת ספרייה ומסדר מדפים חכם: חישוב שטח חדר במ\"ר, מידות ארונות בס\"מ, שכפול ארונות ומדפים וסידור מדף חכם.",
    "טווח סימנים ודפים (coverage_range): שדה ייעודי וחיפוש חכם ישיר לפי סימן בודד או טווח.",
    "היררכיית סטים גמישה (סט בתוך סט): תת-סדרה, מספר כרך כללי, תמיכה חופשית בכל סימון ועורך כללי כרכים.",
    "בורר סדר תצוגה בסריקת מדף: מעבר מיידי בין סדר המדף (כולל היפוך ימין-שמאל) לסדר כרכים תורני.",
    "שמירת תמונות ל-30 יום ועריכה חוזרת ע\"י AI: אפשרות עריכה מחדש מתוך כרטיס הספר עם השוואת שינויים (Diff).",
    "סל מחזור ל-30 יום: שמירת ספרים שנמחקו ופענוחי AI שנדחו עם שחזור מיידי למאגר או לתור וניקוי אוטומטי.",
    "רענון פענוח תקוע ופסק זמן אוטומטי: רענון מהיר, התראת חשיבה ארוכה והחלפת מפתח API אוטומטית.",
  ],
  "1.0.14": [
    "מערכת ניהול ניסוחים ומילון מאומת: עורך חי בהגדרות עם עדכון מיידי ללא בנייה מחדש.",
    "הטמעה אוטומטית בענן: סנכרון ישיר ל-Firestore והטמעה לקוד המקור ב-GitHub Actions בעת בנייה.",
    "גלילה חלקה ועיצוב משופר לחלון 'מה חדש' עם הגנה מלאה על תצוגה בגבהים שונים.",
    "הגנה על גרשיים עבריים, מחרוזות מפותלות וחלון עדכון ממותג.",
  ],
  "1.0.13": [
    "שיפורי יציבות בסנכרון הענן ותמיכה בהעברת נתונים מהירה.",
  ],
  "1.0.11": [
    "ריבוי תמונות שער ופרטים במצב 'סט מהמדף': כעת ניתן לצרף עד 4 תמונות שער ופרטים לצד תמונות השדרות.",
    "המשך ושיוך לסט קיים באמצע העבודה: שמירת מצב Sticky Set בין הפעלות התוכנה וזיהוי אוטומטי של סטים קיימים.",
  ],
  "1.0.10": [
    "ממשק עדכון רציף וממותג (ללא שום 'חור שחור'): חלון התקנה ממותג בעיצוב אוצר ספרים הנשאר בחזית המסך לכל אורך חילוץ העדכון.",
  ],
  "1.0.9": [
    "מניעת שכפול ספרי דמו בסנכרון בין מחשבים וניקוי נתונים מקומיים לפני משיכה.",
    "כפתור ייעודי לניקוי ספרי דמו וכפילויות במסך סנכרון הענן.",
  ],
  "1.0.5": [
    "מעבר לעדכונים שקטים וללא אשף התקנה של ווינדוס או אישורי מנהל (One-Click).",
    "מסך עדכון ופתיחה חדש בעיצוב אוצר ספרים עם סדר סגירה מובטח וגיבוי אוטומטי לפני כל עדכון.",
    "תיקון תצוגת הערות השחרור והוספת סיכום חידושים נקי לאחר הפעלה מחדש.",
  ],
};

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : "";
    });
}

export function cleanReleaseNotes(raw: unknown, fallbackVersion?: string | null): CleanedReleaseNotes {
  let text = "";
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const note = (item as { note?: unknown }).note;
          return typeof note === "string" ? note : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (text) {
    text = text
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "\n• ")
      .replace(/<[^>]+>/g, " ");
    text = decodeHtmlEntities(text);
  }

  const allLines = text.split(/\r?\n/);
  const cleanTargetVer = fallbackVersion ? String(fallbackVersion).replace(/^v/i, "").trim() : "";

  // If RELEASE_NOTES.md contains multiple version headings (e.g. ## מה חדש בגרסה 1.0.12 ... ## מה חדש בגרסה 1.0.11),
  // isolate ONLY the target version section (or the first/latest version section).
  const isVersionHeading = (rawLine: string): string | null => {
    const t = rawLine.trim().replace(/^#{1,6}\s+/, "").trim();
    const m = t.match(/^(?:מה חדש בגרסה|גרסה|version)\s+v?(\d+\.\d+\.\d+)/i);
    return m ? m[1] : null;
  };

  let scopedLines = allLines;
  const headingIndices: Array<{ idx: number; ver: string }> = [];
  for (let i = 0; i < allLines.length; i++) {
    const v = isVersionHeading(allLines[i]);
    if (v) headingIndices.push({ idx: i, ver: v });
  }
  if (headingIndices.length > 0) {
    const exactIdx = cleanTargetVer
      ? headingIndices.findIndex((h) => h.ver === cleanTargetVer)
      : -1;
    const chosen = exactIdx >= 0 ? exactIdx : 0;
    const startIdx = headingIndices[chosen].idx + 1;
    const endIdx = chosen + 1 < headingIndices.length ? headingIndices[chosen + 1].idx : allLines.length;
    scopedLines = allLines.slice(startIdx, endIdx);
  }

  const rawLines = scopedLines
    .map((line) => line.trim())
    .filter(Boolean);

  const highlights: string[] = [];
  const seen = new Set<string>();

  for (let line of rawLines) {
    line = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*•]+\s+/, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\s+by\s+@[A-Za-z0-9-]+\s+in\s+https?:\/\/\S+/gi, "")
      .replace(/https?:\/\/github\.com\/\S+/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!line) continue;
    if (/^(?:מה חדש בגרסה|גרסה|version)\s+v?\d+\.\d+\.\d+/i.test(line)) continue;
    if (/^what'?s changed:?$/i.test(line)) continue;
    if (/^new contributors:?$/i.test(line)) continue;
    if (/^full changelog\s*:?$/i.test(line)) continue;
    if (/^v?\d+\.\d+\.\d+\.\.\.v?\d+\.\d+\.\d+$/i.test(line)) continue;
    if (/^full changelog\s*:/i.test(line)) {
      const cleanedTail = line.replace(/^full changelog\s*:\s*/i, "").replace(/[:.\s]+$/, "").trim();
      if (!cleanedTail || /^v?\d+\.\d+\.\d+/.test(cleanedTail)) continue;
      line = cleanedTail;
    }

    if (!seen.has(line)) {
      seen.add(line);
      highlights.push(line);
    }
    if (highlights.length >= 20) break;
  }

  if (highlights.length === 0 && fallbackVersion) {
    const cleanVer = String(fallbackVersion).replace(/^v/i, "").trim();
    const builtin = VERSION_HIGHLIGHTS_FALLBACK[cleanVer];
    if (builtin && builtin.length > 0) {
      return {
        summary: builtin.join(" · "),
        highlights: [...builtin],
      };
    }
  }

  return {
    summary: highlights.join(" · "),
    highlights,
  };
}


export function filterHighlightsForVersion(highlights: string[], targetVersion?: string | null): string[] {
  if (!Array.isArray(highlights) || highlights.length === 0) return [];
  const cleanTarget = targetVersion ? String(targetVersion).replace(/^v/i, "").trim() : "";
  const isVerLine = (line: string): string | null => {
    const m = String(line || "")
      .trim()
      .match(/^(?:מה חדש בגרסה|גרסה|version)\s+v?(\d+\.\d+\.\d+)/i);
    return m ? m[1] : null;
  };
  const headers: Array<{ idx: number; ver: string }> = [];
  for (let i = 0; i < highlights.length; i++) {
    const v = isVerLine(highlights[i]);
    if (v) headers.push({ idx: i, ver: v });
  }
  if (headers.length === 0) return highlights;
  const matchIdx = cleanTarget ? headers.findIndex((h) => h.ver === cleanTarget) : -1;
  const chosen = matchIdx >= 0 ? matchIdx : 0;
  const start = headers[chosen].idx + 1;
  const end = chosen + 1 < headers.length ? headers[chosen + 1].idx : highlights.length;
  return highlights.slice(start, end).filter((x) => !isVerLine(x));
}

export function getBuiltinHighlightsForVersion(version: string): string[] {
  const cleanVer = String(version || "").replace(/^v/i, "").trim();
  const list = VERSION_HIGHLIGHTS_FALLBACK[cleanVer];
  if (list && list.length > 0) return [...list];
  return ["שיפורי יציבות, אבטחה וחוויית שימוש במערכת."];
}

export function compareSemver(a: string, b: string): number {
  const pa = String(a || "").replace(/^v/i, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || "").replace(/^v/i, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

export function getPendingUpdateFilePath(dataDir: string): string {
  return path.join(dataDir, "pending-update-notes.json");
}

export function savePendingUpdateNotes(dataDir: string, payload: PendingUpdateNotes): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(getPendingUpdateFilePath(dataDir), JSON.stringify(payload, null, 2), "utf8");
  } catch {}
}

export function readPendingUpdateNotes(dataDir: string): PendingUpdateNotes | null {
  try {
    const file = getPendingUpdateFilePath(dataDir);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.targetVersion) return null;
    return parsed as PendingUpdateNotes;
  } catch {
    return null;
  }
}

export function clearPendingUpdateNotes(dataDir: string): void {
  try {
    const file = getPendingUpdateFilePath(dataDir);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {}
}

export function getUiPrefsFilePath(dataDir: string): string {
  return path.join(dataDir, "ui-prefs.json");
}

export function saveUiPrefs(dataDir: string, prefs: UiPrefsSnapshot): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(getUiPrefsFilePath(dataDir), JSON.stringify(prefs, null, 2), "utf8");
  } catch {}
}

export function readUiPrefs(dataDir: string): UiPrefsSnapshot {
  try {
    const file = getUiPrefsFilePath(dataDir);
    if (!fs.existsSync(file)) return { themePreset: "default", darkMode: false };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      themePreset: typeof parsed?.themePreset === "string" ? parsed.themePreset : "default",
      darkMode: Boolean(parsed?.darkMode),
    };
  } catch {
    return { themePreset: "default", darkMode: false };
  }
}
