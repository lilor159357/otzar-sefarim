import type { BookRow, VolumeNotationRule } from "../types.ts";
import {
  hebrewGematriya,
  numberToHebrewGematriya,
  torahNaturalVolumeRank,
  torahNaturalVolumeSort,
  torahSubSeriesRank,
  compareSetBooks,
  parseVolumeNotationRules,
} from "../../../shared/torah/volumeAndCoverage.ts";

export {
  hebrewGematriya,
  numberToHebrewGematriya,
  torahNaturalVolumeRank,
  torahNaturalVolumeSort,
  torahSubSeriesRank,
  compareSetBooks,
  parseVolumeNotationRules,
};

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
  subSeriesLabel: string;
  minGlobalNumber: number | null;
  coverageSummary: string;
  books: BookRow[];
  totalCopies: number;
  availableCount: number;
  borrowedCount: number;
  otherCount: number;
  locationSummary: string;
}

export interface SetSubSeriesSection {
  subSeriesLabel: string;
  volumes: SetVolumeGroup[];
  totalBooks: number;
}

export function groupSetVolumes(
  books: BookRow[],
  customRules?: VolumeNotationRule[]
): SetVolumeGroup[] {
  const map = new Map<string, BookRow[]>();
  for (const b of books) {
    const sub = String(b.sub_series || "").trim();
    const vol = String(b.volume || "").trim() || "ללא ציון כרך";
    const key = `${sub}\u0001${vol}`;
    const arr = map.get(key) || [];
    arr.push(b);
    map.set(key, arr);
  }

  const groups: SetVolumeGroup[] = [];
  for (const [, list] of map.entries()) {
    const sortedList = [...list].sort((a, b) => compareSetBooks(a, b, customRules));
    const rep = sortedList[0];
    const volumeLabel = String(rep.volume || "").trim() || "ללא ציון כרך";
    const subSeriesLabel = String(rep.sub_series || "").trim();
    const globalNums = sortedList
      .map((x) => (x.set_global_number != null && Number.isFinite(Number(x.set_global_number)) ? Number(x.set_global_number) : null))
      .filter((n): n is number => n != null);
    const minGlobalNumber = globalNums.length > 0 ? Math.min(...globalNums) : null;
    const covs = Array.from(new Set(sortedList.map((x) => String(x.coverage_range || "").trim()).filter(Boolean)));
    const availableCount = sortedList.filter((x) => x.status === "available").length;
    const borrowedCount = sortedList.filter((x) => x.status === "borrowed").length;
    const otherCount = sortedList.length - availableCount - borrowedCount;
    const locs = Array.from(
      new Set(
        sortedList
          .filter((x) => x.cabinet_code)
          .map((x) => `ארון ${x.cabinet_code}${x.shelf_number ? ` מדף ${x.shelf_number}` : ""}`)
      )
    );
    groups.push({
      volumeLabel,
      subSeriesLabel,
      minGlobalNumber,
      coverageSummary: covs.join(" · "),
      books: sortedList,
      totalCopies: sortedList.length,
      availableCount,
      borrowedCount,
      otherCount,
      locationSummary: locs.length > 0 ? locs.join(" / ") : "לא שויך",
    });
  }

  groups.sort((a, b) =>
    compareSetBooks(
      {
        volume: a.volumeLabel,
        sub_series: a.subSeriesLabel,
        set_global_number: a.minGlobalNumber,
        title: a.books[0]?.title,
        barcode: a.books[0]?.barcode,
      },
      {
        volume: b.volumeLabel,
        sub_series: b.subSeriesLabel,
        set_global_number: b.minGlobalNumber,
        title: b.books[0]?.title,
        barcode: b.books[0]?.barcode,
      },
      customRules
    )
  );
  return groups;
}

export function groupSetBySubSeries(
  books: BookRow[],
  customRules?: VolumeNotationRule[]
): SetSubSeriesSection[] {
  const volumes = groupSetVolumes(books, customRules);
  const bySub = new Map<string, SetVolumeGroup[]>();
  for (const v of volumes) {
    const key = v.subSeriesLabel || "";
    const arr = bySub.get(key) || [];
    arr.push(v);
    bySub.set(key, arr);
  }
  const sections: SetSubSeriesSection[] = [];
  for (const [subSeriesLabel, vols] of bySub.entries()) {
    const totalBooks = vols.reduce((acc, g) => acc + g.totalCopies, 0);
    sections.push({ subSeriesLabel, volumes: vols, totalBooks });
  }
  const refineSederRank = (label: string, firstVol?: string) => {
    const r = label ? torahSubSeriesRank(label) : 999999;
    if (r >= 10000 && r <= 20000 && r % 2000 === 0 && firstVol) {
      const vr = torahSubSeriesRank(firstVol);
      if (vr < 999999) return vr;
    }
    return r;
  };
  sections.sort((a, b) => {
    const ra = refineSederRank(a.subSeriesLabel, a.volumes[0]?.volumeLabel);
    const rb = refineSederRank(b.subSeriesLabel, b.volumes[0]?.volumeLabel);
    if (ra !== rb) return ra - rb;
    const ga = a.volumes[0]?.minGlobalNumber ?? null;
    const gb = b.volumes[0]?.minGlobalNumber ?? null;
    if (ga != null && gb != null && ga !== gb) return ga - gb;
    if (!a.subSeriesLabel && b.subSeriesLabel) return 1;
    if (a.subSeriesLabel && !b.subSeriesLabel) return -1;
    const subVolCmp = torahNaturalVolumeRank(a.subSeriesLabel, customRules) - torahNaturalVolumeRank(b.subSeriesLabel, customRules);
    if (subVolCmp !== 0) return subVolCmp;
    return a.subSeriesLabel.localeCompare(b.subSeriesLabel, "he");
  });
  return sections;
}
