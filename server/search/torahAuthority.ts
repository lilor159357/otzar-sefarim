import type { DbClient } from "../db/adapter.ts";
import { normalizeHebrewText } from "../db/schema.ts";

const GEMATRIYA_MAP: Record<string, number> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9,
  י: 10, כ: 20, ך: 20, ל: 30, מ: 40, ם: 40, נ: 50, ן: 50,
  ס: 60, ע: 70, פ: 80, ף: 80, צ: 90, ץ: 90, ק: 100, ר: 200, ש: 300, ת: 400,
};

export function hebrewGematriya(str: string): number {
  if (!str) return 0;
  const clean = str.replace(/["'״׳]/g, "").trim();
  let sum = 0;
  for (const ch of clean) {
    if (GEMATRIYA_MAP[ch]) {
      sum += GEMATRIYA_MAP[ch];
    } else {
      return 0;
    }
  }
  return sum;
}

export function torahNaturalVolumeRank(val: unknown): number {
  if (!val) return 9999;
  const s = String(val).trim();
  if (!s) return 9999;
  const numMatch = s.match(/\d+/);
  if (numMatch) return parseInt(numMatch[0], 10);
  const tokenMatch = s.replace(/^(חלק|כרך|ספר|ח['"״׳]|כ['"״׳])\s*/i, "").trim();
  const firstWord = tokenMatch.split(/[\s\-–—]/)[0];
  const g = hebrewGematriya(firstWord);
  if (g > 0) return g;
  return 9999;
}

export function torahNaturalVolumeSort(a: unknown, b: unknown): number {
  const ra = torahNaturalVolumeRank(a);
  const rb = torahNaturalVolumeRank(b);
  if (ra !== rb) return ra - rb;
  return String(a || "").localeCompare(String(b || ""), "he");
}

const RABBINIC_HONORIFIC_TOKENS = new Set([
  "הרהג", "הרהצ", "הרהח", "אדמור", "זצוקללהה", "זצוקל", "מוהרר", "מוהרא", "מוהרי", "מוהראש",
  "הגאון", "רבינו", "רבנו", "החכם", "המחבר", "הקדוש", "מרן", "הרב", "רבי", "כק", "רב",
  "זצל", "זל", "שליטא", "עה", "זתע", "היד", "תנצבה", "נע", "זיעא", "עיו", "היו"
]);

export function cleanRabbinicTitles(name: string): string {
  if (!name) return "";
  let s = name
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/["״׳'`\u2018\u2019\u201C\u201D]/g, "")
    .replace(/[\-\u05BE\u2013\u2014,]/g, " ")
    .replace(/עוד יוסף חי/g, " ");
  const tokens = s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !RABBINIC_HONORIFIC_TOKENS.has(t.toLowerCase()));
  return tokens.join(" ");
}

function damerauLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  if (Math.abs(al - bl) > 3) return 99;
  const dp: number[][] = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) dp[i][0] = i;
  for (let j = 0; j <= bl; j++) dp[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2][j - 2] + cost);
      }
      dp[i][j] = val;
    }
  }
  return dp[al][bl];
}

export interface AuthorityMatchResult {
  match: string;
  confidence: "high" | "suggestion";
  original: string;
  score: number;
}

export function findAuthorityMatch(
  db: DbClient,
  field: "author" | "set_name" | "publisher",
  candidateRaw: string
): AuthorityMatchResult | null {
  const cleanCandidate = String(candidateRaw || "").trim();
  if (cleanCandidate.length < 3) return null;

  const colName = field === "author" ? "author" : field === "set_name" ? "set_name" : "publisher";
  const rows = db.all<{ val: string; c: number }>(
    `SELECT ${colName} AS val, COUNT(*) AS c 
     FROM books 
     WHERE ${colName} IS NOT NULL AND ${colName} != '' AND deleted_at IS NULL 
     GROUP BY ${colName} 
     ORDER BY c DESC 
     LIMIT 400`
  );

  const normCandidate = normalizeHebrewText(cleanCandidate);
  const coreCandidate = normalizeHebrewText(cleanRabbinicTitles(cleanCandidate));

  let bestMatch: string | null = null;
  let bestScore = 0;
  let isHigh = false;

  for (const row of rows) {
    const known = String(row.val || "").trim();
    if (!known) continue;
    if (known === cleanCandidate) return null; // already identical, no substitution needed

    const normKnown = normalizeHebrewText(known);
    const coreKnown = normalizeHebrewText(cleanRabbinicTitles(known));

    // 1. Direct match on core name (without rabbinic titles)
    if (coreKnown && coreCandidate && coreKnown === coreCandidate) {
      return {
        match: known,
        confidence: "high",
        original: cleanCandidate,
        score: 1.0,
      };
    }

    // 2. High overlap or prefix containment
    if (
      coreKnown.length >= 6 &&
      coreCandidate.length >= 6 &&
      (coreKnown.startsWith(coreCandidate) || coreCandidate.startsWith(coreKnown))
    ) {
      const lenRatio = Math.min(coreKnown.length, coreCandidate.length) / Math.max(coreKnown.length, coreCandidate.length);
      if (lenRatio >= 0.82) {
        return {
          match: known,
          confidence: lenRatio >= 0.92 ? "high" : "suggestion",
          original: cleanCandidate,
          score: lenRatio,
        };
      }
    }

    // 3. Edit distance on core normalized name
    if (coreKnown.length >= 4 && coreCandidate.length >= 4) {
      const maxLen = Math.max(coreKnown.length, coreCandidate.length);
      const dist = damerauLevenshtein(coreKnown, coreCandidate);
      const sim = (maxLen - dist) / maxLen;
      if (sim > bestScore) {
        bestScore = sim;
        bestMatch = known;
        isHigh = sim >= 0.94;
      }
    }
  }

  if (bestMatch && bestScore >= 0.85) {
    return {
      match: bestMatch,
      confidence: isHigh ? "high" : "suggestion",
      original: cleanCandidate,
      score: bestScore,
    };
  }

  return null;
}

export function getAuthoritySuggestions(
  db: DbClient,
  field: "author" | "set_name" | "publisher" | "category",
  queryText: string,
  limitCount = 20
): Array<{ value: string; count: number }> {
  const colName =
    field === "author"
      ? "author"
      : field === "set_name"
      ? "set_name"
      : field === "publisher"
      ? "publisher"
      : "category";

  const rows = db.all<{ val: string; c: number }>(
    `SELECT ${colName} AS val, COUNT(*) AS c 
     FROM books 
     WHERE ${colName} IS NOT NULL AND ${colName} != '' AND deleted_at IS NULL 
     GROUP BY ${colName} 
     ORDER BY c DESC 
     LIMIT 500`
  );

  const cleanQ = normalizeHebrewText(cleanRabbinicTitles(queryText || ""));
  if (!cleanQ) {
    return rows.slice(0, limitCount).map((r) => ({ value: r.val, count: r.c }));
  }

  const filtered = rows.filter((r) => {
    const norm = normalizeHebrewText(cleanRabbinicTitles(r.val));
    return norm.includes(cleanQ) || normalizeHebrewText(r.val).includes(normalizeHebrewText(queryText));
  });

  return filtered.slice(0, limitCount).map((r) => ({ value: r.val, count: r.c }));
}
