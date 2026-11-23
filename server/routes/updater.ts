import type { Express } from "express";
import { execFile, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type { DbClient } from "../db/adapter.ts";
import { requireAdmin } from "../auth/adminAuth.ts";

const execFileAsync = promisify(execFile);

export interface UpdaterRestartHooks {
  closeServer?: () => void;
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

async function getRepoInfo(rootDir: string) {
  const gitDirExists = fs.existsSync(path.join(rootDir, ".git"));
  let gitAvailable = false;
  let gitVersion = "";
  try {
    const v = await runGit(rootDir, ["--version"], 5000);
    gitAvailable = true;
    gitVersion = v.stdout;
  } catch {
    gitAvailable = false;
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

export async function checkForUpdates(rootDir: string): Promise<UpdateCheckState> {
  const info = await getRepoInfo(rootDir);
  if (!info.gitAvailable) {
    Object.assign(lastCheckState, {
      checkedAt: new Date().toISOString(),
      hasUpdate: false,
      behindCount: 0,
      aheadCount: 0,
      error: "Git אינו מותקן במחשב",
    });
    return { ...lastCheckState };
  }
  if (!info.repoInitialized) {
    Object.assign(lastCheckState, {
      checkedAt: new Date().toISOString(),
      hasUpdate: false,
      behindCount: 0,
      aheadCount: 0,
      error: "תיקיית הפרויקט עדיין אינה מחוברת ל-Git",
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
      error: "לא הוגדרה כתובת מאגר GitHub (origin)",
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
        error: `הענף ${info.branch} עדיין לא קיים במאגר המרוחק`,
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
      error: friendlyGitError(String(err?.message || "שגיאה בבדיקת עדכונים")),
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

    // 1. Always backup local SQLite database before applying code updates
    const backupsDir = path.join(dataDir, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = path.join(backupsDir, `pre-update-${stamp}.db`);
    db.backupTo(backupPath);

    const lockBefore = fileSha256(path.join(rootDir, "package-lock.json"));
    const pkgBefore = fileSha256(path.join(rootDir, "package.json"));

    // 2. Pull fast-forward from origin
    try {
      await runGit(rootDir, ["pull", "--ff-only", "origin", info.branch], 45000);
    } catch (err: any) {
      throw new Error(friendlyGitError(String(err?.message || "שגיאה בהורדת העדכון")));
    }

    const lockAfter = fileSha256(path.join(rootDir, "package-lock.json"));
    const pkgAfter = fileSha256(path.join(rootDir, "package.json"));

    // 3. Install dependencies if manifest changed
    let ranInstall = false;
    if (lockBefore !== lockAfter || pkgBefore !== pkgAfter) {
      await runNpm(rootDir, ["install"], 240000);
      ranInstall = true;
    }

    // 4. Rebuild frontend & typecheck
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
  hooks: UpdaterRestartHooks
) {
  const runCheck = async () => {
    const autoCheck = getSetting(db, "auto_update_check", "1") !== "0";
    if (!autoCheck) return;
    const info = await getRepoInfo(rootDir);
    if (!info.gitAvailable || !info.repoInitialized || !info.remoteUrl) return;

    const result = await checkForUpdates(rootDir);
    const autoInstall = getSetting(db, "auto_update_install", "0") === "1";
    if (result.hasUpdate && autoInstall && info.dirtyFiles === 0) {
      try {
        console.log("[Updater] Update detected at startup, applying automatically...");
        await applyUpdateAndRestart(db, rootDir, dataDir, hooks, false);
      } catch (err: any) {
        console.error("[Updater] Auto-update failed:", err?.message || err);
      }
    }
  };

  setTimeout(() => {
    void runCheck();
  }, 5000);
}

export function registerUpdaterRoutes(
  app: Express,
  db: DbClient,
  rootDir: string,
  dataDir: string,
  hooks: UpdaterRestartHooks
) {
  app.get("/api/updater/status", requireAdmin, async (_req, res) => {
    const info = await getRepoInfo(rootDir);
    res.json({
      ...info,
      autoCheck: getSetting(db, "auto_update_check", "1") !== "0",
      autoInstall: getSetting(db, "auto_update_install", "0") === "1",
      updateInProgress,
      lastCheck: { ...lastCheckState },
    });
  });

  app.post("/api/updater/config", requireAdmin, async (req, res) => {
    const remoteUrlRaw = typeof req.body?.remoteUrl === "string" ? req.body.remoteUrl.trim() : undefined;
    const autoCheck = req.body?.autoCheck;
    const autoInstall = req.body?.autoInstall;

    try {
      if (remoteUrlRaw !== undefined) {
        if (remoteUrlRaw && !/^(https:\/\/github\.com\/|git@github\.com:).+/i.test(remoteUrlRaw)) {
          return res.status(400).json({ error: "יש להזין כתובת תקינה של מאגר GitHub (למשל https://github.com/user/repo.git)" });
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
        autoCheck: getSetting(db, "auto_update_check", "1") !== "0",
        autoInstall: getSetting(db, "auto_update_install", "0") === "1",
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "שגיאה בשמירת הגדרות עדכון" });
    }
  });

  app.post("/api/updater/check", requireAdmin, async (_req, res) => {
    const check = await checkForUpdates(rootDir);
    const info = await getRepoInfo(rootDir);
    res.json({
      ...info,
      lastCheck: check,
    });
  });

  app.post("/api/updater/apply", requireAdmin, async (_req, res) => {
    try {
      const result = await applyUpdateAndRestart(db, rootDir, dataDir, hooks, false);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "שגיאה בהחלת העדכון" });
    }
  });
}
