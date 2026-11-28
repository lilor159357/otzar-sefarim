import fs from "fs";
import path from "path";

const rootDir = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const rawTag = String(process.env.GITHUB_REF_NAME || pkg.version || "").trim();
const ver = rawTag.replace(/^v/i, "").trim();

const releaseDir = path.join(rootDir, "release");
fs.mkdirSync(releaseDir, { recursive: true });
const outFile = path.join(releaseDir, "CURRENT_RELEASE_NOTES.md");

let body = "";

// 1. Try RELEASE_NOTES.md matching ## מה חדש בגרסה <ver>
const mdPath = path.join(rootDir, "RELEASE_NOTES.md");
if (fs.existsSync(mdPath) && ver) {
  const lines = fs.readFileSync(mdPath, "utf8").split(/\r?\n/);
  const headingRegex = /^#{1,6}\s+(?:מה חדש בגרסה|גרסה|version)\s+v?(\d+\.\d+\.\d+)/i;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(headingRegex);
    if (!m) continue;
    if (start === -1 && m[1] === ver) {
      start = i;
    } else if (start !== -1) {
      end = i;
      break;
    }
  }
  if (start !== -1) {
    body = lines.slice(start, end).join("\n").trim() + "\n";
  }
}

// 2. Fallback: extract from VERSION_HIGHLIGHTS_FALLBACK in server/sync/releaseNotes.ts
if (!body && ver) {
  try {
    const mod = await import("../server/sync/releaseNotes.ts");
    const list = mod.getExactHighlightsForVersion?.(ver);
    if (Array.isArray(list) && list.length > 0) {
      body = `## מה חדש בגרסה ${ver}\n` + list.map((item) => `- ${item}`).join("\n") + "\n";
    }
  } catch (err) {
    console.warn("[extract-release-notes] fallback import skipped:", err?.message || err);
  }
}

// 3. Minimal header so softprops/action-gh-release + generate_release_notes stays scoped to this version
if (!body) {
  body = ver ? `## מה חדש בגרסה ${ver}\n` : "";
}

fs.writeFileSync(outFile, body, "utf8");
console.log(`[extract-release-notes] Wrote ${outFile} for version ${ver || "(unknown)"} (${body.length} bytes)`);
