export type CoverageUnit = "siman" | "daf" | "perek" | "amud" | "any";

export interface VolumeNotationRule {
  symbol: string;
  rank: number;
  label?: string;
}

export interface ParsedCoverageSegment {
  unit: CoverageUnit;
  start: number;
  end: number;
  raw: string;
}

export interface CoverageQueryTarget {
  unit: CoverageUnit;
  value: number;
  displayToken: string;
  explicit: boolean;
  tokenStartIdx: number;
  tokenCount: number;
}

export interface CoverageMatchResult {
  matched: boolean;
  explicit: boolean;
  unit: CoverageUnit;
  value: number;
  hint: string;
}

const GEMATRIYA_MAP: Record<string, number> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9,
  י: 10, כ: 20, ך: 20, ל: 30, מ: 40, ם: 40, נ: 50, ן: 50,
  ס: 60, ע: 70, פ: 80, ף: 80, צ: 90, ץ: 90, ק: 100, ר: 200, ש: 300, ת: 400,
};

export function hebrewGematriya(str: string): number {
  if (!str) return 0;
  const clean = str.replace(/["'״׳\s]/g, "").trim();
  if (!clean) return 0;
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

export function numberToHebrewGematriya(num: number): string {
  if (!Number.isFinite(num) || num <= 0 || num > 999) return String(num);
  const hundreds = ["", "ק", "ר", "ש", "ת", "תק", "תר", "תש", "תת", "תתק"];
  const tens = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
  const ones = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
  const h = Math.floor(num / 100);
  const rem = num % 100;
  if (rem === 15) return hundreds[h] + "טו";
  if (rem === 16) return hundreds[h] + "טז";
  const t = Math.floor(rem / 10);
  const o = rem % 10;
  return hundreds[h] + tens[t] + ones[o];
}

export function parseVolumeNotationRules(raw: unknown): VolumeNotationRule[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) list = p;
    } catch {
      return [];
    }
  }
  const out: VolumeNotationRule[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const symbol = String(rec.symbol || "").trim();
    const rank = Number(rec.rank);
    const label = rec.label ? String(rec.label).trim() : undefined;
    if (symbol && Number.isFinite(rank)) {
      out.push({ symbol, rank, ...(label ? { label } : {}) });
    }
  }
  out.sort((a, b) => b.symbol.length - a.symbol.length);
  return out;
}

const ROMAN_MAP: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };

export function parseRomanNumeral(raw: string): number {
  const s = raw.trim().toUpperCase().replace(/[.)\]]+$/, "");
  if (!/^[IVXLC]{1,7}$/.test(s)) return 0;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = ROMAN_MAP[s[i]] || 0;
    const next = ROMAN_MAP[s[i + 1]] || 0;
    if (!cur) return 0;
    total += cur < next ? -cur : cur;
  }
  return total > 0 && total <= 100 ? total : 0;
}

const TORAH_CANONICAL_ENTRIES: Array<[string, number]> = [
  // 63 Masechtot (Mishnah / Shas) - checked BEFORE generic Seder names
  // Seder Zeraim (10000 - 11999)
  ["ברכות", 10010],
  ["פאה", 10020],
  ["דמאי", 10030],
  ["כלאים", 10040],
  ["כלאיים", 10040],
  ["שביעית", 10050],
  ["תרומות", 10060],
  ["מעשר שני", 10080],
  ["מעשרות", 10070],
  ["חלה", 10090],
  ["ערלה", 10100],
  ["בכורים", 10110],
  ["ביכורים", 10110],

  // Seder Moed (12000 - 13999)
  ["שבת", 12010],
  ["עירובין", 12020],
  ["ערובין", 12020],
  ["פסחים", 12030],
  ["שקלים", 12040],
  ["יומא", 12050],
  ["סוכה", 12060],
  ["ביצה", 12070],
  ["ראש השנה", 12080],
  ["תענית", 12090],
  ["מגילה", 12100],
  ["מועד קטן", 12110],
  ["חגיגה", 12120],

  // Seder Nashim (14000 - 15999)
  ["יבמות", 14010],
  ["כתובות", 14020],
  ["נדרים", 14030],
  ["נזיר", 14040],
  ["סוטה", 14050],
  ["גיטין", 14060],
  ["קידושין", 14070],

  // Seder Nezikin (16000 - 17999)
  ["בבא קמא", 16010],
  ["בבא מציעא", 16020],
  ["בבא בתרא", 16030],
  ["סנהדרין", 16040],
  ["מכות", 16050],
  ["שבועות", 16060],
  ["עדיות", 16070],
  ["עדויות", 16070],
  ["עבודה זרה", 16080],
  ["פרקי אבות", 16090],
  ["אבות", 16090],
  ["הוריות", 16100],

  // Seder Kodashim (18000 - 19999)
  ["זבחים", 18010],
  ["מנחות", 18020],
  ["חולין", 18030],
  ["בכורות", 18040],
  ["ערכין", 18050],
  ["תמורה", 18060],
  ["כריתות", 18070],
  ["מעילה", 18080],
  ["תמיד", 18090],
  ["מידות", 18100],
  ["מדות", 18100],
  ["קינים", 18110],
  ["קנים", 18110],

  // Seder Taharot (20000 - 21999)
  ["כלים", 20010],
  ["אהלות", 20020],
  ["אוהלות", 20020],
  ["נגעים", 20030],
  ["פרה", 20040],
  ["טהרות", 20050],
  ["מקוואות", 20060],
  ["מקואות", 20060],
  ["נידה", 20070],
  ["נדה", 20070],
  ["מכשירין", 20080],
  ["זבים", 20090],
  ["טבול יום", 20100],
  ["ידיים", 20110],
  ["ידים", 20110],
  ["עוקצין", 20120],
  ["עוקצים", 20120],

  // Generic Sedarim (only matched if no specific Masechet above matched)
  ["סדר זרעים", 10000],
  ["סדר מועד", 12000],
  ["סדר נשים", 14000],
  ["סדר נזיקין", 16000],
  ["סדר קדשים", 18000],
  ["סדר קודשים", 18000],
  ["סדר טהרות", 20000],

  // Tur / Shulchan Aruch (30000 - 30999)
  ["אורח חיים", 30010],
  ["אוח", 30010],
  ["יורה דעה", 30020],
  ["יוד", 30020],
  ["אבן העזר", 30030],
  ["אהע", 30030],
  ["חושן משפט", 30040],
  ["חומ", 30040],

  // Rambam Mishneh Torah (40000 - 41999) - explicit "ספר ..." before bare Tanach/Seder names
  ["ספר המדע", 40010],
  ["ספר מדע", 40010],
  ["המדע", 40010],
  ["מדע", 40010],
  ["ספר אהבה", 40020],
  ["אהבה", 40020],
  ["ספר זמנים", 40030],
  ["זמנים", 40030],
  ["ספר נשים", 40040],
  ["ספר קדושה", 40050],
  ["קדושה", 40050],
  ["ספר הפלאה", 40060],
  ["הפלאה", 40060],
  ["ספר זרעים", 40070],
  ["ספר עבודה", 40080],
  ["עבודה", 40080],
  ["ספר קרבנות", 40090],
  ["קרבנות", 40090],
  ["ספר טהרה", 40100],
  ["טהרה", 40100],
  ["ספר נזיקין", 40110],
  ["ספר קניין", 40120],
  ["ספר קנין", 40120],
  ["קניין", 40120],
  ["קנין", 40120],
  ["ספר משפטים", 40130],
  ["ספר שופטים", 40140],

  // Chumashim & Parshiot (1000 - 1500)
  ["פרשת בראשית", 1001],
  ["פרשת נח", 1002],
  ["לך לך", 1003],
  ["וירא", 1004],
  ["חיי שרה", 1005],
  ["פרשת תולדות", 1006],
  ["ויצא", 1007],
  ["וישלח", 1008],
  ["וישב", 1009],
  ["מקץ", 1010],
  ["ויגש", 1011],
  ["ויחי", 1012],
  ["בראשית", 1000],

  ["פרשת שמות", 1101],
  ["וארא", 1102],
  ["פרשת בא", 1103],
  ["בשלח", 1104],
  ["יתרו", 1105],
  ["פרשת משפטים", 1106],
  ["פרשת תרומה", 1107],
  ["תצוה", 1108],
  ["תצווה", 1108],
  ["כי תשא", 1109],
  ["ויקהל", 1110],
  ["פקודי", 1111],
  ["שמות", 1100],

  ["פרשת ויקרא", 1201],
  ["פרשת צו", 1202],
  ["שמיני", 1203],
  ["תזריע", 1204],
  ["מצורע", 1205],
  ["אחרי מות", 1206],
  ["קדושים", 1207],
  ["אמור", 1208],
  ["בהר", 1209],
  ["בחוקותי", 1210],
  ["בחקתי", 1210],
  ["ויקרא", 1200],

  ["פרשת במדבר", 1301],
  ["נשא", 1302],
  ["בהעלותך", 1303],
  ["בהעלתך", 1303],
  ["שלח לך", 1304],
  ["פרשת שלח", 1304],
  ["קורח", 1305],
  ["קרח", 1305],
  ["חוקת", 1306],
  ["חקת", 1306],
  ["בלק", 1307],
  ["פינחס", 1308],
  ["פנחס", 1308],
  ["מטות", 1309],
  ["מסעי", 1310],
  ["במדבר", 1300],

  ["פרשת דברים", 1401],
  ["ואתחנן", 1402],
  ["עקב", 1403],
  ["ראה", 1404],
  ["פרשת שופטים", 1405],
  ["כי תצא", 1406],
  ["כי תבוא", 1407],
  ["כי תבא", 1407],
  ["ניצבים", 1408],
  ["נצבים", 1408],
  ["וילך", 1409],
  ["האזינו", 1410],
  ["וזאת הברכה", 1411],
  ["דברים", 1400],

  ["משפטים", 40130],

  // Nevi'im (2000 - 2999)
  ["יהושע", 2010],
  ["שופטים", 2020],
  ["שמואל ב", 2040],
  ["שמואל א", 2030],
  ["שמואל", 2030],
  ["מלכים ב", 2060],
  ["מלכים א", 2050],
  ["מלכים", 2050],
  ["ישעיהו", 2070],
  ["ישעיה", 2070],
  ["ירמיהו", 2080],
  ["ירמיה", 2080],
  ["יחזקאל", 2090],
  ["תרי עשר", 2100],
  ["הושע", 2110],
  ["יואל", 2120],
  ["עמוס", 2130],
  ["עובדיה", 2140],
  ["יונה", 2150],
  ["מיכה", 2160],
  ["נחום", 2170],
  ["חבקוק", 2180],
  ["צפניה", 2190],
  ["חגי", 2200],
  ["זכריה", 2210],
  ["מלאכי", 2220],

  // Ketuvim (3000 - 3999)
  ["תהילים", 3010],
  ["תהלים", 3010],
  ["משלי", 3020],
  ["איוב", 3030],
  ["חמש מגילות", 3040],
  ["שיר השירים", 3050],
  ["רות", 3060],
  ["איכה", 3070],
  ["קהלת", 3080],
  ["אסתר", 3090],
  ["דניאל", 3100],
  ["עזרא", 3110],
  ["נחמיה", 3120],
  ["דברי הימים ב", 3140],
  ["דברי הימים א", 3130],
  ["דברי הימים", 3130],

  // Back matter / Indices
  ["מפתחות", 95010],
  ["מפתח", 95010],
  ["השלמה", 95020],
  ["נספחים", 95030],
];

