import fs from "fs";
import path from "path";
import { build } from "esbuild";

const rootDir = process.cwd();
const outDir = path.join(rootDir, "dist-electron");
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "electron", "main.ts")],
  outfile: path.join(outDir, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  packages: "external",
  external: ["electron", "electron-updater", "node:sqlite", "vite"],
  sourcemap: false,
  logLevel: "info",
});

await build({
  entryPoints: [path.join(rootDir, "electron", "preload.ts")],
  outfile: path.join(outDir, "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: false,
  logLevel: "info",
});

console.log("[build-electron] Built dist-electron/main.cjs and dist-electron/preload.cjs");