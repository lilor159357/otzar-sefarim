import fs from "fs";
import path from "path";

export interface MigrationReport {
  migrated: boolean;
  sourceDir: string | null;
  targetDir: string;
  filesCopied: number;
}

function copyDirRecursiveSafe(src: string, dst: string): number {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursiveSafe(srcPath, dstPath);
    } else if (entry.isFile() && !fs.existsSync(dstPath)) {
      fs.copyFileSync(srcPath, dstPath);
      count++;
    }
  }
  return count;
}

export function migrateLegacyDataIfNeeded(
  targetDataDir: string,
  extraCandidateDirs: string[] = []
): MigrationReport {
  fs.mkdirSync(targetDataDir, { recursive: true });
  const markerPath = path.join(targetDataDir, ".migrated-from-legacy.json");
  const targetDbPath = path.join(targetDataDir, "otzar.db");

  if (fs.existsSync(targetDbPath)) {
    let sourceDir: string | null = null;
    if (fs.existsSync(markerPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
        sourceDir = parsed?.sourceDir || null;
      } catch {}
    }
    return { migrated: false, sourceDir, targetDir: targetDataDir, filesCopied: 0 };
  }

  if (fs.existsSync(markerPath)) {
    return { migrated: false, sourceDir: null, targetDir: targetDataDir, filesCopied: 0 };
  }

  const candidates = Array.from(
    new Set(
      [
        process.env.OTZAR_LEGACY_DATA_DIR || "",
        ...extraCandidateDirs,
        "C:\\OtzarSefarim\\data",
      ]
        .map((p) => p.trim())
        .filter(Boolean)
    )
  ).filter((p) => path.resolve(p).toLowerCase() !== path.resolve(targetDataDir).toLowerCase());

  for (const srcDir of candidates) {
    const srcDb = path.join(srcDir, "otzar.db");
    if (!fs.existsSync(srcDb)) continue;

    let filesCopied = 0;
    // Copy main SQLite files (copy-only, never delete legacy source)
    for (const dbFile of ["otzar.db", "otzar.db-wal", "otzar.db-shm"]) {
      const s = path.join(srcDir, dbFile);
      const d = path.join(targetDataDir, dbFile);
      if (fs.existsSync(s) && !fs.existsSync(d)) {
        fs.copyFileSync(s, d);
        filesCopied++;
      }
    }

    // Copy ai_images and backups if present
    filesCopied += copyDirRecursiveSafe(path.join(srcDir, "ai_images"), path.join(targetDataDir, "ai_images"));
    filesCopied += copyDirRecursiveSafe(path.join(srcDir, "backups"), path.join(targetDataDir, "backups"));

    fs.writeFileSync(
      markerPath,
      JSON.stringify(
        {
          migratedAt: new Date().toISOString(),
          sourceDir: srcDir,
          targetDir: targetDataDir,
          filesCopied,
          note: "One-time copy-only migration; original source directory left untouched.",
        },
        null,
        2
      ),
      "utf8"
    );

    return { migrated: true, sourceDir: srcDir, targetDir: targetDataDir, filesCopied };
  }

  return { migrated: false, sourceDir: null, targetDir: targetDataDir, filesCopied: 0 };
}
