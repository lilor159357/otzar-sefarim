import type { Express } from "express";
import fs from "fs";
import path from "path";
import type { DbClient } from "../db/adapter.ts";
import { requireAdmin } from "../auth/adminAuth.ts";
import { buildNormalizedBookSearch, enqueueSyncOutbox, newSyncId } from "../db/schema.ts";
import { fallbackT, type StringsTranslateFn } from "../../shared/strings/engine.ts";
import {
  analyzeBookCoverImage,
  analyzeShelfSetImages,
  enrichBookWithGoogleSearch,
  buildBookEmbeddingText,
  float32ToBlob,
  formatGeminiError,
  generateTextEmbedding,
  getAiConfig,
  getAiKeyPoolPublicStatus,
  markApiKeySlowCooldown,
  reanalyzeApprovedBook,
  saveAiKeyPool,
  testGeminiConnection,
  testSinglePoolKey,
  type ExistingSetContext,
  type ExtractedBookMetadata,
  type ExtractedShelfSet,
} from "../ai/geminiService.ts";
import { findAuthorityMatch } from "../search/torahAuthority.ts";

const RETENTION_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
let isQueueWorkerRunning = false;
const activeQueueAborts = new Map<
  number,
  { controller: AbortController; reason?: "manual_refresh" | "timeout" | "deleted"; activeApiKey?: string }
>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p.map((t) => String(t).trim()).filter(Boolean);
    } catch {}
    return raw.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

function detectMimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function parseExtraImages(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.map((x) => String(x || "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseSpineVolumes(
  raw: unknown
): Array<{ volume: string; sub_series?: string; set_global_number?: number | null; coverage_range?: string; copiesCount: number; notes?: string }> {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function getItemImagePaths(row: { image_path?: unknown; extra_images_json?: unknown }): string[] {
  const first = String(row.image_path || "").trim();
  const extras = parseExtraImages(row.extra_images_json);
  return [first, ...extras].filter(Boolean);
}

function normEditionToken(val?: string | null): string {
  return String(val || "")
    .trim()
    .toLowerCase()
    .replace(/^(הוצאת|מכון|מהדורת|מהדורה|דפוס)\s+/g, "")
    .replace(/["'״׳()\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function editionsConflict(a?: string | null, b?: string | null): boolean {
  const na = normEditionToken(a);
  const nb = normEditionToken(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return false;
  return true;
}

function disambiguateSetNameWithEdition(
  db: DbClient,
  setName: string,
  edition?: string | null,
  publisher?: string | null
): string {
  const cleanSet = String(setName || "").trim();
  if (!cleanSet) return "";
  const rawQual = String(edition || publisher || "")
    .replace(/^(הוצאת|מכון|מהדורת)\s+/i, "")
    .trim();
  if (!rawQual) return cleanSet;

  if (/\([^)]{2,40}\)$/.test(cleanSet)) return cleanSet;

  const candidateQualified = `${cleanSet} (${rawQual})`;
  const existingQualRow = db.get<{ set_name: string }>(
    "SELECT set_name FROM books WHERE LOWER(set_name) = LOWER(?) AND deleted_at IS NULL LIMIT 1",
    candidateQualified
  );
  if (existingQualRow?.set_name) return String(existingQualRow.set_name).trim();

  const existingRows = db.all<{ edition: string; publisher: string }>(
    "SELECT edition, publisher FROM books WHERE LOWER(set_name) = LOWER(?) AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 10",
    cleanSet
  );
  if (existingRows.length > 0) {
    const hasMatch = existingRows.some((r) => {
      const sameEd = edition && r.edition && !editionsConflict(edition, r.edition);
      const samePub = publisher && r.publisher && !editionsConflict(publisher, r.publisher);
      return sameEd || samePub;
    });
    if (hasMatch) return cleanSet;

    const hasConflict = existingRows.some((r) => {
      const edConf = edition && r.edition && editionsConflict(edition, r.edition);
      const pubConf = publisher && r.publisher && editionsConflict(publisher, r.publisher);
      return edConf || pubConf;
    });
    if (hasConflict) {
      return candidateQualified;
    }
  }
  return cleanSet;
}

function lookupExistingSetContext(
  db: DbClient,
  setName: string,
  edition?: string | null,
  publisher?: string | null
): ExistingSetContext | undefined {
  const clean = String(setName || "").trim();
  if (!clean) return undefined;
  const resolvedName = disambiguateSetNameWithEdition(db, clean, edition, publisher);
  const row = db.get<{
    set_name: string;
    author: string;
    publisher: string;
    pub_year: string;
    edition: string;
    category: string;
    tags: string;
  }>(
    "SELECT set_name, author, publisher, pub_year, edition, category, tags, cabinet_id, shelf_number FROM books WHERE LOWER(set_name) = LOWER(?) AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
    resolvedName
  );
  if (!row) return undefined;
  return {
    set_name: String(row.set_name || resolvedName).trim(),
    author: String(row.author || "").trim(),
    publisher: String(row.publisher || "").trim(),
    pub_year: String(row.pub_year || "").trim(),
    edition: String(row.edition || "").trim(),
    category: String(row.category || "").trim(),
    tags: parseTags(row.tags),
    cabinet_id: (row as any).cabinet_id ? Number((row as any).cabinet_id) : null,
    shelf_number: typeof (row as any).shelf_number === "number" ? Number((row as any).shelf_number) : null,
  };
}

function isDiskFileStillReferenced(db: DbClient, filePath: string, excludeQueueId?: number): boolean {
  const clean = String(filePath || "").trim();
  if (!clean) return false;
  const nowIso = new Date().toISOString();
  const imgRef = db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM book_images bi
     LEFT JOIN books b ON b.barcode = bi.book_barcode
     WHERE bi.file_path = ?
       AND (
         (bi.deleted_at IS NULL AND bi.expires_at > ?)
         OR (b.barcode IS NOT NULL AND b.deleted_at IS NOT NULL)
       )`,
    clean,
    nowIso
  );
  if ((imgRef?.c ?? 0) > 0) return true;

  const qRows = db.all<{ id: number; image_path: string; extra_images_json: string }>(
    `SELECT id, image_path, extra_images_json FROM ai_catalog_queue
     WHERE (approval_status = 'pending' AND deleted_at IS NULL)
        OR deleted_at IS NOT NULL`
  );
  for (const r of qRows) {
    if (excludeQueueId != null && r.id === excludeQueueId) continue;
    if (getItemImagePaths(r).includes(clean)) return true;
  }
  return false;
}

function safeUnlinkIfOrphaned(db: DbClient, filePath: string, excludeQueueId?: number): number {
  const clean = String(filePath || "").trim();
  if (!clean || isDiskFileStillReferenced(db, clean, excludeQueueId)) return 0;
  if (fs.existsSync(clean)) {
    try {
      const st = fs.statSync(clean);
      fs.unlinkSync(clean);
      return st.size;
    } catch {}
  }
  return 0;
}

function purgeExpiredRecycleAndImages(db: DbClient): void {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cutoffIso = new Date(nowMs - RETENTION_DAYS_MS).toISOString();

  const expiredImages = db.all<{ id: number; file_path: string }>(
    "SELECT id, file_path FROM book_images WHERE expires_at <= ? OR deleted_at IS NOT NULL",
    nowIso
  );
  if (expiredImages.length > 0) {
    db.transaction(() => {
      for (const img of expiredImages) {
        db.run("DELETE FROM book_images WHERE id = ?", img.id);
      }
    });
    for (const img of expiredImages) {
      safeUnlinkIfOrphaned(db, img.file_path);
    }
  }

  const expiredBooks = db.all<{ barcode: string }>(
    "SELECT barcode FROM books WHERE deleted_at IS NOT NULL AND deleted_at != '' AND deleted_at <= ?",
    cutoffIso
  );
  if (expiredBooks.length > 0) {
    const orphanPaths: string[] = [];
    db.transaction(() => {
      for (const bk of expiredBooks) {
        const imgs = db.all<{ file_path: string }>("SELECT file_path FROM book_images WHERE book_barcode = ?", bk.barcode);
        for (const im of imgs) orphanPaths.push(im.file_path);
        db.run("DELETE FROM book_images WHERE book_barcode = ?", bk.barcode);
        db.run("DELETE FROM books WHERE barcode = ?", bk.barcode);
      }
    });
    for (const p of orphanPaths) safeUnlinkIfOrphaned(db, p);
  }

  const expiredQueue = db.all<{ id: number; image_path: string; extra_images_json: string }>(
    `SELECT id, image_path, extra_images_json FROM ai_catalog_queue
     WHERE deleted_at IS NOT NULL AND deleted_at != ''
       AND (
         (recycle_expires_at IS NOT NULL AND recycle_expires_at != '' AND recycle_expires_at <= ?)
         OR ((recycle_expires_at IS NULL OR recycle_expires_at = '') AND deleted_at <= ?)
       )`,
    nowIso,
    cutoffIso
  );
  if (expiredQueue.length > 0) {
    const qPaths: string[] = [];
    db.transaction(() => {
      for (const q of expiredQueue) {
        for (const p of getItemImagePaths(q)) qPaths.push(p);
        db.run("DELETE FROM ai_catalog_queue WHERE id = ?", q.id);
      }
    });
    for (const p of qPaths) safeUnlinkIfOrphaned(db, p);
  }
}

export function registerCatalogAiRoutes(app: Express, db: DbClient, dataDir: string, onSyncTrigger?: () => void, t: StringsTranslateFn = fallbackT) {
  const aiImagesDir = path.join(dataDir, "ai_images");
  fs.mkdirSync(aiImagesDir, { recursive: true });

  try {
    db.run(
      "UPDATE ai_catalog_queue SET processing_status = 'pending', processing_started_at = NULL WHERE processing_status = 'processing' AND deleted_at IS NULL"
    );
    purgeExpiredRecycleAndImages(db);
  } catch {}
  const retentionTimer = setInterval(() => {
    try { purgeExpiredRecycleAndImages(db); } catch {}
  }, 12 * 60 * 60 * 1000);
  if (typeof retentionTimer.unref === "function") retentionTimer.unref();

  async function processPendingQueue() {
    if (isQueueWorkerRunning) return;
    isQueueWorkerRunning = true;

    try {
      while (true) {
        const nextItem = db.get<{
          id: number;
          image_path: string;
          extra_images_json: string;
          is_shelf_set: number;
          extracted_json: string;
          default_cabinet_id?: number | null;
          default_shelf_number?: number | null;
        }>(
          "SELECT id, image_path, extra_images_json, is_shelf_set, extracted_json, default_cabinet_id, default_shelf_number FROM ai_catalog_queue WHERE processing_status = 'pending' AND approval_status = 'pending' AND deleted_at IS NULL ORDER BY id ASC LIMIT 1"
        );
        if (!nextItem) break;

        const controller = new AbortController();
        const abortEntry: { controller: AbortController; reason?: "manual_refresh" | "timeout" | "deleted"; activeApiKey?: string } = { controller };
        activeQueueAborts.set(nextItem.id, abortEntry);

        db.run(
          "UPDATE ai_catalog_queue SET processing_status = 'processing', processing_started_at = ?, error_message = NULL WHERE id = ?",
          new Date().toISOString(),
          nextItem.id
        );

        try {
          const paths = getItemImagePaths(nextItem).filter((p) => fs.existsSync(p));
          if (paths.length === 0) {
            throw new Error("קובץ התמונה לא נמצא בדיסק");
          }

          let preMeta: Record<string, unknown> = {};
          try {
            preMeta = JSON.parse(nextItem.extracted_json || "{}") || {};
          } catch {}
          const presetSetName = preMeta?.set_name ? String(preMeta.set_name).trim() : "";
          const existingSetCtx = presetSetName ? lookupExistingSetContext(db, presetSetName) : undefined;

          if (Number(nextItem.is_shelf_set) === 1) {
            const rawTitleCount =
              typeof preMeta._title_images_count === "number" && Number.isFinite(preMeta._title_images_count)
                ? Math.max(0, Math.min(paths.length, Math.round(preMeta._title_images_count)))
                : 1;
            const titlePaths = paths.slice(0, rawTitleCount);
            const spinePaths = paths.slice(rawTitleCount);

            if (titlePaths.length === 0 && !presetSetName) {
              throw new Error("נדרשת תמונת שער או בחירת סט קיים להמשך");
            }
            if (titlePaths.length === 0 && spinePaths.length === 0) {
              throw new Error("לא סופקו תמונות לפענוח הסט");
            }

            const titleParts = titlePaths.map((p) => ({
              buffer: fs.readFileSync(p),
              mimeType: detectMimeFromExt(p),
            }));
            const spineParts = spinePaths.map((p) => ({
              buffer: fs.readFileSync(p),
              mimeType: detectMimeFromExt(p),
            }));

            const setExtracted: ExtractedShelfSet = await analyzeShelfSetImages(
              db,
              titleParts,
              spineParts,
              existingSetCtx,
              {
                abortSignal: controller.signal,
                timeoutMs: 60_000,
                onKeyPicked: (entry) => {
                  abortEntry.activeApiKey = entry.apiKey;
                },
              }
            );
            if (presetSetName) {
              setExtracted.set_name = presetSetName;
            }

            // Post-extraction edition disambiguation & auto set lookup
            if (setExtracted.set_name) {
              setExtracted.set_name = disambiguateSetNameWithEdition(db, setExtracted.set_name, setExtracted.edition, setExtracted.publisher);
            }
            const discoveredSetName = setExtracted.set_name || presetSetName;
            const resolvedSetCtx = existingSetCtx || (discoveredSetName ? lookupExistingSetContext(db, discoveredSetName, setExtracted.edition, setExtracted.publisher) : undefined);
            if (resolvedSetCtx) {
              if (!setExtracted.author && resolvedSetCtx.author) setExtracted.author = resolvedSetCtx.author;
              if (!setExtracted.publisher && resolvedSetCtx.publisher) setExtracted.publisher = resolvedSetCtx.publisher;
              if (!setExtracted.pub_year && resolvedSetCtx.pub_year) setExtracted.pub_year = resolvedSetCtx.pub_year;
              if (!setExtracted.edition && resolvedSetCtx.edition) setExtracted.edition = resolvedSetCtx.edition;
              if ((!setExtracted.category || setExtracted.category === "ספרים") && resolvedSetCtx.category) {
                setExtracted.category = resolvedSetCtx.category;
              }
              // Smart Tag Merge: Base set tags + unique volume tags
              setExtracted.tags = Array.from(new Set([...(resolvedSetCtx.tags || []), ...(setExtracted.tags || [])])).filter(Boolean);
              if (resolvedSetCtx.cabinet_id && !nextItem.default_cabinet_id) {
                (setExtracted as any)._cabinet_id = resolvedSetCtx.cabinet_id;
              }
              if (resolvedSetCtx.shelf_number && !nextItem.default_shelf_number) {
                (setExtracted as any)._shelf_number = resolvedSetCtx.shelf_number;
              }
            }

            // Edition qualification for sets: e.g. משנה ברורה (וגשל)
            if (setExtracted.set_name && setExtracted.edition && !setExtracted.set_name.includes(setExtracted.edition)) {
              const cleanEd = setExtracted.edition.replace(/[()]/g, "").trim();
              if (cleanEd && !setExtracted.set_name.includes(cleanEd)) {
                // Keep set_name clean but ensure edition is preserved in metadata
              }
            }

            if (existingSetCtx) {
              if (!setExtracted.author && existingSetCtx.author) setExtracted.author = existingSetCtx.author;
              if (!setExtracted.publisher && existingSetCtx.publisher) setExtracted.publisher = existingSetCtx.publisher;
              if (!setExtracted.pub_year && existingSetCtx.pub_year) setExtracted.pub_year = existingSetCtx.pub_year;
              if (!setExtracted.edition && existingSetCtx.edition) setExtracted.edition = existingSetCtx.edition;
              if ((!setExtracted.category || setExtracted.category === "כללי") && existingSetCtx.category) {
                setExtracted.category = existingSetCtx.category;
              }
              if ((!setExtracted.tags || setExtracted.tags.length === 0) && existingSetCtx.tags?.length) {
                setExtracted.tags = existingSetCtx.tags;
              }
            }

            
            const batchOv = preMeta._batch_override && typeof preMeta._batch_override === "object"
              ? (preMeta._batch_override as Record<string, any>)
              : null;
            if (batchOv) {
              if (batchOv.set_name) setExtracted.set_name = String(batchOv.set_name);
              if (batchOv.author) setExtracted.author = String(batchOv.author);
              if (batchOv.publisher) setExtracted.publisher = String(batchOv.publisher);
              if (batchOv.pub_year) setExtracted.pub_year = String(batchOv.pub_year);
              if (batchOv.category) setExtracted.category = String(batchOv.category);
              if (batchOv.edition) setExtracted.edition = String(batchOv.edition);
              if (Array.isArray(batchOv.tags) && batchOv.tags.length > 0) {
                setExtracted.tags = Array.from(new Set([...(setExtracted.tags || []), ...batchOv.tags]));
              }
            }
            // Local authority normalization on extracted set
            if (setExtracted.author) {
              const authMatch = findAuthorityMatch(db, "author", setExtracted.author);
              if (authMatch && authMatch.confidence === "high") {
                setExtracted.author = authMatch.match;
              }
            }
            if (setExtracted.set_name) {
              const setMatch = findAuthorityMatch(db, "set_name", setExtracted.set_name);
              if (setMatch && setMatch.confidence === "high") {
                setExtracted.set_name = setMatch.match;
              }
            }
            if (setExtracted.publisher) {
              const pubMatch = findAuthorityMatch(db, "publisher", setExtracted.publisher);
              if (pubMatch && pubMatch.confidence === "high") {
                setExtracted.publisher = pubMatch.match;
              }
            }

            const curRow = db.get<{ deleted_at: string | null }>("SELECT deleted_at FROM ai_catalog_queue WHERE id = ?", nextItem.id);
            if (!curRow?.deleted_at) {
              db.run(
                "UPDATE ai_catalog_queue SET processing_status = 'done', processing_started_at = NULL, extracted_json = ?, spine_extracted_json = ?, error_message = NULL WHERE id = ?",
                JSON.stringify(setExtracted),
                JSON.stringify(setExtracted.volumes || []),
                nextItem.id
              );
            }
          } else {
            const imageBuffers = paths.map((p) => ({
              buffer: fs.readFileSync(p),
              mimeType: detectMimeFromExt(p),
            }));
            const extracted: ExtractedBookMetadata = await analyzeBookCoverImage(db, imageBuffers, "image/jpeg", {
              abortSignal: controller.signal,
              timeoutMs: 45_000,
              onKeyPicked: (entry) => {
                abortEntry.activeApiKey = entry.apiKey;
              },
            });
            if (presetSetName) {
              extracted.set_name = presetSetName;
            }

            // Post-extraction edition disambiguation & auto set lookup for single cover
            if (extracted.set_name) {
              extracted.set_name = disambiguateSetNameWithEdition(db, extracted.set_name, extracted.edition, extracted.publisher);
            }
            const discoveredSetName = extracted.set_name || presetSetName;
            const resolvedSetCtx = existingSetCtx || (discoveredSetName ? lookupExistingSetContext(db, discoveredSetName, extracted.edition, extracted.publisher) : undefined);
            if (resolvedSetCtx) {
              if (!extracted.author && resolvedSetCtx.author) extracted.author = resolvedSetCtx.author;
              if (!extracted.publisher && resolvedSetCtx.publisher) extracted.publisher = resolvedSetCtx.publisher;
              if (!extracted.pub_year && resolvedSetCtx.pub_year) extracted.pub_year = resolvedSetCtx.pub_year;
              if (!extracted.edition && resolvedSetCtx.edition) extracted.edition = resolvedSetCtx.edition;
              if ((!extracted.category || extracted.category === "ספרים") && resolvedSetCtx.category) {
                extracted.category = resolvedSetCtx.category;
              }
              // Smart Tag Merge
              extracted.tags = Array.from(new Set([...(resolvedSetCtx.tags || []), ...(extracted.tags || [])])).filter(Boolean);
              if (resolvedSetCtx.cabinet_id && !nextItem.default_cabinet_id) {
                (extracted as any)._cabinet_id = resolvedSetCtx.cabinet_id;
              }
              if (resolvedSetCtx.shelf_number && !nextItem.default_shelf_number) {
                (extracted as any)._shelf_number = resolvedSetCtx.shelf_number;
              }
            }

            
            const batchOv = preMeta._batch_override && typeof preMeta._batch_override === "object"
              ? (preMeta._batch_override as Record<string, any>)
              : null;
            if (batchOv) {
              if (batchOv.set_name) extracted.set_name = String(batchOv.set_name);
              if (batchOv.author) extracted.author = String(batchOv.author);
              if (batchOv.publisher) extracted.publisher = String(batchOv.publisher);
              if (batchOv.pub_year) extracted.pub_year = String(batchOv.pub_year);
              if (batchOv.category) extracted.category = String(batchOv.category);
              if (batchOv.edition) extracted.edition = String(batchOv.edition);
              if (batchOv.format_size) (extracted as any).format_size = String(batchOv.format_size);
              if (Array.isArray(batchOv.tags) && batchOv.tags.length > 0) {
                extracted.tags = Array.from(new Set([...(extracted.tags || []), ...batchOv.tags]));
              }
            }
            // Optional Google Search enrichment if enabled
            try {
              const enrichSetting = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'ai_internet_enrichment'")?.value;
              if (enrichSetting !== "0" && enrichSetting !== "false" && extracted.title) {
                const enriched = await enrichBookWithGoogleSearch(db, {
                  title: extracted.title,
                  author: extracted.author,
                  publisher: extracted.publisher,
                  set_name: extracted.set_name,
                });
                if (enriched) {
                  if (!extracted.pub_year && enriched.pub_year) extracted.pub_year = enriched.pub_year;
                  if (!extracted.notes && enriched.description) extracted.notes = enriched.description;
                  if (enriched.tags?.length) {
                    extracted.tags = Array.from(new Set([...(extracted.tags || []), ...enriched.tags])).slice(0, 10);
                  }
                }
              }
            } catch (enrichErr: any) {
              console.warn("[catalogAi] Search enrichment warning:", enrichErr?.message);
            }

            if (existingSetCtx) {
              if (!extracted.author && existingSetCtx.author) extracted.author = existingSetCtx.author;
              if (!extracted.publisher && existingSetCtx.publisher) extracted.publisher = existingSetCtx.publisher;
              if (!extracted.pub_year && existingSetCtx.pub_year) extracted.pub_year = existingSetCtx.pub_year;
              if (!extracted.edition && existingSetCtx.edition) extracted.edition = existingSetCtx.edition;
              if ((!extracted.category || extracted.category === "כללי") && existingSetCtx.category) {
                extracted.category = existingSetCtx.category;
              }
            }

            // Local Authority Normalization (0 tokens, 100% database consistency)
            if (extracted.author) {
              const authMatch = findAuthorityMatch(db, "author", extracted.author);
              if (authMatch) {
                if (authMatch.confidence === "high") {
                  extracted.authority_unified = {
                    field: "author",
                    original: extracted.author,
                    matched: authMatch.match,
                  };
                  extracted.canonical_author = authMatch.match;
                  extracted.author = authMatch.match;
                } else {
                  extracted.authority_suggestion = {
                    field: "author",
                    suggestion: authMatch.match,
                    confidence: Math.round(authMatch.score * 100),
                  };
                }
              }
            }

            if (extracted.set_name) {
              const setMatch = findAuthorityMatch(db, "set_name", extracted.set_name);
              if (setMatch && setMatch.confidence === "high") {
                extracted.set_name = setMatch.match;
              }
            }

            if (extracted.publisher) {
              const pubMatch = findAuthorityMatch(db, "publisher", extracted.publisher);
              if (pubMatch && pubMatch.confidence === "high") {
                extracted.publisher = pubMatch.match;
              }
            }

            const curRow = db.get<{ deleted_at: string | null }>("SELECT deleted_at FROM ai_catalog_queue WHERE id = ?", nextItem.id);
            if (!curRow?.deleted_at) {
              db.run(
                "UPDATE ai_catalog_queue SET processing_status = 'done', processing_started_at = NULL, extracted_json = ?, error_message = NULL WHERE id = ?",
                JSON.stringify(extracted),
                nextItem.id
              );
            }
          }
        } catch (err) {
          const curRow = db.get<{ deleted_at: string | null }>("SELECT deleted_at FROM ai_catalog_queue WHERE id = ?", nextItem.id);
          if (abortEntry.reason === "manual_refresh" && !curRow?.deleted_at) {
            db.run(
              "UPDATE ai_catalog_queue SET processing_status = 'pending', processing_started_at = NULL, error_message = NULL WHERE id = ?",
              nextItem.id
            );
          } else if (abortEntry.reason !== "deleted" && !curRow?.deleted_at) {
            db.run(
              "UPDATE ai_catalog_queue SET processing_status = 'error', processing_started_at = NULL, error_message = ? WHERE id = ?",
              formatGeminiError(err),
              nextItem.id
            );
          }
        } finally {
          activeQueueAborts.delete(nextItem.id);
        }

        const more = db.get<{ c: number }>(
          "SELECT COUNT(*) AS c FROM ai_catalog_queue WHERE processing_status = 'pending' AND approval_status = 'pending' AND deleted_at IS NULL"
        );
        if ((more?.c ?? 0) > 0) {
          const cfg = getAiConfig(db);
          const readyKeys = getAiKeyPoolPublicStatus(db).filter((k) => k.enabled && k.status === "ready").length;
          const effectiveDelay =
            readyKeys > 1 ? Math.max(1000, Math.round(cfg.delayMs / Math.min(readyKeys, 4))) : cfg.delayMs;
          await sleep(effectiveDelay);
        }
      }
    } finally {
      isQueueWorkerRunning = false;
    }
  }

  // AI Key Pool Roulette Management
  app.get("/api/ai/keys", requireAdmin, (_req, res) => {
    res.json({ keys: getAiKeyPoolPublicStatus(db) });
  });

  app.put("/api/ai/keys", requireAdmin, (req, res) => {
    const incoming = Array.isArray(req.body?.keys) ? req.body.keys : [];
    saveAiKeyPool(db, incoming);
    res.json({ ok: true, keys: getAiKeyPoolPublicStatus(db) });
  });

  app.post("/api/ai/keys/:id/test", requireAdmin, async (req, res) => {
    const id = String(req.params.id || "").trim();
    const result = await testSinglePoolKey(db, id);
    res.json({ ...result, keys: getAiKeyPoolPublicStatus(db) });
  });

  // Test AI API connection (via key roulette)
  app.post("/api/ai/test", requireAdmin, async (_req, res) => {
    const result = await testGeminiConnection(db);
    res.json({ ...result, keys: getAiKeyPoolPublicStatus(db) });
  });

  // Embeddings coverage stats
  app.get("/api/ai/embeddings-stats", requireAdmin, (_req, res) => {
    const totalBooks = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM books WHERE deleted_at IS NULL")?.c ?? 0;
    const indexedBooks =
      db.get<{ c: number }>("SELECT COUNT(*) AS c FROM books WHERE deleted_at IS NULL AND embedding IS NOT NULL")?.c ??
      0;
    res.json({
      totalBooks,
      indexedBooks,
      missingBooks: Math.max(0, totalBooks - indexedBooks),
    });
  });

  // Index missing books with 768d embeddings
  app.post("/api/ai/reindex-embeddings", requireAdmin, async (req, res) => {
    const forceAll = Boolean(req.body?.forceAll);
    const cfg = getAiConfig(db);
    if (!cfg.hasAnyKey) {
      return res.status(400).json({ error: t("errors.aiNoActiveKeys") });
    }

    const rows = db.all<Record<string, unknown>>(
      forceAll
        ? "SELECT barcode, sync_id, title, set_name, sub_series, coverage_range, author, volume, publisher, pub_year, edition, category, tags, notes FROM books WHERE deleted_at IS NULL"
        : "SELECT barcode, sync_id, title, set_name, sub_series, coverage_range, author, volume, publisher, pub_year, edition, category, tags, notes FROM books WHERE deleted_at IS NULL AND embedding IS NULL"
    );

    let indexed = 0;
    let failed = 0;
    let lastError = "";

    for (let i = 0; i < rows.length; i++) {
      const b = rows[i];
      try {
        const text = buildBookEmbeddingText({
          title: String(b.title || ""),
          set_name: String(b.set_name || ""),
          sub_series: String(b.sub_series || ""),
          coverage_range: String(b.coverage_range || ""),
          author: String(b.author || ""),
          volume: String(b.volume || ""),
          publisher: String(b.publisher || ""),
          pub_year: String(b.pub_year || ""),
          edition: String(b.edition || ""),
          category: String(b.category || ""),
          tags: String(b.tags || "[]"),
          notes: String(b.notes || ""),
        });
        const vec = await generateTextEmbedding(db, text);
        const blob = float32ToBlob(vec);
        const nowIso = new Date().toISOString();
        db.run("UPDATE books SET embedding = ?, updated_at = ? WHERE barcode = ?", blob, nowIso, String(b.barcode));
        if (b.sync_id) enqueueSyncOutbox(db, "book", String(b.sync_id), "upsert", { barcode: String(b.barcode) });
        indexed++;
      } catch (err) {
        failed++;
        lastError = formatGeminiError(err);
        if (lastError.includes("אין חיבור") || lastError.includes("403")) {
          break;
        }
      }
      if (i < rows.length - 1) {
        await sleep(350);
      }
    }

    const statsAfter =
      db.get<{ c: number }>("SELECT COUNT(*) AS c FROM books WHERE deleted_at IS NULL AND embedding IS NOT NULL")?.c ??
      0;
    const totalBooks = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM books WHERE deleted_at IS NULL")?.c ?? 0;
    res.json({
      ok: failed === 0 || indexed > 0,
      attempted: rows.length,
      indexed,
      failed,
      lastError: lastError || undefined,
      totalBooks,
      indexedBooks: statsAfter,
      missingBooks: Math.max(0, totalBooks - statsAfter),
    });
  });

  // Cleanup unreferenced/expired cover images from disk (preserves 30-day retained book_images & Recycle Bin)
  app.post("/api/ai/cleanup-images", requireAdmin, (_req, res) => {
    purgeExpiredRecycleAndImages(db);
    const rows = db.all<{ id: number; image_path: string; extra_images_json: string }>(
      "SELECT id, image_path, extra_images_json FROM ai_catalog_queue WHERE approval_status IN ('approved', 'rejected') AND deleted_at IS NULL AND (image_path != '' OR extra_images_json != '[]')"
    );
    let deletedFiles = 0;
    let freedBytes = 0;
    for (const r of rows) {
      let allOrphaned = true;
      for (const p of getItemImagePaths(r)) {
        if (isDiskFileStillReferenced(db, p, r.id)) {
          allOrphaned = false;
        } else {
          const freed = safeUnlinkIfOrphaned(db, p, r.id);
          if (freed > 0) {
            freedBytes += freed;
            deletedFiles++;
          }
        }
      }
      if (allOrphaned) {
        db.run("UPDATE ai_catalog_queue SET image_path = '', extra_images_json = '[]' WHERE id = ?", r.id);
      }
    }
    res.json({
      ok: true,
      deletedFiles,
      freedKb: Math.round(freedBytes / 1024),
    });
  });

  // List AI queue items
  app.get("/api/ai-queue", requireAdmin, (req, res) => {
    const approval = typeof req.query.approval === "string" ? req.query.approval : "pending";
    const whereClause = approval === "all" ? "WHERE deleted_at IS NULL" : "WHERE approval_status = 'pending' AND deleted_at IS NULL";
    const rows = db.all<Record<string, unknown>>(
      `SELECT * FROM ai_catalog_queue ${whereClause} ORDER BY id ASC`
    );

    const mapped = rows.map((r) => {
      let extracted = null;
      if (typeof r.extracted_json === "string" && r.extracted_json) {
        try {
          extracted = JSON.parse(r.extracted_json);
        } catch {}
      }
      const existingPaths = getItemImagePaths(r as any).filter((p) => fs.existsSync(p));
      return {
        id: r.id,
        has_image: existingPaths.length > 0,
        image_count: existingPaths.length,
        default_cabinet_id: r.default_cabinet_id ?? null,
        default_shelf_number: r.default_shelf_number ?? null,
        source_relay_id: r.source_relay_id || null,
        set_batch_id: r.set_batch_id ? String(r.set_batch_id) : null,
        is_shelf_set: Boolean(r.is_shelf_set),
        spine_extracted: parseSpineVolumes(r.spine_extracted_json),
        processing_status: r.processing_status,
        processing_started_at: r.processing_started_at || null,
        extracted,
        error_message: r.error_message || null,
        approval_status: r.approval_status,
        created_at: r.created_at,
      };
    });

    res.json({ items: mapped, workerRunning: isQueueWorkerRunning });
  });

  // Stream queue cover image (supports ?index=0,1,2... for multi-page items)
  app.get("/api/ai-queue/image/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const idx = Math.max(0, Number(req.query.index) || 0);
    const row = db.get<{ image_path: string; extra_images_json: string }>(
      "SELECT image_path, extra_images_json FROM ai_catalog_queue WHERE id = ?",
      id
    );
    if (!row) return res.status(404).send("Image not found");
    const existingPaths = getItemImagePaths(row).filter((p) => fs.existsSync(p));
    const targetPath = existingPaths[idx] || existingPaths[0];
    if (!targetPath) {
      return res.status(404).send("Image not found");
    }
    res.type(detectMimeFromExt(targetPath));
    res.sendFile(path.resolve(targetPath));
  });

  const saveBase64ToFile = (rawB64Input: unknown, mimeInput: unknown): string | null => {
    const rawB64 = String(rawB64Input || "");
    if (!rawB64) return null;
    const cleanB64 = rawB64.includes(",") ? rawB64.split(",")[1] : rawB64;
    const mime = String(mimeInput || "image/jpeg");
    const ext = mime.includes("webp") ? ".webp" : mime.includes("png") ? ".png" : ".jpg";
    const fileName = `cover_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const destPath = path.join(aiImagesDir, fileName);
    fs.writeFileSync(destPath, Buffer.from(cleanB64, "base64"));
    return destPath;
  };

  // Upload compressed cover image(s) to AI queue (supports continuous set batch)
  app.post("/api/ai-queue/upload", requireAdmin, (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const autoProcess = req.body?.autoProcess !== false;
    const globalSetBatchId = req.body?.set_batch_id ? String(req.body.set_batch_id).trim() : null;
    const globalPresetSetName = req.body?.preset_set_name ? String(req.body.preset_set_name).trim() : "";

    if (items.length === 0) {
      return res.status(400).json({ error: t("errors.aiNoImagesUploaded") });
    }

    const now = new Date().toISOString();
    const createdIds: number[] = [];

    db.transaction(() => {
      for (const item of items) {
        const savedPaths: string[] = [];
        if (Array.isArray(item?.images) && item.images.length > 0) {
          for (const sub of item.images) {
            const p = saveBase64ToFile(sub?.imageBase64, sub?.mimeType);
            if (p) savedPaths.push(p);
          }
        } else {
          const p = saveBase64ToFile(item?.imageBase64, item?.mimeType);
          if (p) savedPaths.push(p);
        }
        if (savedPaths.length === 0) continue;

        const [firstPath, ...extraPaths] = savedPaths;
        const setBatchId = item?.set_batch_id ? String(item.set_batch_id).trim() : globalSetBatchId;
        const defaultCabId = item?.default_cabinet_id != null ? Number(item.default_cabinet_id) : null;
        const defaultShelf = item?.default_shelf_number != null ? Number(item.default_shelf_number) : null;

        const presetSetName = item?.preset_set_name ? String(item.preset_set_name).trim() : globalPresetSetName;
        const initialExtractedJson = presetSetName ? JSON.stringify({ set_name: presetSetName }) : "";
        const info = db.run(
          "INSERT INTO ai_catalog_queue (image_path, extra_images_json, default_cabinet_id, default_shelf_number, set_batch_id, extracted_json, processing_status, approval_status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?)",
          firstPath,
          JSON.stringify(extraPaths),
          defaultCabId,
          defaultShelf,
          setBatchId,
          initialExtractedJson,
          now
        );
        createdIds.push(info.lastInsertRowid);
      }
    });

    if (autoProcess && createdIds.length > 0) {
      void processPendingQueue();
    }
    res.status(201).json({ ok: true, count: createdIds.length, ids: createdIds });
  });

  // Upload whole Shelf Set: 0..4 Title/Detail pages + Spine shelf photos
  app.post("/api/ai-queue/upload-shelf-set", requireAdmin, (req, res) => {
    const {
      titleImage,
      titleImages,
      spineImages = [],
      default_cabinet_id,
      default_shelf_number,
      set_batch_id,
      preset_set_name,
    } = req.body || {};
    const cleanPreset = preset_set_name ? String(preset_set_name).trim() : "";
    const rawTitleList = Array.isArray(titleImages)
      ? titleImages.slice(0, 4)
      : titleImage
      ? [titleImage]
      : [];

    const titlePaths: string[] = [];
    for (const tp of rawTitleList) {
      const p = saveBase64ToFile(tp?.imageBase64 || tp, tp?.mimeType);
      if (p) titlePaths.push(p);
    }

    const spinePaths: string[] = [];
    for (const sp of Array.isArray(spineImages) ? spineImages : []) {
      const p = saveBase64ToFile(sp?.imageBase64 || sp, sp?.mimeType);
      if (p) spinePaths.push(p);
    }

    if (titlePaths.length === 0 && !cleanPreset) {
      return res.status(400).json({ error: t("errors.aiCoverOrSetRequired") });
    }
    if (titlePaths.length === 0 && spinePaths.length === 0) {
      return res.status(400).json({ error: t("errors.aiSpineRequired") });
    }

    const allPaths = [...titlePaths, ...spinePaths];
    const [firstPath, ...extraPaths] = allPaths;
    const now = new Date().toISOString();
    const initialMeta: Record<string, unknown> = {
      _title_images_count: titlePaths.length,
    };
    if (cleanPreset) {
      initialMeta.set_name = cleanPreset;
    }

    const info = db.run(
      "INSERT INTO ai_catalog_queue (image_path, extra_images_json, default_cabinet_id, default_shelf_number, set_batch_id, is_shelf_set, extracted_json, processing_status, approval_status, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, 'pending', 'pending', ?)",
      firstPath,
      JSON.stringify(extraPaths),
      default_cabinet_id ? Number(default_cabinet_id) : null,
      default_shelf_number ? Number(default_shelf_number) : 1,
      set_batch_id ? String(set_batch_id).trim() : null,
      JSON.stringify(initialMeta),
      now
    );

    void processPendingQueue();
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  });

  // Apply unified set details across all pending items in a batch
  app.post("/api/ai-queue/batch-apply-set", requireAdmin, (req, res) => {
    const {
      batchId,
      set_name,
      author,
      publisher,
      category,
      default_cabinet_id,
      default_shelf_number,
      format_size,
      edition,
      pub_year,
      tags,
    } = req.body || {};
    if (!batchId && !set_name) return res.status(400).json({ error: t("errors.aiBatchIdRequired") });

    const cleanBatchId = batchId ? String(batchId).trim() : null;
    const cleanSetName = set_name ? String(set_name).trim() : null;
    const pendingInBatch = db.all<{ id: number; extracted_json: string }>(
      `SELECT id, extracted_json FROM ai_catalog_queue 
       WHERE approval_status = 'pending' AND deleted_at IS NULL
         AND (
           (? IS NOT NULL AND set_batch_id = ?) 
           OR (? IS NOT NULL AND json_extract(extracted_json, '$.set_name') = ?)
         )`,
      cleanBatchId,
      cleanBatchId,
      cleanSetName,
      cleanSetName
    );

    let updatedCount = 0;
    db.transaction(() => {
      for (const item of pendingInBatch) {
        let ext: Record<string, unknown> = {};
        try {
          ext = JSON.parse(item.extracted_json || "{}");
        } catch {}

        if (set_name !== undefined) ext.set_name = String(set_name).trim();
        if (author !== undefined) ext.author = String(author).trim();
        if (publisher !== undefined) ext.publisher = String(publisher).trim();
        if (category !== undefined) ext.category = String(category).trim();
        if (format_size !== undefined) ext.format_size = String(format_size).trim();
        if (edition !== undefined) ext.edition = String(edition).trim();
        if (pub_year !== undefined) ext.pub_year = String(pub_year).trim();
        if (Array.isArray(tags)) {
          const existingTags = Array.isArray(ext.tags) ? ext.tags : [];
          ext.tags = Array.from(new Set([...existingTags, ...tags.map((x: any) => String(x).trim()).filter(Boolean)]));
        }
        ext._batch_override = {
          set_name: set_name !== undefined ? String(set_name).trim() : undefined,
          author: author !== undefined ? String(author).trim() : undefined,
          publisher: publisher !== undefined ? String(publisher).trim() : undefined,
          pub_year: pub_year !== undefined ? String(pub_year).trim() : undefined,
          category: category !== undefined ? String(category).trim() : undefined,
          format_size: format_size !== undefined ? String(format_size).trim() : undefined,
          edition: edition !== undefined ? String(edition).trim() : undefined,
          tags: Array.isArray(tags) ? tags : undefined,
        };

        db.run(
          `UPDATE ai_catalog_queue 
           SET extracted_json = ?, 
               default_cabinet_id = COALESCE(?, default_cabinet_id), 
               default_shelf_number = COALESCE(?, default_shelf_number) 
           WHERE id = ?`,
          JSON.stringify(ext),
          default_cabinet_id != null ? Number(default_cabinet_id) : null,
          default_shelf_number != null ? Number(default_shelf_number) : null,
          item.id
        );
        updatedCount++;
      }
    });

    res.json({ ok: true, updatedCount });
  });

  // Trigger queue processing manually
  app.post("/api/ai-queue/process", requireAdmin, (_req, res) => {
    void processPendingQueue();
    res.json({ ok: true, started: true });
  });

  // Retry all failed items in queue
  app.post("/api/ai-queue/retry-errors", requireAdmin, (_req, res) => {
    const info = db.run(
      "UPDATE ai_catalog_queue SET processing_status = 'pending', processing_started_at = NULL, error_message = NULL WHERE processing_status = 'error' AND approval_status = 'pending' AND deleted_at IS NULL"
    );
    void processPendingQueue();
    res.json({ ok: true, requeued: info.changes });
  });

  // Retry failed item
  app.post("/api/ai-queue/:id/retry", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    db.run(
      "UPDATE ai_catalog_queue SET processing_status = 'pending', processing_started_at = NULL, error_message = NULL WHERE id = ? AND deleted_at IS NULL",
      id
    );
    void processPendingQueue();
    res.json({ ok: true });
  });

  // Manual instant refresh + API key rotation for stuck/slow AI decoding item
  app.post("/api/ai-queue/:id/refresh", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const row = db.get<{ id: number; deleted_at: string | null }>(
      "SELECT id, deleted_at FROM ai_catalog_queue WHERE id = ?",
      id
    );
    if (!row || row.deleted_at) {
      return res.status(404).json({ error: t("errors.aiQueueItemNotFound") });
    }
    const active = activeQueueAborts.get(id);
    let rotatedKey = false;
    if (active) {
      active.reason = "manual_refresh";
      if (active.activeApiKey) {
        markApiKeySlowCooldown(active.activeApiKey, 25_000, "הוחלף ידנית עקב חשיבה ארוכה");
        rotatedKey = true;
      }
      try { active.controller.abort(new Error("MANUAL_REFRESH")); } catch {}
    }
    db.run(
      "UPDATE ai_catalog_queue SET processing_status = 'pending', processing_started_at = NULL, error_message = NULL WHERE id = ? AND deleted_at IS NULL",
      id
    );
    setTimeout(() => { void processPendingQueue(); }, 120);
    void processPendingQueue();
    res.json({ ok: true, aborted: Boolean(active), rotatedKey });
  });

  // Approve queue item -> creates book(s) with sequential barcodes + print queue + optional async embedding
  app.post("/api/ai-queue/:id/approve", requireAdmin, (req, res) => {
    const id = Number(req.params.id);

    const {
      title,
      set_name = "",
      sub_series = "",
      set_global_number = null,
      author = "",
      volume = "",
      coverage_range = "",
      publisher = "",
      pub_year = "",
      edition = "",
      category = "",
      tags = [],
      cabinet_id = null,
      shelf_number = 1,
      notes = "",
      status = "available",
      format_size = "",
      thickness_mm = null,
      pages_count = null,
      copiesCount = 1,
      volumes, // optional array for batch shelf-set approval
    } = req.body || {};

    const existingRow = db.get<{ id: number; image_path: string; extra_images_json: string }>(
      "SELECT id, image_path, extra_images_json FROM ai_catalog_queue WHERE id = ? AND deleted_at IS NULL",
      id
    );
    if (!existingRow) {
      return res.status(404).json({ error: t("errors.aiQueueItemNotFound") });
    }

    const prefix = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'barcode_prefix'")?.value ?? "";
    let nextNum =
      parseInt(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'next_barcode'")?.value ?? "100001", 10) ||
      100001;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + RETENTION_DAYS_MS).toISOString();
    const queueImagePaths = getItemImagePaths(existingRow).filter((p) => fs.existsSync(p));
    const tagsArr = parseTags(tags);
    const createdBarcodes: string[] = [];

    const parsedThickness =
      thickness_mm !== null && thickness_mm !== "" && Number(thickness_mm) > 0 ? Number(thickness_mm) : null;
    const parsedPages =
      pages_count !== null && pages_count !== "" && Number(pages_count) > 0 ? Math.round(Number(pages_count)) : null;
    const parsedTopGlobalNum =
      set_global_number !== null && set_global_number !== "" && Number(set_global_number) > 0
        ? Math.round(Number(set_global_number))
        : null;

    // Batch shelf-set approval
    if (Array.isArray(volumes) && volumes.length > 0) {
      db.transaction(() => {
        for (const volItem of volumes) {
          const vName = String(volItem?.volume || "").trim();
          if (!vName) continue;
          const vSubSeries = String(volItem?.sub_series ?? sub_series ?? "").trim();
          const vGlobalNumRaw = volItem?.set_global_number != null && volItem?.set_global_number !== "" ? Number(volItem.set_global_number) : parsedTopGlobalNum;
          const vGlobalNum = vGlobalNumRaw != null && Number.isFinite(vGlobalNumRaw) && vGlobalNumRaw > 0 ? Math.round(vGlobalNumRaw) : null;
          const vCoverage = String(volItem?.coverage_range ?? coverage_range ?? "").trim();
          const vPubYear = String(volItem?.pub_year ?? pub_year ?? "").trim();
          const vFormatSize = String(volItem?.format_size ?? format_size ?? "").trim();
          const vCopies = Math.max(1, Math.min(20, Number(volItem.copiesCount) || 1));
          const vTitle = title
            ? String(title).trim()
            : set_name
            ? (vSubSeries ? `${set_name} - ${vSubSeries} (${vName})` : `${set_name} ${vName}`)
            : vName;
          const vNotes = volItem.notes ? `${notes ? notes + " | " : ""}${volItem.notes}` : notes;

          for (let c = 0; c < vCopies; c++) {
            while (db.get("SELECT barcode FROM books WHERE barcode = ?", prefix + String(nextNum))) {
              nextNum++;
            }
            const code = prefix + String(nextNum);
            nextNum++;
            const syncId = newSyncId();
            const norm = buildNormalizedBookSearch([
              code,
              vTitle,
              String(set_name || ""),
              vSubSeries,
              String(author || ""),
              vName,
              vCoverage,
              String(publisher || ""),
              String(pub_year || ""),
              String(edition || ""),
              String(category || ""),
              tagsArr.join(" "),
              vNotes,
            ]);

            db.run(
              `INSERT INTO books (barcode, title, set_name, sub_series, set_global_number, author, volume, coverage_range, publisher, pub_year, edition, category, tags, normalized_search, cabinet_id, shelf_number, notes, status, label_printed, created_at, format_size, thickness_mm, pages_count, barcode_status, sync_id, updated_at) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'assigned', ?, ?)`,
              code,
              vTitle,
              String(set_name || "").trim(),
              vSubSeries,
              vGlobalNum,
              String(author || "").trim(),
              vName,
              vCoverage,
              String(publisher || "").trim(),
              vPubYear,
              String(edition || "").trim(),
              String(category || "").trim(),
              JSON.stringify(tagsArr),
              norm,
              cabinet_id ? Number(cabinet_id) : null,
              shelf_number ? Number(shelf_number) : 1,
              String(vNotes).trim(),
              String(status),
              now,
              vFormatSize,
              parsedThickness,
              parsedPages,
              syncId,
              now
            );
            for (const imgPath of queueImagePaths) {
              db.run(
                "INSERT INTO book_images (book_barcode, file_path, mime_type, source_type, queue_id, created_at, expires_at) VALUES (?, ?, ?, 'ai_queue', ?, ?, ?)",
                code,
                imgPath,
                detectMimeFromExt(imgPath),
                id,
                now,
                expiresAt
              );
            }
            enqueueSyncOutbox(db, "book", syncId, "upsert", { barcode: code });
            createdBarcodes.push(code);
          }
        }
        db.run(
          "INSERT INTO settings (key, value) VALUES ('next_barcode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          String(nextNum)
        );
        db.run("UPDATE ai_catalog_queue SET approval_status = 'approved' WHERE id = ?", id);
      });
    } else {
      // Standard single queue item approval
      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: t("errors.aiTitleRequiredBeforeApprove") });
      }

      const count = Math.max(1, Math.min(200, Number(copiesCount) || 1));
      db.transaction(() => {
        for (let i = 0; i < count; i++) {
          while (db.get("SELECT barcode FROM books WHERE barcode = ?", prefix + String(nextNum))) {
            nextNum++;
          }
          const code = prefix + String(nextNum);
          nextNum++;
          const syncId = newSyncId();
          const norm = buildNormalizedBookSearch([
            code,
            String(title),
            String(set_name),
            String(sub_series),
            String(author),
            String(volume),
            String(coverage_range),
            String(publisher),
            String(pub_year),
            String(edition),
            String(category),
            tagsArr.join(" "),
            String(notes),
          ]);
          db.run(
            `INSERT INTO books (barcode, title, set_name, sub_series, set_global_number, author, volume, coverage_range, publisher, pub_year, edition, category, tags, normalized_search, cabinet_id, shelf_number, notes, status, label_printed, created_at, format_size, thickness_mm, pages_count, barcode_status, sync_id, updated_at) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'assigned', ?, ?)`,
            code,
            String(title).trim(),
            String(set_name || "").trim(),
            String(sub_series || "").trim(),
            parsedTopGlobalNum,
            String(author).trim(),
            String(volume).trim(),
            String(coverage_range || "").trim(),
            String(publisher).trim(),
            String(pub_year).trim(),
            String(edition).trim(),
            String(category).trim(),
            JSON.stringify(tagsArr),
            norm,
            cabinet_id ? Number(cabinet_id) : null,
            shelf_number ? Number(shelf_number) : 1,
            String(notes).trim(),
            String(status),
            now,
            String(format_size || "").trim(),
            parsedThickness,
            parsedPages,
            syncId,
            now
          );
          for (const imgPath of queueImagePaths) {
            db.run(
              "INSERT INTO book_images (book_barcode, file_path, mime_type, source_type, queue_id, created_at, expires_at) VALUES (?, ?, ?, 'ai_queue', ?, ?, ?)",
              code,
              imgPath,
              detectMimeFromExt(imgPath),
              id,
              now,
              expiresAt
            );
          }
          enqueueSyncOutbox(db, "book", syncId, "upsert", { barcode: code });
          createdBarcodes.push(code);
        }
        db.run(
          "INSERT INTO settings (key, value) VALUES ('next_barcode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          String(nextNum)
        );
        db.run("UPDATE ai_catalog_queue SET approval_status = 'approved' WHERE id = ?", id);
      });
    }

    // Best-effort non-blocking 768d embedding generation when online & API key configured
    const cfg = getAiConfig(db);
    if (cfg.hasAnyKey && createdBarcodes.length > 0) {
      const embText = buildBookEmbeddingText({
        title,
        set_name,
        sub_series,
        coverage_range,
        author,
        volume,
        publisher,
        pub_year,
        edition,
        category,
        tags: tagsArr,
        notes,
      });
      void generateTextEmbedding(db, embText)
        .then((vec) => {
          const blob = float32ToBlob(vec);
          const embNow = new Date().toISOString();
          for (const bc of createdBarcodes) {
            db.run("UPDATE books SET embedding = ?, updated_at = ? WHERE barcode = ?", blob, embNow, bc);
            const row = db.get<{ sync_id: string }>("SELECT sync_id FROM books WHERE barcode = ?", bc);
            if (row?.sync_id) enqueueSyncOutbox(db, "book", row.sync_id, "upsert", { barcode: bc });
          }
          onSyncTrigger?.();
        })
        .catch(() => {});
    }

    res.status(201).json({ ok: true, barcodes: createdBarcodes, nextBarcode: prefix + String(nextNum) });
  });

  app.post("/api/ai-queue/:id/reject", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const active = activeQueueAborts.get(id);
    if (active) {
      active.reason = "deleted";
      try { active.controller.abort(new Error("SOFT_DELETED")); } catch {}
    }
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + RETENTION_DAYS_MS).toISOString();
    db.run(
      `UPDATE ai_catalog_queue
       SET approval_status = 'rejected',
           processing_status = CASE WHEN processing_status = 'processing' THEN 'pending' ELSE processing_status END,
           processing_started_at = NULL,
           deleted_at = COALESCE(deleted_at, ?),
           recycle_expires_at = COALESCE(recycle_expires_at, ?)
       WHERE id = ?`,
      nowIso,
      expiresAt,
      id
    );
    res.json({ ok: true, recycled: true, expiresAt });
  });

  app.delete("/api/ai-queue/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const active = activeQueueAborts.get(id);
    if (active) {
      active.reason = "deleted";
      try { active.controller.abort(new Error("SOFT_DELETED")); } catch {}
    }
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + RETENTION_DAYS_MS).toISOString();
    db.run(
      `UPDATE ai_catalog_queue
       SET approval_status = 'rejected',
           processing_status = CASE WHEN processing_status = 'processing' THEN 'pending' ELSE processing_status END,
           processing_started_at = NULL,
           deleted_at = COALESCE(deleted_at, ?),
           recycle_expires_at = COALESCE(recycle_expires_at, ?)
       WHERE id = ?`,
      nowIso,
      expiresAt,
      id
    );
    res.json({ ok: true, recycled: true, expiresAt });
  });

  // --- 30-Day Retained Book Images & Post-Approval AI Re-Edit ---
  app.get("/api/books/:barcode/images", requireAdmin, (req, res) => {
    const barcode = String(req.params.barcode || "").trim();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const rows = db.all<{
      id: number;
      book_barcode: string;
      file_path: string;
      mime_type: string;
      source_type: string;
      created_at: string;
      expires_at: string;
    }>(
      "SELECT id, book_barcode, file_path, mime_type, source_type, created_at, expires_at FROM book_images WHERE book_barcode = ? AND deleted_at IS NULL AND expires_at > ? ORDER BY id ASC",
      barcode,
      nowIso
    );
    const images = rows
      .filter((r) => fs.existsSync(r.file_path))
      .map((r) => ({
        id: r.id,
        book_barcode: r.book_barcode,
        mime_type: r.mime_type || detectMimeFromExt(r.file_path),
        source_type: r.source_type,
        created_at: r.created_at,
        expires_at: r.expires_at,
        days_remaining: Math.max(1, Math.ceil((Date.parse(r.expires_at) - nowMs) / 86_400_000)),
      }));
    res.json({ images });
  });

  app.get("/api/books/:barcode/images/:imageId", requireAdmin, (req, res) => {
    const barcode = String(req.params.barcode || "").trim();
    const imageId = Number(req.params.imageId);
    const row = db.get<{ file_path: string; mime_type: string }>(
      "SELECT file_path, mime_type FROM book_images WHERE id = ? AND book_barcode = ? AND deleted_at IS NULL",
      imageId,
      barcode
    );
    if (!row || !row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(404).send("Image not found");
    }
    res.type(row.mime_type || detectMimeFromExt(row.file_path));
    res.sendFile(path.resolve(row.file_path));
  });

  app.post("/api/books/:barcode/ai-reanalyze", requireAdmin, async (req, res) => {
    const barcode = String(req.params.barcode || "").trim();
    const book = db.get<Record<string, unknown>>(
      "SELECT * FROM books WHERE barcode = ? AND deleted_at IS NULL",
      barcode
    );
    if (!book) {
      return res.status(404).json({ error: t("errors.bookNotFound") });
    }
    const cfg = getAiConfig(db);
    if (!cfg.hasAnyKey) {
      return res.status(400).json({ error: t("errors.aiNoActiveKeys") });
    }

    const customPrompt = typeof req.body?.customPrompt === "string" ? req.body.customPrompt.trim() : "";
    const rawExtraImages = Array.isArray(req.body?.extraImages) ? req.body.extraImages.slice(0, 6) : [];
    const saveExtraImages = req.body?.saveExtraImages !== false;

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + RETENTION_DAYS_MS).toISOString();
    const savedRows = db.all<{ id: number; file_path: string; mime_type: string }>(
      "SELECT id, file_path, mime_type FROM book_images WHERE book_barcode = ? AND deleted_at IS NULL AND expires_at > ? ORDER BY id ASC",
      barcode,
      nowIso
    ).filter((r) => fs.existsSync(r.file_path));

    const imageParts: Array<{ buffer: Buffer; mimeType: string }> = savedRows.map((r) => ({
      buffer: fs.readFileSync(r.file_path),
      mimeType: r.mime_type || detectMimeFromExt(r.file_path),
    }));

    let usedExtraImagesCount = 0;
    for (const ex of rawExtraImages) {
      const rawB64 = String(ex?.imageBase64 || ex || "");
      if (!rawB64) continue;
      const cleanB64 = rawB64.includes(",") ? rawB64.split(",")[1] : rawB64;
      const mime = String(ex?.mimeType || "image/jpeg");
      const buf = Buffer.from(cleanB64, "base64");
      if (buf.length === 0) continue;
      imageParts.push({ buffer: buf, mimeType: mime });
      usedExtraImagesCount++;
      if (saveExtraImages) {
        const savedPath = saveBase64ToFile(rawB64, mime);
        if (savedPath) {
          db.run(
            "INSERT INTO book_images (book_barcode, file_path, mime_type, source_type, created_at, expires_at) VALUES (?, ?, ?, 'reedit_upload', ?, ?)",
            barcode,
            savedPath,
            mime,
            nowIso,
            expiresAt
          );
        }
      }
    }

    if (imageParts.length === 0 && !customPrompt) {
      return res.status(400).json({ error: "לא נמצאו תמונות שמורות ולא סופקה הנחיית עריכה" });
    }

    try {
      const proposed = await reanalyzeApprovedBook(
        db,
        {
          title: String(book.title || ""),
          set_name: String(book.set_name || ""),
          sub_series: String(book.sub_series || ""),
          set_global_number: book.set_global_number != null ? Number(book.set_global_number) : null,
          coverage_range: String(book.coverage_range || ""),
          author: String(book.author || ""),
          volume: String(book.volume || ""),
          publisher: String(book.publisher || ""),
          pub_year: String(book.pub_year || ""),
          edition: String(book.edition || ""),
          category: String(book.category || ""),
          notes: String(book.notes || ""),
          tags: parseTags(book.tags),
        },
        imageParts,
        customPrompt,
        { timeoutMs: 45_000 }
      );
      if (proposed.author) {
        const authMatch = findAuthorityMatch(db, "author", proposed.author);
        if (authMatch && authMatch.confidence === "high") proposed.author = authMatch.match;
      }
      if (proposed.set_name) {
        const setMatch = findAuthorityMatch(db, "set_name", proposed.set_name);
        if (setMatch && setMatch.confidence === "high") proposed.set_name = setMatch.match;
      }
      if (proposed.publisher) {
        const pubMatch = findAuthorityMatch(db, "publisher", proposed.publisher);
        if (pubMatch && pubMatch.confidence === "high") proposed.publisher = pubMatch.match;
      }
      res.json({
        ok: true,
        proposed,
        usedSavedImagesCount: savedRows.length,
        usedExtraImagesCount,
      });
    } catch (err) {
      res.status(502).json({ error: formatGeminiError(err) });
    }
  });

  // --- 30-Day Recycle Bin (Deleted Books & Rejected/Deleted AI Scans) ---
  app.get("/api/recycle-bin", requireAdmin, (_req, res) => {
    purgeExpiredRecycleAndImages(db);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const deletedBooks = db.all<Record<string, unknown>>(
      `SELECT b.barcode, b.title, b.set_name, b.sub_series, b.set_global_number, b.author, b.volume, b.coverage_range,
              b.publisher, b.pub_year, b.edition, b.category, b.tags, b.cabinet_id, b.shelf_number, b.notes, b.deleted_at,
              c.code AS cabinet_code
       FROM books b
       LEFT JOIN cabinets c ON b.cabinet_id = c.id AND c.deleted_at IS NULL
       WHERE b.deleted_at IS NOT NULL AND b.deleted_at != ''
       ORDER BY b.deleted_at DESC`
    );

    const booksOut = deletedBooks.map((b) => {
      const delMs = Date.parse(String(b.deleted_at || nowIso)) || nowMs;
      const expiresMs = delMs + RETENTION_DAYS_MS;
      const imgs = db.all<{ id: number; file_path: string }>(
        "SELECT id, file_path FROM book_images WHERE book_barcode = ? AND deleted_at IS NULL AND expires_at > ?",
        String(b.barcode),
        nowIso
      ).filter((im) => fs.existsSync(im.file_path));
      return {
        barcode: String(b.barcode),
        title: String(b.title || ""),
        set_name: String(b.set_name || ""),
        sub_series: String(b.sub_series || ""),
        set_global_number: b.set_global_number != null ? Number(b.set_global_number) : null,
        author: String(b.author || ""),
        volume: String(b.volume || ""),
        coverage_range: String(b.coverage_range || ""),
        publisher: String(b.publisher || ""),
        pub_year: String(b.pub_year || ""),
        edition: String(b.edition || ""),
        category: String(b.category || ""),
        tags: parseTags(b.tags),
        cabinet_id: b.cabinet_id != null ? Number(b.cabinet_id) : null,
        cabinet_code: b.cabinet_code ? String(b.cabinet_code) : null,
        shelf_number: b.shelf_number != null ? Number(b.shelf_number) : null,
        notes: String(b.notes || ""),
        deleted_at: String(b.deleted_at || nowIso),
        days_remaining: Math.max(0, Math.ceil((expiresMs - nowMs) / 86_400_000)),
        images_count: imgs.length,
      };
    });

    const deletedAi = db.all<Record<string, unknown>>(
      "SELECT * FROM ai_catalog_queue WHERE deleted_at IS NOT NULL AND deleted_at != '' ORDER BY deleted_at DESC"
    );
    const aiItemsOut = deletedAi.map((r) => {
      let extracted = null;
      if (typeof r.extracted_json === "string" && r.extracted_json) {
        try { extracted = JSON.parse(r.extracted_json); } catch {}
      }
      const existingPaths = getItemImagePaths(r as any).filter((p) => fs.existsSync(p));
      const delMs = Date.parse(String(r.deleted_at || nowIso)) || nowMs;
      const expStr = String(r.recycle_expires_at || new Date(delMs + RETENTION_DAYS_MS).toISOString());
      const expMs = Date.parse(expStr) || delMs + RETENTION_DAYS_MS;
      return {
        id: Number(r.id),
        has_image: existingPaths.length > 0,
        image_count: existingPaths.length,
        is_shelf_set: Boolean(r.is_shelf_set),
        processing_status: String(r.processing_status || "pending"),
        extracted,
        deleted_at: String(r.deleted_at || nowIso),
        recycle_expires_at: expStr,
        days_remaining: Math.max(0, Math.ceil((expMs - nowMs) / 86_400_000)),
        created_at: String(r.created_at || nowIso),
      };
    });

    res.json({ books: booksOut, aiItems: aiItemsOut, retentionDays: 30 });
  });

  app.post("/api/recycle-bin/books/:barcode/restore", requireAdmin, (req, res) => {
    const barcode = String(req.params.barcode || "").trim();
    const existing = db.get<{ sync_id: string | null; cabinet_id: number | null; deleted_at: string | null }>(
      "SELECT sync_id, cabinet_id, deleted_at FROM books WHERE barcode = ?",
      barcode
    );
    if (!existing || !existing.deleted_at) {
      return res.status(404).json({ error: t("errors.bookNotFound") });
    }
    const nowIso = new Date().toISOString();
    const syncId = existing.sync_id || newSyncId();
    const cabActive =
      existing.cabinet_id != null
        ? db.get<{ id: number }>("SELECT id FROM cabinets WHERE id = ? AND deleted_at IS NULL", existing.cabinet_id)?.id ?? null
        : null;
    db.transaction(() => {
      db.run(
        "UPDATE books SET deleted_at = NULL, updated_at = ?, sync_id = ?, cabinet_id = ?, shelf_number = CASE WHEN ? IS NULL THEN NULL ELSE shelf_number END WHERE barcode = ?",
        nowIso,
        syncId,
        cabActive,
        cabActive,
        barcode
      );
      db.run("UPDATE book_images SET deleted_at = NULL WHERE book_barcode = ?", barcode);
      enqueueSyncOutbox(db, "book", syncId, "upsert", { barcode });
    });
    onSyncTrigger?.();
    res.json({ ok: true, barcode });
  });

  app.post("/api/recycle-bin/ai-queue/:id/restore", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const existing = db.get<{ id: number; processing_status: string; extracted_json: string; deleted_at: string | null }>(
      "SELECT id, processing_status, extracted_json, deleted_at FROM ai_catalog_queue WHERE id = ?",
      id
    );
    if (!existing || !existing.deleted_at) {
      return res.status(404).json({ error: t("errors.aiQueueItemNotFound") });
    }
    const restoredProcStatus =
      existing.processing_status === "processing"
        ? existing.extracted_json && existing.extracted_json.trim().length > 2
          ? "done"
          : "pending"
        : existing.processing_status || "pending";
    db.run(
      "UPDATE ai_catalog_queue SET approval_status = 'pending', processing_status = ?, processing_started_at = NULL, deleted_at = NULL, recycle_expires_at = NULL WHERE id = ?",
      restoredProcStatus,
      id
    );
    if (restoredProcStatus === "pending") {
      void processPendingQueue();
    }
    res.json({ ok: true, id });
  });

  app.delete("/api/recycle-bin/books/:barcode", requireAdmin, (req, res) => {
    const barcode = String(req.params.barcode || "").trim();
    const imgs = db.all<{ file_path: string }>("SELECT file_path FROM book_images WHERE book_barcode = ?", barcode);
    db.transaction(() => {
      db.run("DELETE FROM book_images WHERE book_barcode = ?", barcode);
      db.run("DELETE FROM books WHERE barcode = ? AND deleted_at IS NOT NULL", barcode);
    });
    for (const im of imgs) safeUnlinkIfOrphaned(db, im.file_path);
    res.json({ ok: true });
  });

  app.delete("/api/recycle-bin/ai-queue/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const row = db.get<{ image_path: string; extra_images_json: string }>(
      "SELECT image_path, extra_images_json FROM ai_catalog_queue WHERE id = ? AND deleted_at IS NOT NULL",
      id
    );
    const paths = row ? getItemImagePaths(row) : [];
    db.run("DELETE FROM ai_catalog_queue WHERE id = ? AND deleted_at IS NOT NULL", id);
    for (const p of paths) safeUnlinkIfOrphaned(db, p);
    res.json({ ok: true });
  });

  app.post("/api/recycle-bin/empty", requireAdmin, (_req, res) => {
    const deletedBooks = db.all<{ barcode: string }>("SELECT barcode FROM books WHERE deleted_at IS NOT NULL");
    const deletedAi = db.all<{ id: number; image_path: string; extra_images_json: string }>(
      "SELECT id, image_path, extra_images_json FROM ai_catalog_queue WHERE deleted_at IS NOT NULL"
    );
    const candidatePaths: string[] = [];
    db.transaction(() => {
      for (const b of deletedBooks) {
        const imgs = db.all<{ file_path: string }>("SELECT file_path FROM book_images WHERE book_barcode = ?", b.barcode);
        for (const im of imgs) candidatePaths.push(im.file_path);
        db.run("DELETE FROM book_images WHERE book_barcode = ?", b.barcode);
        db.run("DELETE FROM books WHERE barcode = ?", b.barcode);
      }
      for (const q of deletedAi) {
        for (const p of getItemImagePaths(q)) candidatePaths.push(p);
        db.run("DELETE FROM ai_catalog_queue WHERE id = ?", q.id);
      }
    });
    for (const p of candidatePaths) safeUnlinkIfOrphaned(db, p);
    res.json({ ok: true, deletedBooks: deletedBooks.length, deletedAiItems: deletedAi.length });
  });

  return {
    triggerQueueProcessing: () => {
      void processPendingQueue();
    },
  };
}
