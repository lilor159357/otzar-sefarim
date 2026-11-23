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

  const rawLines = text
    .split(/\r?\n/)
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
    if (highlights.length >= 8) break;
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
