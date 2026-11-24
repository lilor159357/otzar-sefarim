import type { Express } from "express";
import fs from "fs";
import path from "path";
import type { DbClient } from "../db/adapter.ts";
import { requireAdmin } from "../auth/adminAuth.ts";
import { buildNormalizedBookSearch, enqueueSyncOutbox, newSyncId } from "../db/schema.ts";
import {
  analyzeBookCoverImage,
  analyzeShelfSetImages,
  buildBookEmbeddingText,
  float32ToBlob,
  formatGeminiError,
  generateTextEmbedding,
  getAiConfig,
  getAiKeyPoolPublicStatus,
  saveAiKeyPool,
  testGeminiConnection,
  testSinglePoolKey,
  type ExistingSetContext,
  type ExtractedBookMetadata,
  type ExtractedShelfSet,
} from "../ai/geminiService.ts";
import { findAuthorityMatch } from "../search/torahAuthority.ts";

let isQueueWorkerRunning = false;

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

function parseSpineVolumes(raw: unknown): Array<{ volume: string; copiesCount: number; notes?: string }> {
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

function lookupExistingSetContext(db: DbClient, setName: string): ExistingSetContext | undefined {
  const clean = String(setName || "").trim();
  if (!clean) return undefined;
  const row = db.get<{
    set_name: string;
    author: string;
    publisher: string;
    pub_year: string;
    edition: string;
    category: string;
    tags: string;
  }>(
    "SELECT set_name, author, publisher, pub_year, edition, category, tags FROM books WHERE set_name = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
    clean
  );
  if (!row) return undefined;
  return {
    set_name: String(row.set_name || clean).trim(),
    author: String(row.author || "").trim(),
    publisher: String(row.publisher || "").trim(),
    pub_year: String(row.pub_year || "").trim(),
    edition: String(row.edition || "").trim(),
    category: String(row.category || "").trim(),
    tags: parseTags(row.tags),
  };
}

export function registerCatalogAiRoutes(app: Express, db: DbClient, dataDir: string, onSyncTrigger?: () => void) {
  const aiImagesDir = path.join(dataDir, "ai_images");
  fs.mkdirSync(aiImagesDir, { recursive: true });

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
        }>(
          "SELECT id, image_path, extra_images_json, is_shelf_set, extracted_json FROM ai_catalog_queue WHERE processing_status = 'pending' AND approval_status = 'pending' ORDER BY id ASC LIMIT 1"
        );
        if (!nextItem) break;

        db.run(
          "UPDATE ai_catalog_queue SET processing_status = 'processing', error_message = NULL WHERE id = ?",
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
              existingSetCtx
            );
            if (presetSetName) {
              setExtracted.set_name = presetSetName;
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

            db.run(
              "UPDATE ai_catalog_queue SET processing_status = 'done', extracted_json = ?, spine_extracted_json = ?, error_message = NULL WHERE id = ?",
              JSON.stringify(setExtracted),
              JSON.stringify(setExtracted.volumes || []),
              nextItem.id
            );
          } else {
            const imageBuffers = paths.map((p) => ({
              buffer: fs.readFileSync(p),
              mimeType: detectMimeFromExt(p),
            }));
            const extracted: ExtractedBookMetadata = await analyzeBookCoverImage(db, imageBuffers);
            if (presetSetName) {
              extracted.set_name = presetSetName;
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

            db.run(
              "UPDATE ai_catalog_queue SET processing_status = 'done', extracted_json = ?, error_message = NULL WHERE id = ?",
              JSON.stringify(extracted),
              nextItem.id
            );
          }
        } catch (err) {
          db.run(
            "UPDATE ai_catalog_queue SET processing_status = 'error', error_message = ? WHERE id = ?",
            formatGeminiError(err),
            nextItem.id
          );
        }

        const more = db.get<{ c: number }>(
          "SELECT COUNT(*) AS c FROM ai_catalog_queue WHERE processing_status = 'pending' AND approval_status = 'pending'"
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
      return res.status(400).json({ error: "לא הוגדרו מפתחות Gemini API פעילים בהגדרות" });
    }

    const rows = db.all<Record<string, unknown>>(
      forceAll
        ? "SELECT barcode, sync_id, title, set_name, author, volume, publisher, pub_year, edition, category, tags, notes FROM books WHERE deleted_at IS NULL"
        : "SELECT barcode, sync_id, title, set_name, author, volume, publisher, pub_year, edition, category, tags, notes FROM books WHERE deleted_at IS NULL AND embedding IS NULL"
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

  // Cleanup approved/rejected cover images from disk
  app.post("/api/ai/cleanup-images", requireAdmin, (_req, res) => {
    const rows = db.all<{ id: number; image_path: string; extra_images_json: string }>(
      "SELECT id, image_path, extra_images_json FROM ai_catalog_queue WHERE approval_status IN ('approved', 'rejected') AND (image_path != '' OR extra_images_json != '[]')"
    );
    let deletedFiles = 0;
    let freedBytes = 0;
    db.transaction(() => {
      for (const r of rows) {
        for (const p of getItemImagePaths(r)) {
          if (p && fs.existsSync(p)) {
            try {
              const st = fs.statSync(p);
              freedBytes += st.size;
              fs.unlinkSync(p);
              deletedFiles++;
            } catch {}
          }
        }
        db.run("UPDATE ai_catalog_queue SET image_path = '', extra_images_json = '[]' WHERE id = ?", r.id);
      }
    });
    res.json({
      ok: true,
      deletedFiles,
      freedKb: Math.round(freedBytes / 1024),
    });
  });

  // List AI queue items
  app.get("/api/ai-queue", requireAdmin, (req, res) => {
    const approval = typeof req.query.approval === "string" ? req.query.approval : "pending";
    const whereClause = approval === "all" ? "" : "WHERE approval_status = 'pending'";
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
      return res.status(400).json({ error: "לא התקבלו תמונות להעלאה" });
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
      return res.status(400).json({ error: "נדרשת לפחות תמונת שער אחת, או הזנת שם סט קיים להמשך" });
    }
    if (titlePaths.length === 0 && spinePaths.length === 0) {
      return res.status(400).json({ error: "יש לצרף לפחות תמונת שדרות אחת להמשך הסט" });
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
    } = req.body || {};
    if (!batchId) return res.status(400).json({ error: "נדרש מזהה מקבץ batchId" });

    const pendingInBatch = db.all<{ id: number; extracted_json: string }>(
      "SELECT id, extracted_json FROM ai_catalog_queue WHERE set_batch_id = ? AND approval_status = 'pending'",
      batchId
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
      "UPDATE ai_catalog_queue SET processing_status = 'pending', error_message = NULL WHERE processing_status = 'error' AND approval_status = 'pending'"
    );
    void processPendingQueue();
    res.json({ ok: true, requeued: info.changes });
  });

  // Retry failed item
  app.post("/api/ai-queue/:id/retry", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    db.run(
      "UPDATE ai_catalog_queue SET processing_status = 'pending', error_message = NULL WHERE id = ?",
      id
    );
    void processPendingQueue();
    res.json({ ok: true });
  });

  // Approve queue item -> creates book(s) with sequential barcodes + print queue + optional async embedding
  app.post("/api/ai-queue/:id/approve", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const existing = db.get<{ id: number }>("SELECT id FROM ai_catalog_queue WHERE id = ?", id);
    if (!existing) {
      return res.status(404).json({ error: "הפריט לא נמצא בתור" });
    }

    const {
      title,
      set_name = "",
      author = "",
      volume = "",
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

    const prefix = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'barcode_prefix'")?.value ?? "";
    let nextNum =
      parseInt(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'next_barcode'")?.value ?? "100001", 10) ||
      100001;
    const now = new Date().toISOString();
    const tagsArr = parseTags(tags);
    const createdBarcodes: string[] = [];

    const parsedThickness =
      thickness_mm !== null && thickness_mm !== "" && Number(thickness_mm) > 0 ? Number(thickness_mm) : null;
    const parsedPages =
      pages_count !== null && pages_count !== "" && Number(pages_count) > 0 ? Math.round(Number(pages_count)) : null;

    // Batch shelf-set approval
    if (Array.isArray(volumes) && volumes.length > 0) {
      db.transaction(() => {
        for (const volItem of volumes) {
          const vName = String(volItem?.volume || "").trim();
          if (!vName) continue;
          const vCopies = Math.max(1, Math.min(20, Number(volItem.copiesCount) || 1));
          const vTitle = title ? String(title).trim() : set_name ? `${set_name} ${vName}` : vName;
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
              String(author || ""),
              vName,
              String(publisher || ""),
              String(pub_year || ""),
              String(edition || ""),
              String(category || ""),
              tagsArr.join(" "),
              vNotes,
            ]);

            db.run(
              `INSERT INTO books (barcode, title, set_name, author, volume, publisher, pub_year, edition, category, tags, normalized_search, cabinet_id, shelf_number, notes, status, label_printed, created_at, format_size, thickness_mm, pages_count, barcode_status, sync_id, updated_at) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'assigned', ?, ?)`,
              code,
              vTitle,
              String(set_name || "").trim(),
              String(author || "").trim(),
              vName,
              String(publisher || "").trim(),
              String(pub_year || "").trim(),
              String(edition || "").trim(),
              String(category || "").trim(),
              JSON.stringify(tagsArr),
              norm,
              cabinet_id ? Number(cabinet_id) : null,
              shelf_number ? Number(shelf_number) : 1,
              String(vNotes).trim(),
              String(status),
              now,
              String(format_size || "").trim(),
              parsedThickness,
              parsedPages,
              syncId,
              now
            );
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
        return res.status(400).json({ error: "יש להזין שם ספר לפני אישור" });
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
            String(author),
            String(volume),
            String(publisher),
            String(pub_year),
            String(edition),
            String(category),
            tagsArr.join(" "),
            String(notes),
          ]);
          db.run(
            `INSERT INTO books (barcode, title, set_name, author, volume, publisher, pub_year, edition, category, tags, normalized_search, cabinet_id, shelf_number, notes, status, label_printed, created_at, format_size, thickness_mm, pages_count, barcode_status, sync_id, updated_at) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'assigned', ?, ?)`,
            code,
            String(title).trim(),
            String(set_name || "").trim(),
            String(author).trim(),
            String(volume).trim(),
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
    db.run("UPDATE ai_catalog_queue SET approval_status = 'rejected' WHERE id = ?", id);
    res.json({ ok: true });
  });

  app.delete("/api/ai-queue/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const row = db.get<{ image_path: string; extra_images_json: string }>(
      "SELECT image_path, extra_images_json FROM ai_catalog_queue WHERE id = ?",
      id
    );
    if (row) {
      for (const p of getItemImagePaths(row)) {
        if (p && fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
          } catch {}
        }
      }
    }
    db.run("DELETE FROM ai_catalog_queue WHERE id = ?", id);
    res.json({ ok: true });
  });

  return {
    triggerQueueProcessing: () => {
      void processPendingQueue();
    },
  };
}
