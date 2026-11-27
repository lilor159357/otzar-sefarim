import {
  compareSetBooks,
  computeMissingSetSlots,
  type VolumeNotationRule,
} from "../../shared/torah/volumeAndCoverage.ts";

export type ShelfDirection = "top_down" | "bottom_up";

export interface CustomShelfOrderItem {
  cabinetId: number;
  shelfNumber: number;
  manual?: boolean;
}

export interface MultiShelfPrefs {
  shelfDirection: ShelfDirection;
  customShelfOrders: Record<string, CustomShelfOrderItem[]>;
}

export interface OrganizerCabinetInput {
  id: number;
  code: string;
  main_subject: string;
  shelves_count: number;
  width_cm: number | null;
  shelves: Array<{
    shelfNumber: number;
    estimatedCapacityCm: number;
  }>;
}

export interface OrganizerBookInput {
  barcode: string;
  title: string;
  set_name: string;
  sub_series: string;
  volume: string;
  set_global_number: number | null;
  coverage_range: string;
  category: string;
  cabinet_id: number | null;
  shelf_number: number | null;
  format_size: string;
  thickness_mm: number | null;
  pages_count: number | null;
  status: string;
}

export interface ForeignBookAlert {
  barcode: string;
  title: string;
  category: string;
  thicknessCm: number;
  suggestedCabinetId?: number;
  suggestedCabinetCode?: string;
}

export interface ShelfChainStep {
  cabinetId: number;
  cabinetCode: string;
  shelfNumber: number;
  isManuallyAdded: boolean;
  capacityCm: number;
  foreignCm: number;
  foreignBooksCount: number;
  foreignAlerts: ForeignBookAlert[];
}

export interface ShelfSequenceItem {
  kind: "staying" | "incoming" | "missing_slot";
  label: string;
  copiesCount: number;
  borrowedCount: number;
  barcodes: string[];
  fromCabinetCode?: string;
  fromShelf?: number;
  thicknessCm: number;
}

export interface ShelfOutgoingItem {
  label: string;
  copiesCount: number;
  borrowedCount: number;
  barcodes: string[];
  toCabinetCode: string;
  toShelf: number;
}

export interface ShelfSequencePlan {
  cabinetId: number;
  cabinetCode: string;
  shelfNumber: number;
  isManuallyAdded: boolean;
  capacityCm: number;
  foreignCm: number;
  foreignBooksCount: number;
  foreignAlerts: ForeignBookAlert[];
  stayingCm: number;
  incomingCm: number;
  outgoingCm: number;
  missingReservedCm: number;
  borrowedCount: number;
  borrowedCm: number;
  projectedUsedCm: number;
  fillPercent: number;
  isOverflow: boolean;
  overflowCm: number;
  expectedItems: ShelfSequenceItem[];
  outgoingItems: ShelfOutgoingItem[];
}

export interface MultiShelfSetMove {
  id: string;
  title: string;
  description: string;
  reason: string;
  severity: "info" | "warning" | "high";
  fromCabinetId: number;
  fromCabinetCode: string;
  fromShelf: number;
  toCabinetId: number;
  toCabinetCode: string;
  toShelf: number;
  barcodes: string[];
  bookLabels: string[];
  hasBorrowed: boolean;
  borrowedCount: number;
  targetOverflowCm: number;
}

export interface MultiShelfModeResult {
  isOrdered: boolean;
  movesCount: number;
  hasCapacityOverflow: boolean;
  needsExtraShelf: boolean;
  moves: MultiShelfSetMove[];
  shelfPlans: ShelfSequencePlan[];
}

