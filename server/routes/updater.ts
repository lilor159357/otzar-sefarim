import type { Express } from "express";
import { execFile, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type { DbClient } from "../db/adapter.ts";
import { requireAdmin } from "../auth/adminAuth.ts";
import { fallbackT, type StringsTranslateFn } from "../../shared/strings/engine.ts";
import {
  cleanReleaseNotes,
  clearPendingUpdateNotes,
  filterHighlightsForVersion,
  compareSemver,
  getBuiltinHighlightsForVersion,
  readPendingUpdateNotes,
  savePendingUpdateNotes,
} from "../sync/releaseNotes.ts";

const execFileAsync = promisify(execFile);

export interface UpdaterRestartHooks {
  closeServer?: () => void;
  cancelStartupCheck?: () => void;
}

export interface DesktopUpdaterSnapshot {
  isElectron: boolean;
  isPackaged: boolean;
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  releaseHighlights?: string[];
  checking: boolean;
  downloading: boolean;
  downloadPercent: number;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  downloaded: boolean;
  hasUpdate: boolean;
  checkedAt: string | null;
  error: string | null;
}

export interface DesktopUpdaterBridge {
  getSnapshot: () => DesktopUpdaterSnapshot;
  checkForUpdates: (githubToken?: string) => Promise<DesktopUpdaterSnapshot>;
  downloadAndInstall: (backupBeforeUpdate: () => string, githubToken?: string) => Promise<{
    ok: boolean;
    downloaded: boolean;
    installing: boolean;
    backupPath?: string;
    message?: string;
  }>;
  quitAndInstall: () => void;
}

export interface UpdateCommitInfo {
  hash: string;
  message: string;
  date: string;
}

export interface UpdateCheckState {
  checkedAt: string | null;
  hasUpdate: boolean;
  behindCount: number;
  aheadCount: number;
  localHash: string;
  remoteHash: string;
  latestCommits: UpdateCommitInfo[];
  error: string | null;
}

const lastCheckState: UpdateCheckState = {
  checkedAt: null,
  hasUpdate: false,
  behindCount: 0,
  aheadCount: 0,
  localHash: "",
  remoteHash: "",
  latestCommits: [],
  error: null,
};

let updateInProgress = false;

function resolveGitBin(): string {
  const candidates = [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe") : "",
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "git";
}

async function runGit(rootDir: string, args: string[], timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> {
  const gitBin = resolveGitBin();
  try {
    const res = await execFileAsync(gitBin, args, {
      cwd: rootDir,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout: String(res.stdout || "").trim(), stderr: String(res.stderr || "").trim() };
  } catch (err: any) {
    const rawMsg = String(err?.stderr || err?.message || "").trim();
    if (err?.code === "ENOENT") {
      throw new Error("Git אינו מותקן במחשב זה");
    }
    throw new Error(rawMsg || "שגיאה בהרצת Git");
  }
}

async function runNpm(rootDir: string, args: string[], timeoutMs = 180000): Promise<string> {
  const res = await execFileAsync("cmd.exe", ["/c", "npm", ...args], {
    cwd: rootDir,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return String(res.stdout || "") + "\n" + String(res.stderr || "");
}

function friendlyGitError(msg: string): string {
  const low = msg.toLowerCase();
  if (low.includes("could not resolve host") || low.includes("failed to connect") || low.includes("timed out") || low.includes("unable to access")) {
    return "לא ניתן להתחבר ל-GitHub (בדוק חיבור אינטרנט זמין)";
  }
  if (low.includes("authentication failed") || low.includes("terminal prompts disabled") || low.includes("could not read username")) {
    return "נדרשת התחברות/הרשאה לחשבון ה-GitHub עבור מאגר זה";
  }
  if (low.includes("repository not found") || low.includes("does not appear to be a git repository")) {
    return "מאגר ה-GitHub לא נמצא או שאין גישה אליו";
  }
  if (low.includes("local changes") || low.includes("would be overwritten") || low.includes("not possible to fast-forward")) {
    return "קיימים שינויים מקומיים בקוד המונעים עדכון אוטומטי בטוח";
  }
  return msg;
}

function getPackageVersion(rootDir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    return String(pkg.version || "1.0.0");
  } catch {
    return "1.0.0";
  }
}

function fileSha256(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function getSetting(db: DbClient, key: string, fallback = ""): string {
  return db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value ?? fallback;
}

function setSetting(db: DbClient, key: string, value: string): void {
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value
  );
}

export function createBackupFile(db: DbClient, dataDir: string, prefix = "pre-update"): string {
  const backupsDir = path.join(dataDir, "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = path.join(backupsDir, `${prefix}-${stamp}.db`);
  db.backupTo(backupPath);
  return backupPath;
}

async function getRepoInfo(rootDir: string) {
  const gitDirExists = fs.existsSync(path.join(rootDir, ".git"));
  let gitAvailable = false;
  let gitVersion = "";
  if (!process.versions.electron || gitDirExists) {
    try {
      const v = await runGit(rootDir, ["--version"], 5000);
      gitAvailable = true;
      gitVersion = v.stdout;
    } catch {
      gitAvailable = false;
    }
  }

  let branch = "main";
  let localHash = "";
  let lastCommitMessage = "";
  let lastCommitDate = "";
  let remoteUrl = "";
  let dirtyFiles = 0;

  if (gitAvailable && gitDirExists) {
    try {
      branch = (await runGit(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout || "main";
    } catch {}
    try {
      localHash = (await runGit(rootDir, ["rev-parse", "--short", "HEAD"])).stdout || "";
    } catch {}
    try {
      const logLine = (await runGit(rootDir, ["log", "-1", "--format=%s|||%ci"])).stdout;
      const [msg, dt] = logLine.split("|||");
      lastCommitMessage = msg || "";
      lastCommitDate = dt || "";
    } catch {}
    try {
      remoteUrl = (await runGit(rootDir, ["remote", "get-url", "origin"])).stdout || "";
    } catch {}
    try {
      const st = (await runGit(rootDir, ["status", "--porcelain"])).stdout;
      dirtyFiles = st ? st.split(/\r?\n/).filter(Boolean).length : 0;
    } catch {}
  }

  return {
    version: getPackageVersion(rootDir),
    gitAvailable,
    gitVersion,
    repoInitialized: gitDirExists,
    branch,
    localHash,
    lastCommitMessage,
    lastCommitDate,
    remoteUrl,
    dirtyFiles,
  };
}

export async function checkForUpdates(rootDir: string, t: StringsTranslateFn = fallbackT): Promise<UpdateCheckState> {
  const info = await getRepoInfo(rootDir);
  if (!info.gitAvailable) {
    Object.assign(lastCheckState, {
      checkedAt: new Date().toISOString(),
      hasUpdate: false,
      behindCount: 0,
      aheadCount: 0,
      error: t("errors.gitNotInstalled"),
    });
    return { ...lastCheckState };
  }
  if (!info.repoInitialized) {
    Object.assign(lastCheckState, {
      checkedAt: new Date().toISOString(),
      hasUpdate: false,
      behindCount: 0,
      aheadCount: 0,
      error: t("errors.gitRepoNotConnected"),
    });
    return { ...lastCheckState };
  }
  if (!info.remoteUrl) {
    Object.assign(lastCheckState, {
      checkedAt: new Date().toISOString(),
      hasUpdate: false,
      behindCount: 0,
      aheadCount: 0,
      localHash: info.localHash,
      remoteHash: "",
      latestCommits: [],
      error: t("errors.gitOriginMissing"),
    });
    return { ...lastCheckState };
  }

  try {
    await runGit(rootDir, ["fetch", "origin", info.branch, "--prune"], 25000);
    const remoteRef = `origin/${info.branch}`;
    let remoteHash = "";
    try {
      remoteHash = (await runGit(rootDir, ["rev-parse", "--short", remoteRef])).stdout;
    } catch {
      Object.assign(lastCheckState, {
        checkedAt: new Date().toISOString(),
        hasUpdate: false,
        behindCount: 0,
        aheadCount: 0,
        localHash: info.localHash,
        remoteHash: "",
        latestCommits: [],
        error: t("errors.gitBranchNotOnRemote", { branch: info.branch }),
      });
      return { ...lastCheckState };
    }

    let behindCount = 0;
    let aheadCount = 0;
    if (info.localHash) {
      const counts = (await runGit(rootDir, ["rev-list", "--left-right", "--count", `HEAD...${remoteRef}`])).stdout;
      const [aheadStr, behindStr] = counts.split(/\s+/);
      aheadCount = Number(aheadStr) || 0;
      behindCount = Number(behindStr) || 0;
    } else {
      behindCount = 1;
    }

    let latestCommits: UpdateCommitInfo[] = [];
    if (behindCount > 0) {
      const range = info.localHash ? `HEAD..${remoteRef}` : remoteRef;
      const rawLog = (await runGit(rootDir, ["log", range, "-n", "8", "--format=%h|||%s|||%ci"])).stdout;
      if (rawLog) {
        latestCommits = rawLog.split(/\r?\n/).filter(Boolean).map((line) => {
          const [hash, message, date] = line.split("|||");
          return { hash: hash || "", message: message || "", date: date || "" };
        });
      }
    }

    Object.assign(lastCheckState, {
      checkedAt: new Date().toISOString(),
      hasUpdate: behindCount > 0,
      behindCount,
      aheadCount,
      localHash: info.localHash,
      remoteHash,
      latestCommits,
      error: null,
    });
    return { ...lastCheckState };
  } catch (err: any) {
    Object.assign(lastCheckState, {
      checkedAt: new Date().toISOString(),
      hasUpdate: false,
      behindCount: 0,
      aheadCount: 0,
      localHash: info.localHash,
      error: friendlyGitError(String(err?.message || t("errors.updaterCheckFailed"))),
    });
    return { ...lastCheckState };
  }
}

function triggerDetachedServerRestart(rootDir: string, hooks: UpdaterRestartHooks) {
  setTimeout(() => {
    try {
      hooks.closeServer?.();
    } catch {}
    try {
      const child = spawn(
        "cmd.exe",
        ["/c", "timeout /t 2 /nobreak >nul && start /min \"OtzarSefarimServer\" cmd /c \"npx tsx server/index.ts\""],
        {
          cwd: rootDir,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        }
      );
      child.unref();
    } catch {}
    setTimeout(() => {
      process.exit(0);
    }, 300);
  }, 350);
}

export async function applyUpdateAndRestart(
  db: DbClient,
  rootDir: string,
  dataDir: string,
  hooks: UpdaterRestartHooks,
  skipRestart = false
) {
  if (updateInProgress) {
    throw new Error("תהליך עדכון כבר רץ ברקע");
  }
  updateInProgress = true;
  try {
    const info = await getRepoInfo(rootDir);
    if (!info.gitAvailable || !info.repoInitialized || !info.remoteUrl) {
      throw new Error("חיבור GitHub אינו מוגדר עדיין");
    }

    const backupPath = createBackupFile(db, dataDir, "pre-update");
    const lockBefore = fileSha256(path.join(rootDir, "package-lock.json"));
    const pkgBefore = fileSha256(path.join(rootDir, "package.json"));

    try {
      await runGit(rootDir, ["pull", "--ff-only", "origin", info.branch], 45000);
    } catch (err: any) {
      throw new Error(friendlyGitError(String(err?.message || "שגיאה בהורדת העדכון")));
    }

    const lockAfter = fileSha256(path.join(rootDir, "package-lock.json"));
    const pkgAfter = fileSha256(path.join(rootDir, "package.json"));

    let ranInstall = false;
    if (lockBefore !== lockAfter || pkgBefore !== pkgAfter) {
      await runNpm(rootDir, ["install"], 240000);
      ranInstall = true;
    }

    await runNpm(rootDir, ["run", "build"], 180000);

    const newInfo = await getRepoInfo(rootDir);
    Object.assign(lastCheckState, {
      checkedAt: new Date().toISOString(),
      hasUpdate: false,
      behindCount: 0,
      aheadCount: 0,
      localHash: newInfo.localHash,
      remoteHash: newInfo.localHash,
      latestCommits: [],
      error: null,
    });

    if (!skipRestart) {
      triggerDetachedServerRestart(rootDir, hooks);
    }

    return {
      ok: true,
      updated: true,
      restarting: !skipRestart,
      ranInstall,
      backupPath,
      newVersion: newInfo.version,
      newHash: newInfo.localHash,
    };
  } finally {
    updateInProgress = false;
  }
}

export function scheduleStartupAutoUpdateCheck(
  db: DbClient,
  rootDir: string,
  dataDir: string,
  hooks: UpdaterRestartHooks,
  desktopUpdater?: DesktopUpdaterBridge
) {
  let cancelled = false;
  const runCheck = async () => {
    if (cancelled) return;
    let autoCheck = true;
    try {
      autoCheck = getSetting(db, "auto_update_check", "1") !== "0";
    } catch {
      return;
    }
    if (!autoCheck || cancelled) return;

    if (desktopUpdater) {
      try {
        const token = getSetting(db, "github_release_token", "").trim();
        const snap = await desktopUpdater.checkForUpdates(token);
        const autoInstall = getSetting(db, "auto_update_install", "0") === "1";
        if (snap.hasUpdate && autoInstall && !snap.downloaded) {
          await desktopUpdater.downloadAndInstall(() => createBackupFile(db, dataDir, "pre-update"), token);
        }
      } catch (err: any) {
        console.error("[DesktopUpdater] Auto-download failed:", err?.message || err);
      }
      return;
    }

    const info = await getRepoInfo(rootDir);
    if (cancelled || !info.gitAvailable || !info.repoInitialized || !info.remoteUrl) return;

    const result = await checkForUpdates(rootDir);
    if (cancelled) return;
    let autoInstall = false;
    try {
      autoInstall = getSetting(db, "auto_update_install", "0") === "1";
    } catch {
      return;
    }
    if (result.hasUpdate && autoInstall && info.dirtyFiles === 0) {
      try {
        console.log("[Updater] Update detected at startup, applying automatically...");
        await applyUpdateAndRestart(db, rootDir, dataDir, hooks, false);
      } catch (err: any) {
        console.error("[Updater] Auto-update failed:", err?.message || err);
      }
    }
  };

  const timer = setTimeout(() => {
    void runCheck();
  }, 5000);
  timer.unref?.();
  hooks.cancelStartupCheck = () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

export function registerUpdaterRoutes(
  app: Express,
  db: DbClient,
  rootDir: string,
  dataDir: string,
  hooks: UpdaterRestartHooks,
  desktopUpdater?: DesktopUpdaterBridge,
  appVersionOverride?: string,
  t: StringsTranslateFn = fallbackT
) {
  const resolveCurrentVersion = () =>
    desktopUpdater?.getSnapshot()?.currentVersion || appVersionOverride || getPackageVersion(rootDir);

  const formatDesktopSnapshot = (rawDesktop: DesktopUpdaterSnapshot | null) => {
    if (!rawDesktop) return null;
    const cleaned = cleanReleaseNotes(rawDesktop.releaseNotes, rawDesktop.availableVersion);
    const highlights =
      Array.isArray(rawDesktop.releaseHighlights) && rawDesktop.releaseHighlights.length > 0
        ? rawDesktop.releaseHighlights
        : cleaned.highlights;
    return {
      ...rawDesktop,
      releaseNotes: cleaned.summary || null,
      releaseHighlights: highlights,
    };
  };

  app.get("/api/updater/recent-update", (_req, res) => {
    const currentVersion = resolveCurrentVersion();
    const pending = readPendingUpdateNotes(dataDir);
    const lastSeen = getSetting(db, "last_seen_app_version", "").trim();

    if (pending && compareSemver(currentVersion, pending.targetVersion) >= 0) {
      const filteredPending =
        Array.isArray(pending.highlights) && pending.highlights.length > 0
          ? filterHighlightsForVersion(pending.highlights, currentVersion)
          : [];
      const highlights =
        filteredPending.length > 0
          ? filteredPending
          : getBuiltinHighlightsForVersion(currentVersion);
      return res.json({
        hasRecentUpdate: true,
        version: currentVersion,
        previousVersion: pending.previousVersion || lastSeen || null,
        highlights,
        summary: pending.summary || highlights.join(" · "),
      });
    }

    if (!lastSeen || compareSemver(currentVersion, lastSeen) > 0) {
      const highlights = getBuiltinHighlightsForVersion(currentVersion);
      return res.json({
        hasRecentUpdate: true,
        version: currentVersion,
        previousVersion: lastSeen || null,
        highlights,
        summary: highlights.join(" · "),
      });
    }

    return res.json({ hasRecentUpdate: false, version: currentVersion, highlights: [] });
  });

  app.post("/api/updater/fake-update-modal", (_req, res) => {
    const currentVersion = resolveCurrentVersion();
    const highlights = getBuiltinHighlightsForVersion(currentVersion);
    savePendingUpdateNotes(dataDir, {
      targetVersion: currentVersion,
      previousVersion: "1.0.10",
      summary: highlights.join(" · "),
      highlights,
      savedAt: new Date().toISOString(),
    });
    setSetting(db, "last_seen_app_version", "1.0.10");
    res.json({ ok: true, version: currentVersion, highlights });
  });

  app.post("/api/updater/ack-release-notes", (_req, res) => {
    const currentVersion = resolveCurrentVersion();
    setSetting(db, "last_seen_app_version", currentVersion);
    clearPendingUpdateNotes(dataDir);
    res.json({ ok: true, version: currentVersion });
  });

  app.get("/api/updater/status", requireAdmin, async (_req, res) => {
    const info = await getRepoInfo(rootDir);
    const hasReleaseToken = Boolean(getSetting(db, "github_release_token", "").trim());
    const desktop = formatDesktopSnapshot(desktopUpdater ? desktopUpdater.getSnapshot() : null);
    res.json({
      ...info,
      isElectron: Boolean(desktop?.isElectron),
      desktop,
      hasReleaseToken,
      autoCheck: getSetting(db, "auto_update_check", "1") !== "0",
      autoInstall: getSetting(db, "auto_update_install", "0") === "1",
      updateInProgress: updateInProgress || Boolean(desktop?.downloading),
      lastCheck: desktop
        ? {
            checkedAt: desktop.checkedAt,
            hasUpdate: desktop.hasUpdate,
            behindCount: desktop.hasUpdate ? 1 : 0,
            aheadCount: 0,
            localHash: desktop.currentVersion,
            remoteHash: desktop.availableVersion || desktop.currentVersion,
            latestCommits: desktop.availableVersion
              ? [
                  {
                    hash: "v" + desktop.availableVersion,
                    message: desktop.releaseNotes || `גרסה חדשה v${desktop.availableVersion} מוכנה להורדה`,
                    date: desktop.checkedAt || new Date().toISOString(),
                  },
                ]
              : [],
            error: desktop.error,
          }
        : { ...lastCheckState },
    });
  });

  app.post("/api/updater/config", requireAdmin, async (req, res) => {
    const remoteUrlRaw = typeof req.body?.remoteUrl === "string" ? req.body.remoteUrl.trim() : undefined;
    const autoCheck = req.body?.autoCheck;
    const autoInstall = req.body?.autoInstall;
    const githubReleaseToken = typeof req.body?.githubReleaseToken === "string" ? req.body.githubReleaseToken.trim() : undefined;

    try {
      if (remoteUrlRaw !== undefined && !desktopUpdater) {
        if (remoteUrlRaw && !/^(https:\/\/github\.com\/|git@github\.com:).+/i.test(remoteUrlRaw)) {
          return res.status(400).json({ error: t("errors.updaterRepoUrlInvalid") });
        }
        if (!fs.existsSync(path.join(rootDir, ".git"))) {
          await runGit(rootDir, ["init", "-b", "main"]);
        }
        let existingRemote = "";
        try {
          existingRemote = (await runGit(rootDir, ["remote", "get-url", "origin"])).stdout;
        } catch {}

        if (!remoteUrlRaw) {
          if (existingRemote) {
            await runGit(rootDir, ["remote", "remove", "origin"]);
          }
        } else if (existingRemote) {
          await runGit(rootDir, ["remote", "set-url", "origin", remoteUrlRaw]);
        } else {
          await runGit(rootDir, ["remote", "add", "origin", remoteUrlRaw]);
        }
        setSetting(db, "update_remote_url", remoteUrlRaw);
      }

      if (githubReleaseToken !== undefined && !githubReleaseToken.includes("••••")) {
        setSetting(db, "github_release_token", githubReleaseToken);
      }
      if (typeof autoCheck === "boolean") {
        setSetting(db, "auto_update_check", autoCheck ? "1" : "0");
      }
      if (typeof autoInstall === "boolean") {
        setSetting(db, "auto_update_install", autoInstall ? "1" : "0");
      }

      const info = await getRepoInfo(rootDir);
      res.json({
        ok: true,
        ...info,
        isElectron: Boolean(desktopUpdater),
        desktop: desktopUpdater ? desktopUpdater.getSnapshot() : null,
        hasReleaseToken: Boolean(getSetting(db, "github_release_token", "").trim()),
        autoCheck: getSetting(db, "auto_update_check", "1") !== "0",
        autoInstall: getSetting(db, "auto_update_install", "0") === "1",
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || t("errors.updaterSettingsSaveFailed") });
    }
  });

  app.post("/api/updater/check", requireAdmin, async (_req, res) => {
    if (desktopUpdater) {
      const token = getSetting(db, "github_release_token", "").trim();
      const desktop = formatDesktopSnapshot(await desktopUpdater.checkForUpdates(token))!;
      return res.json({
        isElectron: true,
        desktop,
        lastCheck: {
          checkedAt: desktop.checkedAt,
          hasUpdate: desktop.hasUpdate,
          behindCount: desktop.hasUpdate ? 1 : 0,
          aheadCount: 0,
          localHash: desktop.currentVersion,
          remoteHash: desktop.availableVersion || desktop.currentVersion,
          latestCommits: desktop.availableVersion
            ? [{ hash: "v" + desktop.availableVersion, message: desktop.releaseNotes || "גרסת Desktop חדשה זמינה", date: desktop.checkedAt || "" }]
            : [],
          error: desktop.error,
        },
      });
    }

    const check = await checkForUpdates(rootDir);
    const info = await getRepoInfo(rootDir);
    res.json({
      ...info,
      lastCheck: check,
    });
  });

  app.post("/api/updater/apply", requireAdmin, async (_req, res) => {
    if (desktopUpdater) {
      try {
        const token = getSetting(db, "github_release_token", "").trim();
        const snap = formatDesktopSnapshot(desktopUpdater.getSnapshot());
        const targetVersion = String(snap?.availableVersion || "").trim();
        if (targetVersion) {
          const highlights =
            snap?.releaseHighlights && snap.releaseHighlights.length > 0
              ? snap.releaseHighlights
              : getBuiltinHighlightsForVersion(targetVersion);
          savePendingUpdateNotes(dataDir, {
            targetVersion,
            previousVersion: snap?.currentVersion || resolveCurrentVersion(),
            summary: snap?.releaseNotes || highlights.join(" · "),
            highlights,
            themePreset: getSetting(db, "theme_preset", "default") || "default",
            darkMode: getSetting(db, "theme_mode", "light") === "dark",
            savedAt: new Date().toISOString(),
          });
        }
        const result = await desktopUpdater.downloadAndInstall(() => createBackupFile(db, dataDir, "pre-update"), token);
        return res.json({ ...result, isElectron: true, desktop: desktopUpdater.getSnapshot() });
      } catch (err: any) {
        return res.status(400).json({ error: err?.message || t("errors.updaterDownloadFailed") });
      }
    }

    try {
      const result = await applyUpdateAndRestart(db, rootDir, dataDir, hooks, false);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || t("errors.updaterApplyFailed") });
    }
  });

  app.post("/api/updater/install-now", requireAdmin, (_req, res) => {
    if (!desktopUpdater) {
      return res.status(400).json({ error: t("errors.updaterDesktopOnly") });
    }
    const snap = formatDesktopSnapshot(desktopUpdater.getSnapshot());
    const targetVersion = String(snap?.availableVersion || "").trim();
    const themePreset = getSetting(db, "theme_preset", "default") || "default";
    const darkMode = getSetting(db, "theme_mode", "light") === "dark";
    if (targetVersion) {
      const highlights =
        snap?.releaseHighlights && snap.releaseHighlights.length > 0
          ? snap.releaseHighlights
          : getBuiltinHighlightsForVersion(targetVersion);
      savePendingUpdateNotes(dataDir, {
        targetVersion,
        previousVersion: snap?.currentVersion || resolveCurrentVersion(),
        summary: snap?.releaseNotes || highlights.join(" · "),
        highlights,
        themePreset,
        darkMode,
        savedAt: new Date().toISOString(),
      });
    }
    res.json({ ok: true, installing: true });
    setTimeout(() => {
      desktopUpdater.quitAndInstall();
    }, 220);
  });
}