function escapeRegExpCanon(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\export function torahNaturalVolumeRank(");
}

function normalizeCanonInput(raw: unknown): string {
  return String(raw || "")
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/["'״׳]/g, "")
    .replace(/[\-_\/\\.,:;!?()\[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function torahSubSeriesRank(val: unknown): number {
  const norm = normalizeCanonInput(val);
  if (!norm) return 999999;
  for (const [term, rank] of TORAH_CANONICAL_ENTRIES) {
    const re = new RegExp(`(?:^|\\s)${escapeRegExpCanon(term)}(?=$|\\s)`);
    if (re.test(norm)) {
      return rank;
    }
  }
  return 999999;
}

export function torahNaturalVolumeRank(val: unknown, customRules?: VolumeNotationRule[]): number {
  if (!val) return 999999;
  const s = String(val).trim();
  if (!s) return 999999;

  const stripped = s
    .replace(/^(חלק|כרך|ספר|מסכת|ח['"״׳]|כ['"״׳])\s*/i, "")
    .trim();

  // 1. Custom user-defined notation rules take highest priority
  if (customRules && customRules.length > 0) {
    const lowerFull = s.toLowerCase();
    const lowerStripped = stripped.toLowerCase();
    for (const rule of customRules) {
      const sym = rule.symbol.trim().toLowerCase();
      if (!sym) continue;
      if (lowerFull === sym || lowerStripped === sym) {
        return rule.rank;
      }
    }
    for (const rule of customRules) {
      const sym = rule.symbol.trim().toLowerCase();
      if (!sym) continue;
      if (lowerStripped.includes(sym)) {
        return rule.rank;
      }
    }
  }

  // 2. Repeated symbolic markers (*, **, •, ••, ★, ●, etc.)
  const symbolRunMatch = stripped.match(/(\*+|•+|★+|✦+|●+|◆+|▪+|◊+)/);
  if (symbolRunMatch) {
    return symbolRunMatch[1].length;
  }

  // 3. Combined Hebrew letter + number (e.g., א-1, ב-2, א/1) -> fractional sub-rank
  const hebNumMatch = stripped.match(/^([א-ת]{1,2})['"״׳]?[\s\-–—/]+(\d+)$/);
  if (hebNumMatch) {
    const g = hebrewGematriya(hebNumMatch[1]);
    const n = parseInt(hebNumMatch[2], 10);
    if (g > 0 && Number.isFinite(n)) {
      return g + Math.min(999, n) / 1000;
    }
  }

  // 4. Roman numerals (standalone or after prefix)
  const firstToken = stripped.split(/[\s\-–—]+/)[0] || "";
  const romanVal = parseRomanNumeral(firstToken) || parseRomanNumeral(stripped);
  if (romanVal > 0) {
    return romanVal;
  }

  // 5. Canonical Torah / Shas / Tanach / Shulchan Aruch names (check before Gematriya so words like בראשית/שבת are not summed as numbers)
  const canonRank = torahSubSeriesRank(stripped);
  if (canonRank < 999999) {
    // Check if there is also a trailing volume number or Hebrew letter (e.g., "בראשית / חלק א׳" vs "בראשית / חלק ב׳")
    const tailMatch = stripped.match(/(?:חלק|כרך|ספר)\s*([א-ת]{1,2}|\d+)['"״׳]?\s*$/);
    if (tailMatch) {
      const subNum = /^\d+$/.test(tailMatch[1]) ? parseInt(tailMatch[1], 10) : hebrewGematriya(tailMatch[1]);
      if (subNum > 0) {
        return 100000 + canonRank + Math.min(999, subNum) / 1000;
      }
    }
    const digitTail = stripped.match(/(\d+)\s*$/);
    if (digitTail) {
      const subNum = parseInt(digitTail[1], 10);
      if (subNum > 0) {
        return 100000 + canonRank + Math.min(999, subNum) / 1000;
      }
    }
    return 100000 + canonRank;
  }

  // 6. Arabic digits
  const numMatch = stripped.match(/\d+/);
  if (numMatch) {
    return parseInt(numMatch[0], 10);
  }

  // 7. Hebrew Gematriya token
  const g = hebrewGematriya(firstToken);
  if (g > 0) {
    return g;
  }

  return 999999;
}

export function torahNaturalVolumeSort(
  a: unknown,
  b: unknown,
  customRules?: VolumeNotationRule[]
): number {
  const ra = torahNaturalVolumeRank(a, customRules);
  const rb = torahNaturalVolumeRank(b, customRules);
  if (ra !== rb) return ra - rb;
  return String(a || "").localeCompare(String(b || ""), "he");
}

export interface SetSortableBook {
  title?: string;
  volume?: string;
  sub_series?: string;
  set_global_number?: number | null;
  barcode?: string;
}

export function compareSetBooks(
  a: SetSortableBook,
  b: SetSortableBook,
  customRules?: VolumeNotationRule[]
): number {
  const sa = String(a.sub_series || "").trim();
  const sb = String(b.sub_series || "").trim();
  const ra = sa ? torahSubSeriesRank(sa) : 999999;
  const rb = sb ? torahSubSeriesRank(sb) : 999999;
  const ga = a.set_global_number != null && Number.isFinite(Number(a.set_global_number)) ? Number(a.set_global_number) : null;
  const gb = b.set_global_number != null && Number.isFinite(Number(b.set_global_number)) ? Number(b.set_global_number) : null;

  // Canonical Torah sub-series order takes precedence across distinct canonical sections
  if (ra < 999999 && rb < 999999 && ra !== rb) {
    return ra - rb;
  }
  if (ga != null && gb != null && ga !== gb && (sa === sb || ra === 999999 || rb === 999999)) {
    return ga - gb;
  }
  if (sa !== sb) {
    if (ra !== rb) return ra - rb;
    if (ga != null && gb == null) return -1;
    if (ga == null && gb != null) return 1;
    if (!sa) return 1;
    if (!sb) return -1;
    const subVolCmp = torahNaturalVolumeRank(sa, customRules) - torahNaturalVolumeRank(sb, customRules);
    if (subVolCmp !== 0) return subVolCmp;
    return sa.localeCompare(sb, "he");
  }
  if (ga != null && gb == null) return -1;
  if (ga == null && gb != null) return 1;
  if (ga != null && gb != null && ga !== gb) return ga - gb;
  const volCmp = torahNaturalVolumeSort(a.volume, b.volume, customRules);
  if (volCmp !== 0) return volCmp;
  const titleCmp = String(a.title || "").localeCompare(String(b.title || ""), "he");
  if (titleCmp !== 0) return titleCmp;
  return String(a.barcode || "").localeCompare(String(b.barcode || ""), "he");
}

export function parseHebrewOrArabicNumber(raw: string): number {
  const cleaned = String(raw || "")
    .replace(/[()\[\],.;:]/g, "")
    .trim();
  if (!cleaned) return 0;
  if (/^\d+$/.test(cleaned)) {
    const n = parseInt(cleaned, 10);
    return n > 0 && n <= 20000 ? n : 0;
  }
  const g = hebrewGematriya(cleaned);
  return g > 0 && g <= 2000 ? g : 0;
}

function detectUnitFromText(segment: string, fallback: CoverageUnit = "any"): CoverageUnit {
  const s = segment.trim();
  if (/(סימן|סימנים|סי['׳"״]?)(?=\s|$|[א-ת0-9])/.test(s)) return "siman";
  if (/(דף|דפים|ד['׳])(?=\s|$|[א-ת0-9])/.test(s)) return "daf";
  if (/(פרק|פרקים|פ['׳])(?=\s|$|[א-ת0-9])/.test(s)) return "perek";
  if (/(עמוד|עמודים|עמ['׳])(?=\s|$|[א-ת0-9])/.test(s)) return "amud";
  return fallback;
}

export interface DetailedCoverageSegment extends ParsedCoverageSegment {
  rawStart: number;
  rawEnd: number;
  isReversed: boolean;
}

export function parseCoverageRangesDetailed(coverageStr: string | undefined | null): DetailedCoverageSegment[] {
  const raw = String(coverageStr || "").trim();
  if (!raw) return [];
  const parts = raw.split(/[,;/|·\u00B7]+/).map((p) => p.trim()).filter(Boolean);
  const out: DetailedCoverageSegment[] = [];
  let lastUnit: CoverageUnit = "any";

  for (const part of parts) {
    const unit = detectUnitFromText(part, lastUnit);
    if (unit !== "any") lastUnit = unit;
    const stripped = part
      .replace(/(סימנים|סימן|סי['׳"״]|דפים|דף|פרקים|פרק|עמודים|עמוד|עמ['׳])/g, " ")
      .replace(/\s+עד\s+/g, "-")
      .trim();

    const rangeRegex = /([א-ת"'״׳]{1,6}|\d{1,5})\s*[\-–—]+\s*([א-ת"'״׳]{1,6}|\d{1,5})/g;
    let matchedAnyRange = false;
    let m: RegExpExecArray | null;
    while ((m = rangeRegex.exec(stripped)) !== null) {
      const a = parseHebrewOrArabicNumber(m[1]);
      const b = parseHebrewOrArabicNumber(m[2]);
      if (a > 0 && b > 0) {
        out.push({
          unit,
          start: Math.min(a, b),
          end: Math.max(a, b),
          rawStart: a,
          rawEnd: b,
          isReversed: a > b,
          raw: part,
        });
        matchedAnyRange = true;
      }
    }
    if (!matchedAnyRange) {
      const tokens = stripped.split(/\s+/).filter(Boolean);
      for (const tok of tokens) {
        const val = parseHebrewOrArabicNumber(tok);
        if (val > 0) {
          out.push({ unit, start: val, end: val, rawStart: val, rawEnd: val, isReversed: false, raw: part });
        }
      }
    }
  }
  return out;
}

export function parseCoverageRanges(coverageStr: string | undefined | null): ParsedCoverageSegment[] {
  return parseCoverageRangesDetailed(coverageStr).map(({ unit, start, end, raw }) => ({
    unit,
    start,
    end,
    raw,
  }));
}

export function extractQueryCoverageTargets(rawQuery: string): CoverageQueryTarget[] {
  const q = String(rawQuery || "").trim();
  if (!q) return [];
  const tokens = q
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[()\[\],]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const targets: CoverageQueryTarget[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i];
    const cleanCur = cur.replace(/["'״׳]/g, "");
    let markerUnit: CoverageUnit | null = null;
    if (/^(סימן|סימנים|סי)$/.test(cleanCur)) markerUnit = "siman";
    else if (/^(דף|דפים)$/.test(cleanCur)) markerUnit = "daf";
    else if (/^(פרק|פרקים)$/.test(cleanCur)) markerUnit = "perek";
    else if (/^(עמוד|עמודים|עמ)$/.test(cleanCur)) markerUnit = "amud";

    if (markerUnit && i + 1 < tokens.length) {
      const val = parseHebrewOrArabicNumber(tokens[i + 1]);
      if (val > 0) {
        targets.push({
          unit: markerUnit,
          value: val,
          displayToken: formatCoverageDisplayValue(tokens[i + 1], val),
          explicit: true,
          tokenStartIdx: i,
          tokenCount: 2,
        });
        i++;
        continue;
      }
    }

    // Handle attached prefix like ס"ה / 65 / כ"ד when multiple tokens exist
    const numVal = parseHebrewOrArabicNumber(cur);
    if (numVal > 0 && (/^\d+$/.test(cur) || cur.length >= 2 || tokens.length > 1)) {
      targets.push({
        unit: "any",
        value: numVal,
        displayToken: formatCoverageDisplayValue(cur, numVal),
        explicit: false,
        tokenStartIdx: i,
        tokenCount: 1,
      });
    }
  }
  return targets;
}

function formatCoverageDisplayValue(rawToken: string, numVal: number): string {
  const trimmed = rawToken.trim();
  if (/^\d+$/.test(trimmed)) {
    return numberToHebrewGematriya(numVal);
  }
  return trimmed;
}

function unitLabelHe(unit: CoverageUnit): string {
  if (unit === "siman") return "סימן";
  if (unit === "daf") return "דף";
  if (unit === "perek") return "פרק";
  if (unit === "amud") return "עמוד";
  return "סימן/קטע";
}

export function matchCoverageRange(
  coverageRange: string | undefined | null,
  targets: CoverageQueryTarget[]
): CoverageMatchResult | null {
  const cleanCov = String(coverageRange || "").trim();
  if (!cleanCov || targets.length === 0) return null;
  const segments = parseCoverageRanges(cleanCov);
  if (segments.length === 0) return null;

  let best: CoverageMatchResult | null = null;
  for (const t of targets) {
    for (const seg of segments) {
      const unitMatches = seg.unit === "any" || t.unit === "any" || seg.unit === t.unit;
      if (!unitMatches) continue;
      if (t.value >= seg.start && t.value <= seg.end) {
        const effUnit = t.unit !== "any" ? t.unit : seg.unit;
        const hint = `מכיל ${unitLabelHe(effUnit)} ${t.displayToken} · ${cleanCov}`;
        const candidate: CoverageMatchResult = {
          matched: true,
          explicit: t.explicit,
          unit: effUnit,
          value: t.value,
          hint,
        };
        if (!best || (candidate.explicit && !best.explicit)) {
          best = candidate;
        }
      }
    }
  }
  return best;
}


export function formatHebrewNumeralWithPunctuation(num: number): string {
  const letters = numberToHebrewGematriya(num);
  if (!letters || /^\d+$/.test(letters)) return letters;
  if (letters.length === 1) return letters + "'";
  return letters.slice(0, -1) + '"' + letters.slice(-1);
}

function unitPluralLabelHe(unit: CoverageUnit): string {
  if (unit === "siman") return "סימנים";
  if (unit === "daf") return "דפים";
  if (unit === "perek") return "פרקים";
  if (unit === "amud") return "עמודים";
  return "";
}

function unitSingularLabelHe(unit: CoverageUnit): string {
  if (unit === "siman") return "סימן";
  if (unit === "daf") return "דף";
  if (unit === "perek") return "פרק";
  if (unit === "amud") return "עמוד";
  return "";
}

export function inferDominantCoverageUnit(ranges: Array<string | undefined | null>): CoverageUnit {
  const counts: Record<Exclude<CoverageUnit, "any">, number> = {
    siman: 0,
    daf: 0,
    perek: 0,
    amud: 0,
  };
  for (const r of ranges) {
    const clean = String(r || "").trim();
    if (!clean) continue;
    const segs = parseCoverageRanges(clean);
    for (const s of segs) {
      if (s.unit !== "any") counts[s.unit]++;
    }
  }
  let best: CoverageUnit = "any";
  let bestCount = 0;
  for (const u of ["siman", "daf", "perek", "amud"] as const) {
    if (counts[u] > bestCount) {
      bestCount = counts[u];
      best = u;
    }
  }
  return best;
}

export function normalizeCoverageRange(
  raw: string | undefined | null,
  preferredUnit: CoverageUnit = "any"
): string {
  const str = String(raw || "").trim();
  if (!str) return "";
  const segs = parseCoverageRanges(str);
  if (segs.length === 0) {
    // Standardize dashes & Hebrew punctuation to ASCII
    return str
      .replace(/([א-ת])['`׳]/g, "$1'")
      .replace(/([א-ת])["״]/g, '$1"')
      .replace(/\s*[-–—]+\s*/g, "-")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  const formattedSegments = segs.map((seg) => {
    const unit = seg.unit !== "any" ? seg.unit : preferredUnit;
    const startHeb = formatHebrewNumeralWithPunctuation(seg.start);
    const endHeb = formatHebrewNumeralWithPunctuation(seg.end);
    if (seg.start === seg.end) {
      const prefix = unitSingularLabelHe(unit);
      return prefix ? `${prefix} ${startHeb}` : startHeb;
    }
    const prefix = unitPluralLabelHe(unit);
    return prefix ? `${prefix} ${startHeb}-${endHeb}` : `${startHeb}-${endHeb}`;
  });
  return Array.from(new Set(formattedSegments)).join(" · ");
}

export function extractVolumeNumberIndex(
  volume: string | undefined | null,
  setGlobalNumber?: number | null
): number | null {
  const s = String(volume || "").trim();
  if (s) {
    const cleaned = s
      .replace(/^(כרך|חלק|ספר|כ['"״׳]|ח['"״׳])\s+/i, "")
      .replace(/["'״׳]/g, "")
      .trim();
    // Avoid matching full tractate / Chumash names as volume numbers
    const hasPrefix = /^(כרך|חלק|ספר|כ['"״׳]|ח['"״׳])\s+/i.test(s);
    if (/^\d{1,3}$/.test(cleaned)) {
      const n = parseInt(cleaned, 10);
      if (n > 0 && n <= 200) return n;
    }
    const roman = parseRomanNumeral(cleaned);
    if (roman > 0 && roman <= 100) return roman;
    // Only interpret Hebrew letters as a volume number if <= 3 letters AND (hasPrefix or single/2-letter gematria <= 60)
    if (/^[א-ת]{1,3}$/.test(cleaned)) {
      const g = hebrewGematriya(cleaned);
      if (g > 0 && (hasPrefix || g <= 60) && torahSubSeriesRank(cleaned) === 999999) {
        return g;
      }
    }
    // Check explicit trailing volume number after dash e.g. "בראשית / חלק א'" or "מסכת שבת - כרך ג'"
    const tail = s.match(/(?:כרך|חלק|ספר)\s+([א-ת]{1,3}['"״׳]?|\d{1,3})\s*$/);
    if (tail) {
      const tok = tail[1].replace(/["'״׳]/g, "");
      if (/^\d+$/.test(tok)) {
        const n = parseInt(tok, 10);
        if (n > 0 && n <= 200) return n;
      }
      const g = hebrewGematriya(tok);
      if (g > 0 && g <= 100) return g;
    }
  }
  if (setGlobalNumber != null && Number.isFinite(Number(setGlobalNumber)) && Number(setGlobalNumber) > 0 && Number(setGlobalNumber) <= 200) {
    return Math.round(Number(setGlobalNumber));
  }
  return null;
}

export function buildMissingVolumeLabel(index: number, sampleVolume?: string): string {
  const sample = String(sampleVolume || "").trim();
  if (/^\d+$/.test(sample)) return String(index);
  if (/^חלק\s+/.test(sample)) return `חלק ${formatHebrewNumeralWithPunctuation(index)}`;
  if (/^ספר\s+/.test(sample)) return `ספר ${formatHebrewNumeralWithPunctuation(index)}`;
  return `כרך ${formatHebrewNumeralWithPunctuation(index)}`;
}

export interface MissingVolumeSlot {
  key: string;
  setName: string;
  subSeries: string;
  slotType: "volume" | "global";
  kind?: "missing" | "anomaly";
  index: number;
  gapSize?: number;
  suggestedVolume: string;
  suggestedGlobalNumber: number | null;
  sourceBookBarcode?: string;
  sourceBookTitle?: string;
  anomalyMessage?: string;
  ignored: boolean;
}

export interface CoverageBookInput {
  barcode?: string;
  title?: string;
  set_name?: string;
  sub_series?: string;
  volume?: string;
  coverage_range?: string;
  set_global_number?: number | null;
}

export interface CoverageVolumeSuggestion {
  barcode: string;
  title: string;
  setName: string;
  subSeries: string;
  coverageRange: string;
  unit: CoverageUnit;
  start: number;
  end: number;
  inferredIndex: number;
  suggestedVolume: string;
  startsAfterNaturalBeginning: boolean;
  startWarning?: string;
}

export type CoverageAnomalyKind =
  | "reversed_range"
  | "volume_order_inversion"
  | "significant_overlap"
  | "outlier_span"
  | "outlier_jump";

export interface CoverageAnomalyWarning {
  key: string;
  kind: CoverageAnomalyKind;
  barcode: string;
  title: string;
  setName: string;
  subSeries: string;
  coverageRange: string;
  volIndex: number | null;
  message: string;
  siblingHint?: string;
  ignored: boolean;
}

export function makeMissingVolumeIgnoreKey(
  setName: string,
  subSeries: string,
  slotType: "volume" | "global",
  index: number
): string {
  return `${setName.trim().toLowerCase()}::${subSeries.trim().toLowerCase()}::${slotType}::${index}`;
}

export function makeCoverageAnomalyIgnoreKey(
  setName: string,
  subSeries: string,
  anomalyKind: CoverageAnomalyKind,
  barcode: string,
  coverageRange: string
): string {
  const normCov = String(coverageRange || "").trim().toLowerCase().replace(/\s+/g, " ");
  return `cov_anomaly::${setName.trim().toLowerCase()}::${subSeries.trim().toLowerCase()}::${anomalyKind}::${barcode.trim()}::${normCov}`;
}

function getPrimaryDetailedSegment(
  coverageStr: string | undefined | null,
  dominantUnit: CoverageUnit
): DetailedCoverageSegment | null {
  const segs = parseCoverageRangesDetailed(coverageStr);
  if (segs.length === 0) return null;
  if (dominantUnit !== "any") {
    const exact = segs.find((s) => s.unit === dominantUnit);
    if (exact) return exact;
    const generic = segs.find((s) => s.unit === "any");
    if (generic) return { ...generic, unit: dominantUnit };
  }
  return segs[0];
}

function detectPrefixStyleForGroup(
  groupBooks: CoverageBookInput[],
  allSetBooks: CoverageBookInput[],
  subSeries: string
): string {
  const collectSample = (list: CoverageBookInput[]) => {
    for (const b of list) {
      const v = String(b.volume || "").trim();
      if (!v) continue;
      if (/^\d+$/.test(v) || /^חלק\s+/.test(v) || /^כרך\s+/.test(v) || /^ספר\s+/.test(v)) {
        return v;
      }
    }
    return "";
  };
  const fromGroup = collectSample(groupBooks);
  if (fromGroup) return fromGroup;
  const fromSet = collectSample(allSetBooks);
  if (fromSet) return fromSet;
  return subSeries ? "חלק א'" : "כרך א'";
}

function isNaturalCoverageStart(unit: CoverageUnit, startVal: number): boolean {
  if (unit === "daf") return startVal <= 2;
  return startVal <= 1;
}

export function inferVolumesFromCoverage(
  books: CoverageBookInput[],
  setName: string
): CoverageVolumeSuggestion[] {
  const cleanSet = String(setName || "").trim();
  if (!cleanSet || !Array.isArray(books) || books.length < 2) return [];

  const bySub = new Map<string, CoverageBookInput[]>();
  for (const b of books) {
    const sub = String(b.sub_series || "").trim();
    const arr = bySub.get(sub) || [];
    arr.push(b);
    bySub.set(sub, arr);
  }

  const suggestions: CoverageVolumeSuggestion[] = [];

  for (const [subSeries, groupBooks] of bySub.entries()) {
    const domUnit = inferDominantCoverageUnit(groupBooks.map((b) => String(b.coverage_range || "")));
    type RangeItem = {
      book: CoverageBookInput;
      seg: DetailedCoverageSegment;
      effectiveUnit: CoverageUnit;
      explicitIdx: number | null;
      rangeKey: string;
    };
    const items: RangeItem[] = [];
    for (const b of groupBooks) {
      const seg = getPrimaryDetailedSegment(b.coverage_range, domUnit);
      if (!seg || seg.isReversed) continue;
      const effUnit = seg.unit !== "any" ? seg.unit : domUnit;
      if (domUnit !== "any" && effUnit !== domUnit) continue;
      const explicitIdx = extractVolumeNumberIndex(b.volume, null);
      items.push({
        book: b,
        seg,
        effectiveUnit: effUnit,
        explicitIdx,
        rangeKey: `${seg.start}-${seg.end}`,
      });
    }

    const clusterMap = new Map<string, { start: number; end: number; unit: CoverageUnit; items: RangeItem[] }>();
    for (const it of items) {
      const existing = clusterMap.get(it.rangeKey);
      if (existing) {
        existing.items.push(it);
      } else {
        clusterMap.set(it.rangeKey, {
          start: it.seg.start,
          end: it.seg.end,
          unit: it.effectiveUnit,
          items: [it],
        });
      }
    }

    // Require at least 2 distinct coverage ranges in this sub-series/group
    if (clusterMap.size < 2) continue;

    const sortedClusters = Array.from(clusterMap.values()).sort((a, b) =>
      a.start !== b.start ? a.start - b.start : a.end - b.end
    );

    const sampleVolStyle = detectPrefixStyleForGroup(groupBooks, books, subSeries);
    const hasExplicitVol1 = groupBooks.some((b) => extractVolumeNumberIndex(b.volume, null) === 1);
    const firstCluster = sortedClusters[0];
    const startsAfterNaturalBeginning =
      !hasExplicitVol1 && !isNaturalCoverageStart(firstCluster.unit, firstCluster.start);
    const startWarning = startsAfterNaturalBeginning
      ? `הטווח הראשון מתחיל מ-${unitLabelHe(firstCluster.unit)} ${formatHebrewNumeralWithPunctuation(firstCluster.start)} — ייתכן שהכרך הראשון חסר`
      : undefined;

    let nextMinIndex = 1;
    for (const cluster of sortedClusters) {
      const explicitIndices = cluster.items
        .map((x) => x.explicitIdx)
        .filter((n): n is number => n != null && n > 0);
      let assignedIdx = nextMinIndex;
      if (explicitIndices.length > 0) {
        const anchor = Math.min(...explicitIndices);
        if (anchor >= nextMinIndex) {
          assignedIdx = anchor;
        }
      }
      nextMinIndex = Math.max(nextMinIndex, assignedIdx) + 1;

      for (const it of cluster.items) {
        const rawVol = String(it.book.volume || "").trim();
        const bc = String(it.book.barcode || "").trim();
        if (!rawVol && it.explicitIdx == null && bc) {
          suggestions.push({
            barcode: bc,
            title: String(it.book.title || "").trim(),
            setName: cleanSet,
            subSeries,
            coverageRange: String(it.book.coverage_range || "").trim(),
            unit: cluster.unit,
            start: cluster.start,
            end: cluster.end,
            inferredIndex: assignedIdx,
            suggestedVolume: buildMissingVolumeLabel(assignedIdx, sampleVolStyle),
            startsAfterNaturalBeginning,
            ...(startWarning ? { startWarning } : {}),
          });
        }
      }
    }
  }

  return suggestions;
}

function medianPositive(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatUnitValue(unit: CoverageUnit, val: number): string {
  const lbl = unit === "any" ? "" : `${unitLabelHe(unit)} `;
  return `${lbl}${formatHebrewNumeralWithPunctuation(val)}`.trim();
}

export function detectCoverageAnomaliesForSet(
  books: CoverageBookInput[],
  setName: string,
  ignoredKeys?: Set<string>
): CoverageAnomalyWarning[] {
  const cleanSet = String(setName || "").trim();
  if (!cleanSet || !Array.isArray(books) || books.length === 0) return [];

  const warnings: CoverageAnomalyWarning[] = [];
  const emittedKeys = new Set<string>();

  const pushWarning = (w: Omit<CoverageAnomalyWarning, "key" | "ignored">) => {
    const key = makeCoverageAnomalyIgnoreKey(cleanSet, w.subSeries, w.kind, w.barcode, w.coverageRange);
    if (emittedKeys.has(key)) return;
    emittedKeys.add(key);
    warnings.push({
      ...w,
      key,
      ignored: Boolean(ignoredKeys?.has(key)),
    });
  };

  const bySub = new Map<string, CoverageBookInput[]>();
  for (const b of books) {
    const sub = String(b.sub_series || "").trim();
    const arr = bySub.get(sub) || [];
    arr.push(b);
    bySub.set(sub, arr);
  }

  for (const [subSeries, groupBooks] of bySub.entries()) {
    const domUnit = inferDominantCoverageUnit(groupBooks.map((b) => String(b.coverage_range || "")));
    type ParsedEntry = {
      book: CoverageBookInput;
      barcode: string;
      title: string;
      coverageRange: string;
      seg: DetailedCoverageSegment;
      effectiveUnit: CoverageUnit;
      volIdx: number | null;
      span: number;
    };

    const parsedEntries: ParsedEntry[] = [];

    for (const b of groupBooks) {
      const bc = String(b.barcode || "").trim();
      const title = String(b.title || "").trim();
      const cov = String(b.coverage_range || "").trim();
      if (!cov) continue;
      const detailed = parseCoverageRangesDetailed(cov);
      if (detailed.length === 0) continue;

      const volIdx = extractVolumeNumberIndex(b.volume, null);
      const rev = detailed.find((s) => s.isReversed);
      if (rev) {
        pushWarning({
          kind: "reversed_range",
          barcode: bc,
          title,
          setName: cleanSet,
          subSeries,
          coverageRange: cov,
          volIndex: volIdx,
          message: `טווח הפוך בספר ${bc ? `#${bc}` : ""} (${title || subSeries || cleanSet}): "${rev.raw}" מתחיל מ-${formatHebrewNumeralWithPunctuation(rev.rawStart)} ומסתיים ב-${formatHebrewNumeralWithPunctuation(rev.rawEnd)}`,
        });
      }

      const primary = getPrimaryDetailedSegment(cov, domUnit);
      if (primary && !primary.isReversed) {
        const effUnit = primary.unit !== "any" ? primary.unit : domUnit;
        parsedEntries.push({
          book: b,
          barcode: bc,
          title,
          coverageRange: cov,
          seg: primary,
          effectiveUnit: effUnit,
          volIdx,
          span: primary.end - primary.start + 1,
        });
      }
    }

    const byUnit = new Map<CoverageUnit, ParsedEntry[]>();
    for (const e of parsedEntries) {
      const arr = byUnit.get(e.effectiveUnit) || [];
      arr.push(e);
      byUnit.set(e.effectiveUnit, arr);
    }

    for (const [unit, unitEntries] of byUnit.entries()) {
      if (unitEntries.length < 2) continue;

      // 1. Volume order inversion
      const withVol = unitEntries
        .filter((e) => e.volIdx != null && e.volIdx > 0)
        .sort((a, b) => (a.volIdx! !== b.volIdx! ? a.volIdx! - b.volIdx! : a.seg.start - b.seg.start));
      for (let i = 1; i < withVol.length; i++) {
        const prev = withVol[i - 1];
        const curr = withVol[i];
        if (curr.volIdx! > prev.volIdx! && curr.seg.start < prev.seg.start) {
          pushWarning({
            kind: "volume_order_inversion",
            barcode: curr.barcode,
            title: curr.title,
            setName: cleanSet,
            subSeries,
            coverageRange: curr.coverageRange,
            volIndex: curr.volIdx,
            message: `חוסר התאמה בין מספר החלק לטווח בספר ${curr.barcode ? `#${curr.barcode}` : ""}: חלק ${formatHebrewNumeralWithPunctuation(curr.volIdx!)} מתחיל ב-${formatUnitValue(unit, curr.seg.start)} לפני חלק ${formatHebrewNumeralWithPunctuation(prev.volIdx!)} שמתחיל ב-${formatUnitValue(unit, prev.seg.start)}`,
            siblingHint: `חלק ${formatHebrewNumeralWithPunctuation(prev.volIdx!)} (#${prev.barcode}): ${prev.coverageRange}`,
          });
        }
      }

      // 2. Significant overlap across distinct volumes (allowing 1-unit boundary overlap)
      const allSpans = unitEntries.map((e) => e.span);
      const groupMedSpan = medianPositive(allSpans);
      for (let i = 0; i < unitEntries.length; i++) {
        for (let j = i + 1; j < unitEntries.length; j++) {
          const a = unitEntries[i];
          const b = unitEntries[j];
          if (a.volIdx != null && b.volIdx != null && a.volIdx === b.volIdx) continue;
          if (a.seg.start === b.seg.start && a.seg.end === b.seg.end) continue;

          const overlap = Math.min(a.seg.end, b.seg.end) - Math.max(a.seg.start, b.seg.start) + 1;
          const minSpan = Math.min(a.span, b.span);
          const oneContainsOther =
            (a.seg.start <= b.seg.start && a.seg.end >= b.seg.end) ||
            (b.seg.start <= a.seg.start && b.seg.end >= a.seg.end);

          if (overlap >= 4 || (oneContainsOther && minSpan >= 3 && overlap >= 3)) {
            const diffA = Math.abs(a.span - groupMedSpan);
            const diffB = Math.abs(b.span - groupMedSpan);
            const suspect = diffA > diffB ? a : b;
            const other = suspect === a ? b : a;
            pushWarning({
              kind: "significant_overlap",
              barcode: suspect.barcode,
              title: suspect.title,
              setName: cleanSet,
              subSeries,
              coverageRange: suspect.coverageRange,
              volIndex: suspect.volIdx,
              message: `חשד לחפיפת טווח שגויה בספר ${suspect.barcode ? `#${suspect.barcode}` : ""} (${suspect.coverageRange}) מול כרך אחר (${other.barcode ? `#${other.barcode}: ` : ""}${other.coverageRange}) — חפיפה של ${overlap} יחידות`,
              siblingHint: `כרך מקביל (#${other.barcode}): ${other.coverageRange}`,
            });
          }
        }
      }

      // 3. Outlier span or implausible jump (requires >= 3 books so >= 2 reference siblings exist)
      if (unitEntries.length >= 3) {
        for (let i = 0; i < unitEntries.length; i++) {
          const cand = unitEntries[i];
          const otherSpans = unitEntries.filter((_, idx) => idx !== i).map((x) => x.span);
          const medOther = medianPositive(otherSpans);
          if (medOther >= 3 && cand.span >= Math.max(60, medOther * 3.5)) {
            pushWarning({
              kind: "outlier_span",
              barcode: cand.barcode,
              title: cand.title,
              setName: cleanSet,
              subSeries,
              coverageRange: cand.coverageRange,
              volIndex: cand.volIdx,
              message: `חשד לטעות הקלדה בטווח בספר ${cand.barcode ? `#${cand.barcode}` : ""} (${cand.coverageRange}) — אורך חריג של ${cand.span} יחידות לעומת ~ ${Math.round(medOther)} בכרכים המקבילים`,
            });
          }
        }

        if (withVol.length >= 3) {
          for (let i = 1; i < withVol.length; i++) {
            const prev = withVol[i - 1];
            const curr = withVol[i];
            if (curr.volIdx! === prev.volIdx! + 1 && curr.seg.start > prev.seg.end) {
              const otherSpans = withVol.filter((_, idx) => idx !== i).map((x) => x.span);
              const medOther = medianPositive(otherSpans);
              const gap = curr.seg.start - prev.seg.end;
              if (medOther >= 3 && gap > Math.max(60, medOther * 3)) {
                pushWarning({
                  kind: "outlier_jump",
                  barcode: curr.barcode,
                  title: curr.title,
                  setName: cleanSet,
                  subSeries,
                  coverageRange: curr.coverageRange,
                  volIndex: curr.volIdx,
                  message: `חשד לטעות הקלדה בתחילת הטווח בספר ${curr.barcode ? `#${curr.barcode}` : ""} (${curr.coverageRange}) — קפיצה של ${gap} יחידות אחרי סיום הכרך הקודם (${formatUnitValue(unit, prev.seg.end)})`,
                  siblingHint: `כרך קודם (#${prev.barcode}): ${prev.coverageRange}`,
                });
              }
            }
          }
        }
      }
    }
  }

  return warnings;
}

export function detectBookCoverageTypoWarnings(
  draftBook: CoverageBookInput,
  setBooks: CoverageBookInput[],
  ignoredKeys?: Set<string>
): CoverageAnomalyWarning[] {
  const cleanSet = String(draftBook.set_name || "").trim();
  const bc = String(draftBook.barcode || "").trim();
  const merged: CoverageBookInput[] = [];
  let replaced = false;
  for (const b of setBooks || []) {
    if (bc && String(b.barcode || "").trim() === bc) {
      merged.push(draftBook);
      replaced = true;
    } else {
      merged.push(b);
    }
  }
  if (!replaced) merged.push(draftBook);

  const effectiveSet = cleanSet || String(setBooks?.[0]?.set_name || "").trim() || "__single__";
  const all = detectCoverageAnomaliesForSet(merged, effectiveSet, ignoredKeys);
  const direct = all.filter((w) => !w.ignored && w.barcode === bc);

  const cov = String(draftBook.coverage_range || "").trim();
  if (!cov) return direct;
  const sub = String(draftBook.sub_series || "").trim();
  const sameSub = merged.filter((b) => String(b.sub_series || "").trim() === sub);
  const domUnit = inferDominantCoverageUnit(sameSub.map((b) => String(b.coverage_range || "")));
  const draftSeg = getPrimaryDetailedSegment(cov, domUnit);
  const draftVol = extractVolumeNumberIndex(draftBook.volume, null);
  if (draftSeg && !draftSeg.isReversed) {
    const draftUnit = draftSeg.unit !== "any" ? draftSeg.unit : domUnit;
    for (const sib of sameSub) {
      const sibBc = String(sib.barcode || "").trim();
      if (!sibBc || sibBc === bc) continue;
      const sibCov = String(sib.coverage_range || "").trim();
      const sibSeg = getPrimaryDetailedSegment(sibCov, domUnit);
      if (!sibSeg || sibSeg.isReversed) continue;
      const sibUnit = sibSeg.unit !== "any" ? sibSeg.unit : domUnit;
      if (sibUnit !== draftUnit) continue;
      const sibVol = extractVolumeNumberIndex(sib.volume, null);
      if (draftVol != null && sibVol != null && draftVol !== sibVol) {
        if (draftVol < sibVol && draftSeg.start > sibSeg.start) {
          const k = makeCoverageAnomalyIgnoreKey(effectiveSet, sub, "volume_order_inversion", bc, cov);
          if (!ignoredKeys?.has(k) && !direct.some((d) => d.key === k)) {
            direct.push({
              key: k,
              kind: "volume_order_inversion",
              barcode: bc,
              title: String(draftBook.title || "").trim(),
              setName: effectiveSet,
              subSeries: sub,
              coverageRange: cov,
              volIndex: draftVol,
              message: `חוסר התאמה בין מספר החלק לטווח: חלק ${formatHebrewNumeralWithPunctuation(draftVol)} מתחיל ב-${formatUnitValue(draftUnit, draftSeg.start)} אחרי חלק ${formatHebrewNumeralWithPunctuation(sibVol)} (#${sibBc}: ${sibCov})`,
              siblingHint: `חלק ${formatHebrewNumeralWithPunctuation(sibVol)} (#${sibBc}): ${sibCov}`,
              ignored: false,
            });
          }
        }
        const overlap = Math.min(draftSeg.end, sibSeg.end) - Math.max(draftSeg.start, sibSeg.start) + 1;
        const minSpan = Math.min(draftSeg.end - draftSeg.start + 1, sibSeg.end - sibSeg.start + 1);
        const oneContainsOther =
          (draftSeg.start <= sibSeg.start && draftSeg.end >= sibSeg.end) ||
          (sibSeg.start <= draftSeg.start && sibSeg.end >= draftSeg.end);
        if (overlap >= 4 || (oneContainsOther && minSpan >= 3 && overlap >= 3)) {
          const k = makeCoverageAnomalyIgnoreKey(effectiveSet, sub, "significant_overlap", bc, cov);
          if (!ignoredKeys?.has(k) && !direct.some((d) => d.key === k)) {
            direct.push({
              key: k,
              kind: "significant_overlap",
              barcode: bc,
              title: String(draftBook.title || "").trim(),
              setName: effectiveSet,
              subSeries: sub,
              coverageRange: cov,
              volIndex: draftVol,
              message: `חפיפה של ${overlap} יחידות מול כרך #${sibBc} (${sibCov})`,
              siblingHint: `כרך מקביל (#${sibBc}): ${sibCov}`,
              ignored: false,
            });
          }
        }
      }
    }
  }

  return direct;
}

export function computeMissingSetSlots(
  books: CoverageBookInput[],
  setName: string,
  ignoredKeys?: Set<string>
): MissingVolumeSlot[] {
  const cleanSet = String(setName || "").trim();
  if (!cleanSet || !Array.isArray(books) || books.length === 0) return [];

  const slots: MissingVolumeSlot[] = [];
  const seenKeys = new Set<string>();

  type BookEntry = (typeof books)[number];
  const bySub = new Map<string, BookEntry[]>();
  for (const b of books) {
    const sub = String(b.sub_series || "").trim();
    const arr = bySub.get(sub) || [];
    arr.push(b);
    bySub.set(sub, arr);
  }

  // Detect consecutive single-book sub-series across the set (e.g., Chumashim Bereshit..Devarim where volume is חלק א'..ה')
  const namedSubs = Array.from(bySub.entries()).filter(([s]) => s !== "");
  const singleSubCandidates = namedSubs.filter(([, list]) => {
    if (list.length !== 1) return false;
    const b = list[0];
    if (String(b.coverage_range || "").trim()) return false;
    const idx = extractVolumeNumberIndex(b.volume, null);
    return idx != null && idx > 0;
  });
  const distinctSingleSubIndices = new Set(
    singleSubCandidates
      .map(([, list]) => extractVolumeNumberIndex(list[0].volume, null))
      .filter((n): n is number => n != null && n > 0)
  );
  const consecutiveSingleBookSubSeriesNames = new Set<string>();
  const singleSubGlobalCandidates = new Map<number, BookEntry>();
  if (
    namedSubs.length >= 2 &&
    singleSubCandidates.length >= 2 &&
    distinctSingleSubIndices.size === singleSubCandidates.length
  ) {
    for (const [subName, list] of singleSubCandidates) {
      consecutiveSingleBookSubSeriesNames.add(subName);
      const idx = extractVolumeNumberIndex(list[0].volume, null)!;
      if (!singleSubGlobalCandidates.has(idx)) {
        singleSubGlobalCandidates.set(idx, list[0]);
      }
    }
  }

  // Helper to find gaps vs. >20 gap anomalies from sorted index->sourceBook entries
  const emitSequenceGapsAndAnomalies = (
    indexToBook: Map<number, BookEntry>,
    subSeries: string,
    slotType: "volume" | "global",
    sampleVol: string,
    hasGlobalInSet: boolean,
    maxAllowed: number
  ) => {
    const sortedEntries = Array.from(indexToBook.entries())
      .filter(([idx]) => idx > 0 && idx <= maxAllowed)
      .sort((a, b) => a[0] - b[0]);
    if (sortedEntries.length === 0) return;
    const maxIdx = sortedEntries[sortedEntries.length - 1][0];
    if (maxIdx < 2) return;

    let prev = 0;
    for (const [currIdx, srcBook] of sortedEntries) {
      const gap = currIdx - prev - 1;
      const srcBarcode = String(srcBook.barcode || "").trim() || undefined;
      const srcTitle = String(srcBook.title || "").trim() || undefined;
      if (gap > 20) {
        const aKey = makeMissingVolumeIgnoreKey(cleanSet, subSeries, slotType, currIdx);
        if (!seenKeys.has(aKey)) {
          seenKeys.add(aKey);
          slots.push({
            key: aKey,
            setName: cleanSet,
            subSeries,
            slotType,
            kind: "anomaly",
            index: currIdx,
            gapSize: gap,
            suggestedVolume: buildMissingVolumeLabel(currIdx, sampleVol),
            suggestedGlobalNumber: slotType === "global" ? currIdx : null,
            sourceBookBarcode: srcBarcode,
            sourceBookTitle: srcTitle,
            anomalyMessage: `טעות מספור אפשרית בספר ${srcBarcode ? `#${srcBarcode}` : ""}${srcTitle ? ` (${srcTitle})` : ""} — פער של ${gap} כרכים לפני כרך ${currIdx}`,
            ignored: Boolean(ignoredKeys?.has(aKey)),
          });
        }
      } else if (gap > 0) {
        for (let i = prev + 1; i < currIdx; i++) {
          if (slotType === "global") {
            const rootVolKey = makeMissingVolumeIgnoreKey(cleanSet, "", "volume", i);
            if (seenKeys.has(rootVolKey)) continue;
          }
          const key = makeMissingVolumeIgnoreKey(cleanSet, subSeries, slotType, i);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          slots.push({
            key,
            setName: cleanSet,
            subSeries,
            slotType,
            kind: "missing",
            index: i,
            suggestedVolume:
              slotType === "global" && bySub.size > 1 ? "" : buildMissingVolumeLabel(i, sampleVol),
            suggestedGlobalNumber:
              slotType === "global" ? i : subSeries === "" && hasGlobalInSet ? i : null,
            sourceBookBarcode: srcBarcode,
            sourceBookTitle: srcTitle,
            ignored: Boolean(ignoredKeys?.has(key)),
          });
        }
      }
      prev = currIdx;
    }
  };

  // Track global numbers across the set
  const globalIndexToBook = new Map<number, BookEntry>();
  let explicitGlobalCount = 0;
  for (const b of books) {
    const gn = b.set_global_number != null ? Number(b.set_global_number) : 0;
    if (Number.isFinite(gn) && gn > 0) {
      explicitGlobalCount += 1;
      const rounded = Math.round(gn);
      if (!globalIndexToBook.has(rounded)) globalIndexToBook.set(rounded, b);
    }
  }

  const inferredCoverageVols = inferVolumesFromCoverage(books, cleanSet);
  const inferredByBarcode = new Map<string, CoverageVolumeSuggestion>(
    inferredCoverageVols.map((s) => [s.barcode, s])
  );

  // 1. Per sub_series volume sequence gaps (skipping consecutive single-book sub-series)
  for (const [subSeries, list] of bySub.entries()) {
    if (subSeries && consecutiveSingleBookSubSeriesNames.has(subSeries)) {
      continue;
    }
    const volIndexToBook = new Map<number, BookEntry>();
    let sampleVol = "";
    for (const b of list) {
      const bc = String(b.barcode || "").trim();
      const inferred = bc ? inferredByBarcode.get(bc) : undefined;
      if (!sampleVol && String(b.volume || "").trim()) sampleVol = String(b.volume || "").trim();
      if (!sampleVol && inferred?.suggestedVolume) sampleVol = inferred.suggestedVolume;
      const idx = extractVolumeNumberIndex(b.volume, null) ?? inferred?.inferredIndex ?? null;
      if (idx != null && idx > 0 && !volIndexToBook.has(idx)) {
        volIndexToBook.set(idx, b);
      }
    }
    if (volIndexToBook.size === 0) continue;
    emitSequenceGapsAndAnomalies(
      volIndexToBook,
      subSeries,
      "volume",
      sampleVol,
      explicitGlobalCount > 0,
      150
    );
  }

  // 1b. Coverage range typo / anomaly detection across sibling volumes
  const covAnomalies = detectCoverageAnomaliesForSet(books, cleanSet, ignoredKeys);
  for (const ca of covAnomalies) {
    if (seenKeys.has(ca.key)) continue;
    seenKeys.add(ca.key);
    slots.push({
      key: ca.key,
      setName: cleanSet,
      subSeries: ca.subSeries,
      slotType: "volume",
      kind: "anomaly",
      index: ca.volIndex || 0,
      suggestedVolume: "",
      suggestedGlobalNumber: null,
      sourceBookBarcode: ca.barcode || undefined,
      sourceBookTitle: ca.title || undefined,
      anomalyMessage: ca.message,
      ignored: ca.ignored,
    });
  }

  // 2. Overall set_global_number sequence gaps across the whole set
  // Only run when at least 50% of books in the set actually carry set_global_number (or consecutive single-book sub-series)
  const useGlobalThreshold = explicitGlobalCount >= Math.ceil(books.length * 0.5);
  const useSingleSubGlobal = consecutiveSingleBookSubSeriesNames.size >= 2 && namedSubs.length === consecutiveSingleBookSubSeriesNames.size;

  if (useGlobalThreshold || useSingleSubGlobal) {
    if (useSingleSubGlobal) {
      for (const [idx, b] of singleSubGlobalCandidates.entries()) {
        if (!globalIndexToBook.has(idx)) {
          globalIndexToBook.set(idx, b);
        }
      }
    }
    let sampleGlobalVol = "";
    for (const b of books) {
      if (!sampleGlobalVol && String(b.volume || "").trim()) sampleGlobalVol = String(b.volume || "").trim();
    }
    emitSequenceGapsAndAnomalies(
      globalIndexToBook,
      "",
      "global",
      sampleGlobalVol,
      true,
      200
    );
  }

  return slots;
}

function isSymbolicVolumeMarker(vol: string): boolean {
  return /(\*+|•+|★+|✦+|●+|◆+|▪+|◊+)/.test(vol);
}

function hasExplicitVolumeNumberSuffix(vol: string): boolean {
  if (extractVolumeNumberIndex(vol, null) != null) return true;
  const stripped = vol.replace(/^(חלק|כרך|ספר|מסכת|ח['"״׳]|כ['"״׳])\s*/i, "").trim();
  if (/(?:חלק|כרך|ספר)\s*([א-ת]{1,2}|\d+)['"״׳]?\s*$/.test(stripped)) return true;
  if (/\d+\s*$/.test(stripped)) return true;
  return false;
}

export function isVolumeAlreadyInTitle(title: string | undefined | null, volume: string | undefined | null): boolean {
  const rawTitle = String(title || "").trim().replace(/["״]/g, '"').replace(/['׳]/g, "'");
  const rawVol = String(volume || "").trim().replace(/["״]/g, '"').replace(/['׳]/g, "'");
  if (!rawTitle || !rawVol) return false;
  const normTitle = normalizeCanonInput(rawTitle);
  const normVol = normalizeCanonInput(rawVol);
  if (!normTitle || !normVol) return false;
  if (normTitle === normVol) return true;
  const escRaw = escapeRegExpCanon(rawVol);
  const sepEndRe = new RegExp("(?:[\\-–—·/(]|^)\\s*" + escRaw + "\\)?\\s*$");
  if (normVol.length <= 2) {
    return sepEndRe.test(rawTitle);
  }
  return normTitle.endsWith(" " + normVol) || sepEndRe.test(rawTitle);
}

export function shouldSuppressSingleVolumeLabel(
  book: {
    set_name?: string;
    sub_series?: string;
    volume?: string;
    coverage_range?: string;
    title?: string;
  },
  sameSetBooks?: Array<{
    sub_series?: string;
    volume?: string;
    coverage_range?: string;
    title?: string;
  }>
): boolean {
  const vol = String(book.volume || "").trim();
  if (!vol) return false;

  const sub = String(book.sub_series || "").trim();
  const titleStr = String(book.title || "").trim();

  // Always suppress pure non-numeric tractate / Chumash / sub-series labels misplaced in volume
  // (e.g. volume="מסכת מכות" when sub_series/title already has "מסכת מכות", even if coverage_range exists)
  if (!isSymbolicVolumeMarker(vol) && !hasExplicitVolumeNumberSuffix(vol)) {
    const volWithoutPrefix = vol.replace(/^(?:כרך|חלק|ספר|מסכת|חומש)\s+/g, "").trim();
    if (torahSubSeriesRank(volWithoutPrefix) < 999999 || torahSubSeriesRank(vol) < 999999) {
      return true;
    }
    const normVol = normalizeCanonInput(vol);
    const normSub = normalizeCanonInput(sub);
    if (normVol && normSub && (normVol === normSub || normSub.startsWith(normVol) || normSub.endsWith(normVol))) {
      return true;
    }
    const normTitle = normalizeCanonInput(titleStr);
    if (normVol && normTitle && (normTitle === normVol || normTitle.endsWith(" " + normVol))) {
      return true;
    }
  }

  const cov = String(book.coverage_range || "").trim();
  if (cov) return false;

  const setBooks = Array.isArray(sameSetBooks) ? sameSetBooks : [];

  if (sub) {
    const siblings = setBooks.filter((b) => String(b.sub_series || "").trim() === sub);
    if (siblings.length <= 1) return true;
    const distinctVols = new Set(siblings.map((b) => String(b.volume || "").trim()).filter(Boolean));
    const anyCov = siblings.some((b) => Boolean(String(b.coverage_range || "").trim()));
    if (distinctVols.size <= 1 && !anyCov) return true;
    return false;
  }

  // When sub_series is empty, check if volume is just a tractate / Chumash name without distinct numerals
  if (/^(?:כרך|חלק|ספר)?\s*(?:מסכת|חומש|סדר)?\s*[א-ת]+/i.test(vol)) {
    const volWithoutPrefix = vol.replace(/^(?:כרך|חלק|ספר|מסכת|חומש)\s+/g, "").trim();
    if (torahSubSeriesRank(volWithoutPrefix) < 999999 || torahSubSeriesRank(vol) < 999999) {
      return true;
    }
  }

  if (setBooks.length > 0) {
    const allSubs = setBooks.map((b) => String(b.sub_series || "").trim()).filter(Boolean);
    if (allSubs.length >= 2) {
      return true;
    }
  }

  return false;
}

export interface TitleTemplateDerivationParams {
  setName: string;
  subSeries?: string;
  volume?: string;
  coverageRange?: string;
  sampleBooks?: Array<{
    title?: string;
    set_name?: string;
    sub_series?: string;
    volume?: string;
    coverage_range?: string;
  }>;
}

export function deriveTitleFromSetTemplate(params: TitleTemplateDerivationParams): string {
  const cleanSet = String(params.setName || "").trim();
  const cleanSub = String(params.subSeries || "").trim();
  let cleanVol = String(params.volume || "").trim();
  const cleanCov = String(params.coverageRange || "").trim();
  const samples = Array.isArray(params.sampleBooks) ? params.sampleBooks : [];

  if (!cleanSet) {
    if (cleanSub && cleanVol) return `${cleanSub} · ${cleanVol}`;
    return cleanSub || cleanVol || "";
  }

  if (cleanVol && shouldSuppressSingleVolumeLabel(
    { set_name: cleanSet, sub_series: cleanSub, volume: cleanVol, coverage_range: cleanCov },
    samples
  )) {
    cleanVol = "";
  }

  // Check if existing sample books in the set omit volume from their title (e.g. "Set - מסכת ברכות")
  if (cleanSub && cleanVol && samples.length > 0) {
    const samplesWithSubAndVol = samples.filter(
      (s) =>
        String(s.title || "").trim().length > 0 &&
        String(s.sub_series || "").trim().length > 0 &&
        String(s.volume || "").trim().length > 0
    );
    const samplesIncludingVolInTitle = samplesWithSubAndVol.filter((s) => {
      const st = String(s.title || "").trim();
      const sv = String(s.volume || "").trim();
      if (st.includes(sv)) return true;
      const stripped = sv.replace(/^(?:כרך|חלק|ספר)\s+/g, "").trim();
      return Boolean(
        stripped &&
          (st.endsWith(` ${stripped}`) ||
            st.endsWith(`-${stripped}`) ||
            st.includes(`(${stripped})`) ||
            st.includes(`(${sv})`))
      );
    });
    const anySampleEndsWithSub = samples.some((s) => {
      const st = String(s.title || "").trim();
      const ss = String(s.sub_series || "").trim();
      return Boolean(st && ss && st.endsWith(ss));
    });
    const anySampleHasVolInTitle = samples.some((s) => {
      const st = String(s.title || "").trim();
      const sv = String(s.volume || "").trim();
      if (!st || !sv) return false;
      if (st.includes(sv)) return true;
      const stripped = sv.replace(/^(?:כרך|חלק|ספר)\s+/g, "").trim();
      return Boolean(
        stripped &&
          (st.endsWith(` ${stripped}`) || st.endsWith(`-${stripped}`) || st.includes(`(${stripped})`))
      );
    });
    if (
      (samplesWithSubAndVol.length > 0 && samplesIncludingVolInTitle.length === 0) ||
      (anySampleEndsWithSub && !anySampleHasVolInTitle)
    ) {
      cleanVol = "";
    }
  }

  const validTitles = samples
    .map((s) => String(s.title || "").trim())
    .filter((t) => t.length > 0 && t.startsWith(cleanSet));

  if (validTitles.length > 0) {
    let sampleSep = " · ";
    const firstSample = validTitles[0];
    const afterSet = firstSample.slice(cleanSet.length).trim();
    if (afterSet.startsWith("·")) sampleSep = " · ";
    else if (afterSet.startsWith("-") || afterSet.startsWith("–") || afterSet.startsWith("—")) sampleSep = " - ";
    else if (afterSet.startsWith("/")) sampleSep = " / ";

    if (cleanSub && cleanVol) {
      if (firstSample.includes("(") && firstSample.includes(")") && firstSample.includes(cleanSub)) {
        return `${cleanSet}${sampleSep}${cleanSub} (${cleanVol})`;
      }
      return `${cleanSet}${sampleSep}${cleanSub}${sampleSep}${cleanVol}`;
    }
    if (cleanSub) {
      return `${cleanSet}${sampleSep}${cleanSub}`;
    }
    if (cleanVol) {
      return `${cleanSet}${sampleSep}${cleanVol}`;
    }
    return cleanSet;
  }

  if (cleanSub && cleanVol) {
    return `${cleanSet} · ${cleanSub} · ${cleanVol}`;
  }
  if (cleanSub) {
    return `${cleanSet} · ${cleanSub}`;
  }
  if (cleanVol) {
    return `${cleanSet} · ${cleanVol}`;
  }
  return cleanSet;
}