export interface MultiShelfSetAnalysis {
  setName: string;
  dominantCategory: string;
  assignedCount: number;
  unassignedCount: number;
  borrowedCount: number;
  activeMissingCount: number;
  totalAssignedCm: number;
  avgVolumeCm: number;
  hasCustomOrder: boolean;
  shelfChain: ShelfChainStep[];
  minimalMode: MultiShelfModeResult;
  rebalanceMode: MultiShelfModeResult;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function compareCabinetCodeNatural(aCode: string, bCode: string): number {
  return String(aCode || "").localeCompare(String(bCode || ""), "he", {
    numeric: true,
    sensitivity: "base",
  });
}

function compareShelfSlotNatural(
  a: { cabinetCode: string; shelfNumber: number },
  b: { cabinetCode: string; shelfNumber: number },
  shelfDirection: ShelfDirection
): number {
  const cabCmp = compareCabinetCodeNatural(a.cabinetCode, b.cabinetCode);
  if (cabCmp !== 0) return cabCmp;
  return shelfDirection === "bottom_up"
    ? b.shelfNumber - a.shelfNumber
    : a.shelfNumber - b.shelfNumber;
}

function getBookThicknessCm(book: OrganizerBookInput, fallbackCm = 2.8): number {
  if (book.thickness_mm != null && Number(book.thickness_mm) > 0) {
    return Number(book.thickness_mm) / 10;
  }
  return fallbackCm;
}

function getBookShortLabel(book: OrganizerBookInput, setName: string): string {
  const sub = String(book.sub_series || "").trim();
  const vol = String(book.volume || "").trim();
  if (sub && vol) return `${sub} · ${vol}`;
  if (sub) return sub;
  if (vol) return vol;
  let title = String(book.title || "").trim();
  const cleanSet = String(setName || "").trim();
  if (cleanSet && title.startsWith(cleanSet)) {
    const stripped = title.slice(cleanSet.length).replace(/^[s-–—·:]+/, "").trim();
    if (stripped) title = stripped;
  }
  return title || `#${book.barcode}`;
}

function getCanonicalVolumeKey(book: OrganizerBookInput, setName: string): string {
  const sub = String(book.sub_series || "").trim().toLowerCase();
  const vol = String(book.volume || "").trim().toLowerCase();
  const cov = String(book.coverage_range || "").trim().toLowerCase();
  const gNum =
    book.set_global_number != null && Number.isFinite(Number(book.set_global_number))
      ? String(Number(book.set_global_number))
      : "";
  if (!sub && !vol && !gNum && !cov) {
    return `title:${getBookShortLabel(book, setName).toLowerCase()}`;
  }
  return `${sub}||${gNum}||${vol}||${cov}`;
}

function compareBooksCanonicalOnly(
  a: OrganizerBookInput,
  b: OrganizerBookInput,
  volumeNotationRules?: VolumeNotationRule[]
): number {
  const hasCanonA = Boolean(
    String(a.sub_series || "").trim() ||
      String(a.volume || "").trim() ||
      (a.set_global_number != null && Number.isFinite(Number(a.set_global_number)))
  );
  const hasCanonB = Boolean(
    String(b.sub_series || "").trim() ||
      String(b.volume || "").trim() ||
      (b.set_global_number != null && Number.isFinite(Number(b.set_global_number)))
  );
  if (hasCanonA && hasCanonB) {
    return compareSetBooks(
      {
        sub_series: a.sub_series,
        volume: a.volume,
        set_global_number: a.set_global_number,
        title: "",
        barcode: "",
      },
      {
        sub_series: b.sub_series,
        volume: b.volume,
        set_global_number: b.set_global_number,
        title: "",
        barcode: "",
      },
      volumeNotationRules
    );
  }
  return compareSetBooks(
    {
      sub_series: a.sub_series,
      volume: a.volume,
      set_global_number: a.set_global_number,
      title: a.title,
      barcode: "",
    },
    {
      sub_series: b.sub_series,
      volume: b.volume,
      set_global_number: b.set_global_number,
      title: b.title,
      barcode: "",
    },
    volumeNotationRules
  );
}

/**
 * Computes Weighted Non-Decreasing Longest Increasing Subsequence (LIS) over shelf indices.
 * Identical copies on the same or monotonically advancing shelf (shelf[i] <= shelf[j])
 * are preserved as valid so duplicate copies spilling across shelf boundaries never trigger false moves.
 */
function computeWeightedNonDecreasingLis(
  shelfIndices: number[],
  weights: number[]
): Set<number> {
  const n = shelfIndices.length;
  if (n === 0) return new Set();
  const dp = new Array<number>(n).fill(0);
  const prev = new Array<number>(n).fill(-1);

  let bestEnd = 0;
  for (let i = 0; i < n; i++) {
    dp[i] = weights[i];
    for (let j = 0; j < i; j++) {
      if (shelfIndices[j] <= shelfIndices[i]) {
        const cand = dp[j] + weights[i];
        if (cand > dp[i]) {
          dp[i] = cand;
          prev[i] = j;
        }
      }
    }
    if (dp[i] > dp[bestEnd]) {
      bestEnd = i;
    }
  }

  const keep = new Set<number>();
  let cur = bestEnd;
  while (cur !== -1) {
    keep.add(cur);
    cur = prev[cur];
  }
  return keep;
}

export function analyzeMultiShelfSets(params: {
  cabinets: OrganizerCabinetInput[];
  books: OrganizerBookInput[];
  ignoredMissingKeys: Set<string>;
  volumeNotationRules?: VolumeNotationRule[];
  prefs?: Partial<MultiShelfPrefs>;
}): {
  multiShelfSets: MultiShelfSetAnalysis[];
  handledSetNames: Set<string>;
} {
  const {
    cabinets,
    books,
    ignoredMissingKeys,
    volumeNotationRules,
    prefs,
  } = params;
  const shelfDirection: ShelfDirection =
    prefs?.shelfDirection === "bottom_up" ? "bottom_up" : "top_down";
  const customShelfOrders = prefs?.customShelfOrders || {};

  const cabById = new Map(cabinets.map((c) => [c.id, c]));

  const getShelfCapacityCm = (cab: OrganizerCabinetInput, shelfNumber: number): number => {
    const found = cab.shelves.find((s) => s.shelfNumber === shelfNumber);
    if (found && found.estimatedCapacityCm > 0) return found.estimatedCapacityCm;
    return cab.width_cm && cab.width_cm > 0 ? Math.max(20, round1(cab.width_cm - 4)) : 116;
  };

  const normalizeShelfNum = (cab: OrganizerCabinetInput, rawShelf: number | null): number => {
    const count = Math.max(1, Number(cab.shelves_count) || 5);
    const s = Number(rawShelf) || 1;
    return Math.max(1, Math.min(count, s));
  };

  // Group all books by shelf location for fast foreign-book lookup
  const booksByShelfKey = new Map<string, OrganizerBookInput[]>();
  for (const b of books) {
    if (b.cabinet_id == null) continue;
    const cab = cabById.get(b.cabinet_id);
    if (!cab) continue;
    const sNum = normalizeShelfNum(cab, b.shelf_number);
    const key = `${cab.id}:${sNum}`;
    const arr = booksByShelfKey.get(key) || [];
    arr.push(b);
    booksByShelfKey.set(key, arr);
  }

  // Group books by normalized set name
  const booksBySet = new Map<string, { displaySetName: string; items: OrganizerBookInput[] }>();
  for (const b of books) {
    const rawSet = String(b.set_name || "").trim();
    if (!rawSet) continue;
    const k = rawSet.toLowerCase();
    const existing = booksBySet.get(k);
    if (existing) {
      existing.items.push(b);
    } else {
      booksBySet.set(k, { displaySetName: rawSet, items: [b] });
    }
  }

  const multiShelfSets: MultiShelfSetAnalysis[] = [];
  const handledSetNames = new Set<string>();

  for (const [setKeyLower, { displaySetName, items: allSetBooks }] of booksBySet.entries()) {
    const assignedBooks: Array<{
      book: OrganizerBookInput;
      cabinet: OrganizerCabinetInput;
      shelfNumber: number;
    }> = [];
    let unassignedCount = 0;

    for (const b of allSetBooks) {
      if (b.cabinet_id == null) {
        unassignedCount++;
        continue;
      }
      const cab = cabById.get(b.cabinet_id);
      if (!cab) {
        unassignedCount++;
        continue;
      }
      assignedBooks.push({
        book: b,
        cabinet: cab,
        shelfNumber: normalizeShelfNum(cab, b.shelf_number),
      });
    }

    if (assignedBooks.length < 2) continue;

    // Average known thickness in set
    const knownThicks = allSetBooks
      .map((b) => (b.thickness_mm != null && Number(b.thickness_mm) > 0 ? Number(b.thickness_mm) / 10 : null))
      .filter((x): x is number => x !== null);
    const avgVolumeCm =
      knownThicks.length > 0
        ? round1(knownThicks.reduce((a, b) => a + b, 0) / knownThicks.length)
        : 2.8;

    const totalAssignedCm = round1(
      assignedBooks.reduce((acc, entry) => acc + getBookThicknessCm(entry.book, avgVolumeCm), 0)
    );

    // Distinct shelves currently occupied by this set
    const occupiedShelfMap = new Map<string, { cabinet: OrganizerCabinetInput; shelfNumber: number; count: number }>();
    for (const entry of assignedBooks) {
      const k = `${entry.cabinet.id}:${entry.shelfNumber}`;
      const prev = occupiedShelfMap.get(k);
      if (prev) prev.count++;
      else occupiedShelfMap.set(k, { cabinet: entry.cabinet, shelfNumber: entry.shelfNumber, count: 1 });
    }

    const savedCustomChain =
      customShelfOrders[displaySetName] ||
      customShelfOrders[setKeyLower] ||
      null;
    const hasCustomOrder = Array.isArray(savedCustomChain) && savedCustomChain.length > 0;

    // Check if this set actually fits onto a single shelf
    const primaryOccupied = Array.from(occupiedShelfMap.values()).sort((a, b) => b.count - a.count)[0];
    const primaryCapacity = primaryOccupied
      ? getShelfCapacityCm(primaryOccupied.cabinet, primaryOccupied.shelfNumber)
      : 116;

    const isMultiShelfSet =
      (occupiedShelfMap.size >= 2 && totalAssignedCm > primaryCapacity * 0.92) ||
      (hasCustomOrder && savedCustomChain!.length >= 2);

    if (!isMultiShelfSet) continue;

    handledSetNames.add(displaySetName);
    handledSetNames.add(setKeyLower);

    // Dominant category of the set (for detecting out-of-category foreign books)
    const catCounts = new Map<string, number>();
    for (const entry of assignedBooks) {
      const c = String(entry.book.category || "").trim();
      if (!c) continue;
      catCounts.set(c, (catCounts.get(c) || 0) + 1);
    }
    const dominantCategory =
      Array.from(catCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "";

    // Build ordered shelfChain
    const shelfChainRaw: Array<{ cabinet: OrganizerCabinetInput; shelfNumber: number; isManuallyAdded: boolean }> = [];
    const seenChainKeys = new Set<string>();

    if (hasCustomOrder) {
      for (const item of savedCustomChain!) {
        const cab = cabById.get(Number(item.cabinetId));
        if (!cab) continue;
        const sNum = normalizeShelfNum(cab, Number(item.shelfNumber));
        const key = `${cab.id}:${sNum}`;
        if (seenChainKeys.has(key)) continue;
        seenChainKeys.add(key);
        const isOccupied = occupiedShelfMap.has(key);
        if (isOccupied || item.manual) {
          shelfChainRaw.push({ cabinet: cab, shelfNumber: sNum, isManuallyAdded: !isOccupied && Boolean(item.manual) });
        }
      }
    }

    // Append any occupied shelves not yet in custom order (sorted naturally)
    const remainingOccupied = Array.from(occupiedShelfMap.values())
      .filter((o) => !seenChainKeys.has(`${o.cabinet.id}:${o.shelfNumber}`))
      .sort((a, b) =>
        compareShelfSlotNatural(
          { cabinetCode: a.cabinet.code, shelfNumber: a.shelfNumber },
          { cabinetCode: b.cabinet.code, shelfNumber: b.shelfNumber },
          shelfDirection
        )
      );

    for (const o of remainingOccupied) {
      const key = `${o.cabinet.id}:${o.shelfNumber}`;
      seenChainKeys.add(key);
      shelfChainRaw.push({ cabinet: o.cabinet, shelfNumber: o.shelfNumber, isManuallyAdded: false });
    }

    if (shelfChainRaw.length === 0) continue;

    const shelfIndexByKey = new Map<string, number>();
    shelfChainRaw.forEach((s, idx) => shelfIndexByKey.set(`${s.cabinet.id}:${s.shelfNumber}`, idx));

    // Build shelfChain metadata with foreign books & category anomaly detection
    const shelfChain: ShelfChainStep[] = shelfChainRaw.map((step) => {
      const key = `${step.cabinet.id}:${step.shelfNumber}`;
      const capacityCm = getShelfCapacityCm(step.cabinet, step.shelfNumber);
      const allOnShelf = booksByShelfKey.get(key) || [];
      const foreignBooks = allOnShelf.filter(
        (b) => String(b.set_name || "").trim().toLowerCase() !== setKeyLower
      );
      const foreignCm = round1(
        foreignBooks.reduce((acc, fb) => acc + getBookThicknessCm(fb, 2.8), 0)
      );

      const foreignAlerts: ForeignBookAlert[] = [];
      if (dominantCategory) {
        for (const fb of foreignBooks) {
          const fbCat = String(fb.category || "").trim();
          if (!fbCat) continue;
          const matchesDom =
            fbCat === dominantCategory ||
            fbCat.includes(dominantCategory) ||
            dominantCategory.includes(fbCat);
          if (!matchesDom) {
            const targetCab = cabinets.find(
              (c) =>
                c.id !== step.cabinet.id &&
                c.main_subject &&
                (c.main_subject.includes(fbCat) || fbCat.includes(c.main_subject))
            );
            foreignAlerts.push({
              barcode: fb.barcode,
              title: fb.title,
              category: fbCat,
              thicknessCm: round1(getBookThicknessCm(fb, 2.8)),
              suggestedCabinetId: targetCab?.id,
              suggestedCabinetCode: targetCab?.code,
            });
          }
        }
      }

      return {
        cabinetId: step.cabinet.id,
        cabinetCode: step.cabinet.code,
        shelfNumber: step.shelfNumber,
        isManuallyAdded: step.isManuallyAdded,
        capacityCm,
        foreignCm,
        foreignBooksCount: foreignBooks.length,
        foreignAlerts,
      };
    });

    // Sort assigned books canonically; identical copies break ties by current shelfIdx ascending!
    const enrichedAssigned = assignedBooks.map((entry) => {
      const curShelfIdx = shelfIndexByKey.get(`${entry.cabinet.id}:${entry.shelfNumber}`) ?? 0;
      return {
        ...entry,
        curShelfIdx,
        thicknessCm: getBookThicknessCm(entry.book, avgVolumeCm),
        shortLabel: getBookShortLabel(entry.book, displaySetName),
        copyKey: getCanonicalVolumeKey(entry.book, displaySetName),
        isBorrowed: entry.book.status === "borrowed",
      };
    });

    enrichedAssigned.sort((a, b) => {
      const c = compareBooksCanonicalOnly(a.book, b.book, volumeNotationRules);
      if (c !== 0) return c;
      if (a.curShelfIdx !== b.curShelfIdx) return a.curShelfIdx - b.curShelfIdx;
      return a.book.barcode.localeCompare(b.book.barcode);
    });

    const borrowedCount = enrichedAssigned.filter((e) => e.isBorrowed).length;

    // Active missing volumes for this set (for rebalance spacing reservation)
    const missingSlotsRaw = computeMissingSetSlots(
      allSetBooks.map((b) => ({
        barcode: b.barcode,
        title: b.title,
        set_name: b.set_name,
        sub_series: b.sub_series,
        volume: b.volume,
        coverage_range: b.coverage_range,
        set_global_number: b.set_global_number,
      })),
      displaySetName,
      ignoredMissingKeys
    );
    const activeMissingSlots = missingSlotsRaw.filter((sl) => !sl.ignored && sl.kind !== "anomaly");

    // Helper to turn per-shelf book assignments into moves + ShelfSequencePlans
    const buildModeResult = (
      modeKind: "minimal" | "rebalance",
      targetShelfByIndex: number[],
      extraMissingSlotsPerShelf: Array<Array<{ label: string; thicknessCm: number; sortBook: OrganizerBookInput }>>
    ): MultiShelfModeResult => {
      const n = enrichedAssigned.length;
      const m = shelfChain.length;

      // Group moves by (fromShelfIdx -> toShelfIdx)
      const moveGroupMap = new Map<
        string,
        {
          fromIdx: number;
          toIdx: number;
          entries: typeof enrichedAssigned;
        }
      >();

      for (let i = 0; i < n; i++) {
        const entry = enrichedAssigned[i];
        const toIdx = targetShelfByIndex[i];
        if (toIdx !== entry.curShelfIdx) {
          const gKey = `${entry.curShelfIdx}->${toIdx}`;
          const g = moveGroupMap.get(gKey) || { fromIdx: entry.curShelfIdx, toIdx, entries: [] };
          g.entries.push(entry);
          moveGroupMap.set(gKey, g);
        }
      }

      // Compute projected cm & expected/outgoing items per shelf
      const projectedSetCm = new Array<number>(m).fill(0);
      const stayingCm = new Array<number>(m).fill(0);
      const incomingCm = new Array<number>(m).fill(0);
      const outgoingCm = new Array<number>(m).fill(0);
      const borrowedCountsPerShelf = new Array<number>(m).fill(0);
      const borrowedCmPerShelf = new Array<number>(m).fill(0);
      const missingReservedCmPerShelf = new Array<number>(m).fill(0);

      for (let i = 0; i < n; i++) {
        const e = enrichedAssigned[i];
        const tIdx = targetShelfByIndex[i];
        projectedSetCm[tIdx] += e.thicknessCm;
        if (tIdx === e.curShelfIdx) {
          stayingCm[tIdx] += e.thicknessCm;
        } else {
          incomingCm[tIdx] += e.thicknessCm;
          outgoingCm[e.curShelfIdx] += e.thicknessCm;
        }
        if (e.isBorrowed) {
          borrowedCountsPerShelf[tIdx] += 1;
          borrowedCmPerShelf[tIdx] += e.thicknessCm;
        }
      }

      for (let s = 0; s < m; s++) {
        const missArr = extraMissingSlotsPerShelf[s] || [];
        missingReservedCmPerShelf[s] = round1(missArr.reduce((acc, x) => acc + x.thicknessCm, 0));
      }

      let hasCapacityOverflow = false;
      const shelfOverflowCm = new Array<number>(m).fill(0);
      for (let s = 0; s < m; s++) {
        const proj = round1(projectedSetCm[s] + shelfChain[s].foreignCm + missingReservedCmPerShelf[s]);
        if (proj > shelfChain[s].capacityCm + 0.5) {
          shelfOverflowCm[s] = round1(proj - shelfChain[s].capacityCm);
          hasCapacityOverflow = true;
        }
      }

      // Build expected sequence items & outgoing items per shelf
      const shelfPlans: ShelfSequencePlan[] = shelfChain.map((step, sIdx) => {
        // Merge physical items assigned to sIdx AND missing slots assigned to sIdx in canonical order
        type SeqRaw =
          | {
              type: "book";
              sortBook: OrganizerBookInput;
              entry: (typeof enrichedAssigned)[number];
            }
          | {
              type: "missing";
              sortBook: OrganizerBookInput;
              label: string;
              thicknessCm: number;
            };

        const rawList: SeqRaw[] = [];
        for (let i = 0; i < n; i++) {
          if (targetShelfByIndex[i] === sIdx) {
            rawList.push({
              type: "book",
              sortBook: enrichedAssigned[i].book,
              entry: enrichedAssigned[i],
            });
          }
        }
        for (const ms of extraMissingSlotsPerShelf[sIdx] || []) {
          rawList.push({
            type: "missing",
            sortBook: ms.sortBook,
            label: ms.label,
            thicknessCm: ms.thicknessCm,
          });
        }

        // Preserve canonical order already built (or sort missing slots in)
        rawList.sort((a, b) => compareBooksCanonicalOnly(a.sortBook, b.sortBook, volumeNotationRules));

        const expectedItems: ShelfSequenceItem[] = [];
        for (const item of rawList) {
          if (item.type === "missing") {
            expectedItems.push({
              kind: "missing_slot",
              label: item.label,
              copiesCount: 1,
              borrowedCount: 0,
              barcodes: [],
              thicknessCm: item.thicknessCm,
            });
            continue;
          }
          const e = item.entry;
          const kind: "staying" | "incoming" = e.curShelfIdx === sIdx ? "staying" : "incoming";
          const fromStep = kind === "incoming" ? shelfChain[e.curShelfIdx] : undefined;
          const last = expectedItems[expectedItems.length - 1];
          if (
            last &&
            last.kind === kind &&
            last.label === e.shortLabel &&
            last.fromCabinetCode === fromStep?.cabinetCode &&
            last.fromShelf === fromStep?.shelfNumber
          ) {
            last.copiesCount += 1;
            if (e.isBorrowed) last.borrowedCount += 1;
            last.barcodes.push(e.book.barcode);
            last.thicknessCm = round1(last.thicknessCm + e.thicknessCm);
          } else {
            expectedItems.push({
              kind,
              label: e.shortLabel,
              copiesCount: 1,
              borrowedCount: e.isBorrowed ? 1 : 0,
              barcodes: [e.book.barcode],
              fromCabinetCode: fromStep?.cabinetCode,
              fromShelf: fromStep?.shelfNumber,
              thicknessCm: round1(e.thicknessCm),
            });
          }
        }

        // Outgoing items from this shelf
        const outgoingItems: ShelfOutgoingItem[] = [];
        for (let i = 0; i < n; i++) {
          const e = enrichedAssigned[i];
          if (e.curShelfIdx === sIdx && targetShelfByIndex[i] !== sIdx) {
            const toStep = shelfChain[targetShelfByIndex[i]];
            const lastOut = outgoingItems[outgoingItems.length - 1];
            if (
              lastOut &&
              lastOut.label === e.shortLabel &&
              lastOut.toCabinetCode === toStep.cabinetCode &&
              lastOut.toShelf === toStep.shelfNumber
            ) {
              lastOut.copiesCount += 1;
              if (e.isBorrowed) lastOut.borrowedCount += 1;
              lastOut.barcodes.push(e.book.barcode);
            } else {
              outgoingItems.push({
                label: e.shortLabel,
                copiesCount: 1,
                borrowedCount: e.isBorrowed ? 1 : 0,
                barcodes: [e.book.barcode],
                toCabinetCode: toStep.cabinetCode,
                toShelf: toStep.shelfNumber,
              });
            }
          }
        }

        const projectedUsedCm = round1(
          projectedSetCm[sIdx] + step.foreignCm + missingReservedCmPerShelf[sIdx]
        );
        const fillPercent =
          step.capacityCm > 0 ? Math.round((projectedUsedCm / step.capacityCm) * 100) : 0;

        return {
          cabinetId: step.cabinetId,
          cabinetCode: step.cabinetCode,
          shelfNumber: step.shelfNumber,
          isManuallyAdded: step.isManuallyAdded,
          capacityCm: step.capacityCm,
          foreignCm: step.foreignCm,
          foreignBooksCount: step.foreignBooksCount,
          foreignAlerts: step.foreignAlerts,
          stayingCm: round1(stayingCm[sIdx]),
          incomingCm: round1(incomingCm[sIdx]),
          outgoingCm: round1(outgoingCm[sIdx]),
          missingReservedCm: missingReservedCmPerShelf[sIdx],
          borrowedCount: borrowedCountsPerShelf[sIdx],
          borrowedCm: round1(borrowedCmPerShelf[sIdx]),
          projectedUsedCm,
          fillPercent,
          isOverflow: shelfOverflowCm[sIdx] > 0,
          overflowCm: shelfOverflowCm[sIdx],
          expectedItems,
          outgoingItems,
        };
      });

      const moves: MultiShelfSetMove[] = Array.from(moveGroupMap.values())
        .sort((a, b) => a.fromIdx - b.fromIdx || a.toIdx - b.toIdx)
        .map((grp) => {
          const fromStep = shelfChain[grp.fromIdx];
          const toStep = shelfChain[grp.toIdx];
          const borrowedInMove = grp.entries.filter((e) => e.isBorrowed).length;
          const labels = grp.entries.map(
            (e) => `${e.shortLabel}${e.isBorrowed ? " (מושאל כרגע)" : ""}`
          );
          const uniquePreview = Array.from(new Set(labels)).slice(0, 4).join(", ");
          const extraSuffix = labels.length > 4 ? ` ועוד ${labels.length - 4}` : "";
          const overflowCm = shelfOverflowCm[grp.toIdx];
          return {
            id: `multiset-${modeKind}-${displaySetName}-${fromStep.cabinetId}:${fromStep.shelfNumber}->${toStep.cabinetId}:${toStep.shelfNumber}`,
            title: `${displaySetName}: העבר ${grp.entries.length} כרכים מארון ${fromStep.cabinetCode} מדף ${fromStep.shelfNumber} ← ארון ${toStep.cabinetCode} מדף ${toStep.shelfNumber}`,
            description: `כרכים להעברה: ${uniquePreview}${extraSuffix}`,
            reason:
              modeKind === "minimal"
                ? overflowCm > 0
                  ? `חריגת קיבולת צפויה במדף היעד (+${overflowCm} ס״מ מעבר לרוחב המדף) — מומלץ לעבור לפריסה מחדש`
                  : "כרכים אלו נדחפו למדף שאינו תואם את מיקומם ברצף התורני של הסט"
                : "פריסה מחדש מאוזנת של הסט לפי סדר תורני ומרווח ס״מ פנוי",
            severity: overflowCm > 0 ? "high" : borrowedInMove > 0 ? "warning" : "info",
            fromCabinetId: fromStep.cabinetId,
            fromCabinetCode: fromStep.cabinetCode,
            fromShelf: fromStep.shelfNumber,
            toCabinetId: toStep.cabinetId,
            toCabinetCode: toStep.cabinetCode,
            toShelf: toStep.shelfNumber,
            barcodes: grp.entries.map((e) => e.book.barcode),
            bookLabels: labels,
            hasBorrowed: borrowedInMove > 0,
            borrowedCount: borrowedInMove,
            targetOverflowCm: overflowCm,
          };
        });

      const needsExtraShelf =
        modeKind === "rebalance" &&
        shelfChain.reduce((acc, st) => acc + Math.max(0, st.capacityCm * 0.92 - st.foreignCm), 0) <
          totalAssignedCm + activeMissingSlots.length * avgVolumeCm;

      return {
        isOrdered: moves.length === 0,
        movesCount: moves.reduce((acc, mv) => acc + mv.barcodes.length, 0),
        hasCapacityOverflow,
        needsExtraShelf,
        moves,
        shelfPlans,
      };
    };

    // =========================================================================
    // MODE A: Minimal Fix via Weighted Non-Decreasing LIS (<= for identical copies)
    // =========================================================================
    const curShelfIndices = enrichedAssigned.map((e) => e.curShelfIdx);
    const shelfStrength = new Array<number>(shelfChain.length).fill(0);
    for (const idx of curShelfIndices) shelfStrength[idx] += 1;
    const weights = curShelfIndices.map((sIdx) => 1 + 0.001 * shelfStrength[sIdx]);
    const lisKeepSet = computeWeightedNonDecreasingLis(curShelfIndices, weights);

    const minimalTargetShelves = [...curShelfIndices];
    // Track live free cm per shelf when placing non-LIS books
    const liveUsedCm = shelfChain.map((s) => s.foreignCm);
    for (let i = 0; i < enrichedAssigned.length; i++) {
      if (lisKeepSet.has(i)) {
        liveUsedCm[curShelfIndices[i]] += enrichedAssigned[i].thicknessCm;
      }
    }

    // Build LIS anchor bounds
    const leftAnchor = new Array<number>(enrichedAssigned.length).fill(0);
    const rightAnchor = new Array<number>(enrichedAssigned.length).fill(shelfChain.length - 1);
    let lastLeft = 0;
    for (let i = 0; i < enrichedAssigned.length; i++) {
      if (lisKeepSet.has(i)) lastLeft = curShelfIndices[i];
      leftAnchor[i] = lastLeft;
    }
    let lastRight = shelfChain.length - 1;
    for (let i = enrichedAssigned.length - 1; i >= 0; i--) {
      if (lisKeepSet.has(i)) lastRight = curShelfIndices[i];
      rightAnchor[i] = lastRight;
    }

    for (let i = 0; i < enrichedAssigned.length; i++) {
      if (lisKeepSet.has(i)) continue;
      const lo = leftAnchor[i];
      const hi = Math.max(lo, rightAnchor[i]);
      let chosen = lo;
      if (lo < hi) {
        // Prefer shelf in [lo..hi] that fits the book with best free cm; keep canonical tie-break
        let bestScore = -Infinity;
        for (let s = lo; s <= hi; s++) {
          const free = shelfChain[s].capacityCm - liveUsedCm[s];
          const fits = free >= enrichedAssigned[i].thicknessCm ? 1000 : 0;
          const score = fits + free;
          if (score > bestScore) {
            bestScore = score;
            chosen = s;
          }
        }
      }
      minimalTargetShelves[i] = chosen;
      liveUsedCm[chosen] += enrichedAssigned[i].thicknessCm;
    }

    const minimalMode = buildModeResult(
      "minimal",
      minimalTargetShelves,
      shelfChain.map(() => [])
    );

    // =========================================================================
    // MODE B: Balanced Rebalance by cm (8% margin + active missing slots)
    // =========================================================================
    type MergedSlot =
      | { kind: "book"; origIdx: number; sortBook: OrganizerBookInput; thicknessCm: number }
      | { kind: "missing"; label: string; sortBook: OrganizerBookInput; thicknessCm: number };

    const mergedSequence: MergedSlot[] = enrichedAssigned.map((e, origIdx) => ({
      kind: "book",
      origIdx,
      sortBook: e.book,
      thicknessCm: e.thicknessCm,
    }));

    for (const ms of activeMissingSlots) {
      const mLabel = ms.subSeries
        ? `${ms.subSeries} · ${ms.suggestedVolume || `כרך ${ms.index}`}`
        : ms.suggestedVolume || `כרך ${ms.index}`;
      mergedSequence.push({
        kind: "missing",
        label: mLabel,
        sortBook: {
          barcode: "",
          title: mLabel,
          set_name: displaySetName,
          sub_series: ms.subSeries || "",
          volume: ms.suggestedVolume || "",
          set_global_number: ms.suggestedGlobalNumber ?? null,
          coverage_range: "",
          category: dominantCategory,
          cabinet_id: null,
          shelf_number: null,
          format_size: "",
          thickness_mm: null,
          pages_count: null,
          status: "available",
        },
        thicknessCm: avgVolumeCm,
      });
    }

    mergedSequence.sort((a, b) => compareBooksCanonicalOnly(a.sortBook, b.sortBook, volumeNotationRules));

    // Reserve 8% breathing room per shelf minus foreign books
    const shelfBudgets = shelfChain.map((st) => Math.max(0, st.capacityCm * 0.92 - st.foreignCm));
    const totalBudget = shelfBudgets.reduce((a, b) => a + b, 0);
    const totalNeeded = mergedSequence.reduce((a, x) => a + x.thicknessCm, 0);
    const balancedRatio = totalBudget > 0 ? Math.min(1, totalNeeded / totalBudget) : 1;

    const rebalanceTargets = new Array<number>(enrichedAssigned.length).fill(0);
    const rebalanceMissingPerShelf: Array<Array<{ label: string; thicknessCm: number; sortBook: OrganizerBookInput }>> = shelfChain.map(
      () => []
    );

    let curTargetShelf = 0;
    let curShelfLoad = 0;
    for (let k = 0; k < mergedSequence.length; k++) {
      const item = mergedSequence[k];
      const softLimit = shelfBudgets[curTargetShelf] * Math.max(balancedRatio, 0.85);
      const hardLimit = Math.max(0, shelfChain[curTargetShelf].capacityCm - shelfChain[curTargetShelf].foreignCm);

      if (curTargetShelf < shelfChain.length - 1 && curShelfLoad > 0) {
        const nextLoad = curShelfLoad + item.thicknessCm;
        if (nextLoad > hardLimit || nextLoad > softLimit + 0.8) {
          curTargetShelf += 1;
          curShelfLoad = 0;
        }
      }

      if (item.kind === "book") {
        rebalanceTargets[item.origIdx] = curTargetShelf;
      } else {
        rebalanceMissingPerShelf[curTargetShelf].push({
          label: item.label,
          thicknessCm: item.thicknessCm,
          sortBook: item.sortBook,
        });
      }
      curShelfLoad += item.thicknessCm;
    }

    const rebalanceMode = buildModeResult("rebalance", rebalanceTargets, rebalanceMissingPerShelf);

    multiShelfSets.push({
      setName: displaySetName,
      dominantCategory,
      assignedCount: assignedBooks.length,
      unassignedCount,
      borrowedCount,
      activeMissingCount: activeMissingSlots.length,
      totalAssignedCm,
      avgVolumeCm,
      hasCustomOrder,
      shelfChain,
      minimalMode,
      rebalanceMode,
    });
  }

  // Sort sets: disordered ones first, then largest count
  multiShelfSets.sort((a, b) => {
    const disA = a.minimalMode.isOrdered ? 1 : 0;
    const disB = b.minimalMode.isOrdered ? 1 : 0;
    if (disA !== disB) return disA - disB;
    return b.assignedCount - a.assignedCount;
  });

  return { multiShelfSets, handledSetNames };
}
