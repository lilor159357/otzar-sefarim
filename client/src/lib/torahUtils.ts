import type { BookRow } from "../types.ts";

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

export function numberToHebrewGematriya(num: number): string {
  if (num <= 0 || num > 499) return String(num);
  if (num === 15) return "טו";
  if (num === 16) return "טז";
  const hundreds = ["", "ק", "ר", "ש", "ת"];
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

export function suggestNextVolume(currentVolume: string): string {
  const s = currentVolume.trim();
  if (!s) return "";
  const numMatch = s.match(/^(.*?)(\d+)([^\d]*)$/);
  if (numMatch) {
    const nextNum = parseInt(numMatch[2], 10) + 1;
    return `${numMatch[1]}${nextNum}${numMatch[3]}`;
  }
  const prefixMatch = s.match(/^(חלק\s+|כרך\s+|ספר\s+|ח['"״׳]\s*|כ['"״׳]\s*)?([א-ת]+)(['"״׳]?)$/);
  if (prefixMatch) {
    const prefix = prefixMatch[1] || "";
    const letters = prefixMatch[2];
    const gershayim = prefixMatch[3] || "";
    const gVal = hebrewGematriya(letters);
    if (gVal > 0 && gVal < 400) {
      const nextHeb = numberToHebrewGematriya(gVal + 1);
      const sep = gershayim && nextHeb.length === 1 ? gershayim : "";
      return `${prefix}${nextHeb}${sep}`;
    }
  }
  return "";
}

export interface SetVolumeGroup {
  volumeLabel: string;
  books: BookRow[];
  totalCopies: number;
  availableCount: number;
  borrowedCount: number;
  otherCount: number;
  locationSummary: string;
}

export function groupSetVolumes(books: BookRow[]): SetVolumeGroup[] {
  const map = new Map<string, BookRow[]>();
  for (const b of books) {
    const key = (b.volume || "").trim() || "ללא ציון כרך";
    const arr = map.get(key) || [];
    arr.push(b);
    map.set(key, arr);
  }

  const groups: SetVolumeGroup[] = [];
  for (const [volumeLabel, list] of map.entries()) {
    const availableCount = list.filter((x) => x.status === "available").length;
    const borrowedCount = list.filter((x) => x.status === "borrowed").length;
    const otherCount = list.length - availableCount - borrowedCount;
    const locs = Array.from(
      new Set(
        list
          .filter((x) => x.cabinet_code)
          .map((x) => `ארון ${x.cabinet_code}${x.shelf_number ? ` מדף ${x.shelf_number}` : ""}`)
      )
    );
    groups.push({
      volumeLabel,
      books: list,
      totalCopies: list.length,
      availableCount,
      borrowedCount,
      otherCount,
      locationSummary: locs.length > 0 ? locs.join(" / ") : "לא שויך",
    });
  }

  groups.sort((a, b) => torahNaturalVolumeSort(a.volumeLabel, b.volumeLabel));
  return groups;
}
