import { app, BrowserWindow, Menu, shell } from "electron";
import { autoUpdater } from "electron-updater";
import fs from "fs";
import path from "path";
import { migrateLegacyDataIfNeeded } from "./dataMigration.ts";
import { loadWindowsRootCertificates } from "./windowsCerts.ts";
import { startOtzarServer, type StartedOtzarServer } from "../server/index.ts";
import type { DesktopUpdaterBridge, DesktopUpdaterSnapshot } from "../server/routes/updater.ts";

let mainWindow: BrowserWindow | null = null;
let serverHandle: StartedOtzarServer | null = null;

function createDesktopUpdaterBridge(): DesktopUpdaterBridge {
  const snapshot: DesktopUpdaterSnapshot = {
    isElectron: true,
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    availableVersion: null,
    releaseNotes: null,
    checking: false,
    downloading: false,
    downloadPercent: 0,
    transferredBytes: 0,
    totalBytes: 0,
    bytesPerSecond: 0,
    downloaded: false,
    hasUpdate: false,
    checkedAt: null,
    error: null,
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("checking-for-update", () => {
    snapshot.checking = true;
    snapshot.error = null;
  });

  autoUpdater.on("update-available", (info) => {
    snapshot.checking = false;
    snapshot.hasUpdate = true;
    snapshot.availableVersion = String(info?.version || "");
    snapshot.releaseNotes = typeof info?.releaseNotes === "string" ? info.releaseNotes : null;
    snapshot.checkedAt = new Date().toISOString();
    snapshot.error = null;
  });

  autoUpdater.on("update-not-available", () => {
    snapshot.checking = false;
    snapshot.hasUpdate = false;
    snapshot.availableVersion = null;
    snapshot.checkedAt = new Date().toISOString();
    snapshot.error = null;
  });

  autoUpdater.on("download-progress", (p) => {
    snapshot.downloading = true;
    snapshot.downloadPercent = Math.round(p?.percent || 0);
    snapshot.transferredBytes = Number(p?.transferred || 0);
    snapshot.totalBytes = Number(p?.total || 0);
    snapshot.bytesPerSecond = Number(p?.bytesPerSecond || 0);
  });

  autoUpdater.on("update-downloaded", (info) => {
    snapshot.downloading = false;
    snapshot.downloadPercent = 100;
    if (snapshot.totalBytes > 0) snapshot.transferredBytes = snapshot.totalBytes;
    snapshot.bytesPerSecond = 0;
    snapshot.downloaded = true;
    snapshot.hasUpdate = true;
    snapshot.availableVersion = String(info?.version || snapshot.availableVersion || "");
    snapshot.error = null;
  });

  function formatUpdaterError(err: unknown): string {
    const raw = String((err as any)?.message || err || "שגיאה בבדיקת עדכון");
    if (raw.includes("404") || raw.includes("No published versions")) {
      return "לא נמצאה גישה לעדכונים ב-GitHub (404) — אם המאגר פרטי, הזן טוקן קריאה (ghp_...) למעלה או הפוך את המאגר לציבורי.";
    }
    if (raw.includes("401") || raw.includes("403")) {
      return "המאגר פרטי (401/403) — הזן טוקן קריאה (ghp_...) בהגדרות העדכון או הפוך את המאגר לציבורי.";
    }
    const compact = raw.split(/\s*Headers:\s*\{/)[0].trim();
    return (compact || "שגיאה בבדיקת עדכונים מול GitHub").slice(0, 260);
  }

  autoUpdater.on("error", (err) => {
    snapshot.checking = false;
    snapshot.downloading = false;
    snapshot.bytesPerSecond = 0;
    snapshot.error = formatUpdaterError(err);
  });

  function applyFeedConfig(token?: string) {
    if (token && token.trim()) {
      process.env.GH_TOKEN = token.trim();
      autoUpdater.setFeedURL({
        provider: "github",
        owner: "lilor159357",
        repo: "otzar-sefarim",
        private: true,
        token: token.trim(),
      });
    } else {
      delete process.env.GH_TOKEN;
      autoUpdater.setFeedURL({
        provider: "github",
        owner: "lilor159357",
        repo: "otzar-sefarim",
      });
    }
  }

  return {
    getSnapshot: () => ({ ...snapshot }),
    async checkForUpdates(token?: string) {
      snapshot.checkedAt = new Date().toISOString();
      if (!app.isPackaged) {
        snapshot.error = "במצב הרצה מתוך קוד המקור (לפני בניית Setup.exe), העדכון האוטומטי פעיל לאחר התקנת הקובץ המוכן.";
        return { ...snapshot };
      }
      snapshot.checking = true;
      snapshot.error = null;
      try {
        applyFeedConfig(token);
        await autoUpdater.checkForUpdates();
      } catch (err: any) {
        snapshot.error = formatUpdaterError(err);
      } finally {
        snapshot.checking = false;
      }
      return { ...snapshot };
    },
    async downloadAndInstall(backupBeforeUpdate: () => string, token?: string) {
      if (!app.isPackaged) {
        throw new Error("הורדת Setup אוטומטית פעילה בגרסה המותקנת (Setup.exe)");
      }
      const backupPath = backupBeforeUpdate();
      if (snapshot.downloaded) {
        return { ok: true, downloaded: true, installing: true, backupPath, message: "העדכון כבר ירד ומוכן להתקנה" };
      }
      applyFeedConfig(token);
      snapshot.downloading = true;
      snapshot.downloadPercent = 0;
      snapshot.transferredBytes = 0;
      snapshot.totalBytes = 0;
      snapshot.bytesPerSecond = 0;
      if (!snapshot.hasUpdate) {
        await autoUpdater.checkForUpdates();
      }
      if (!snapshot.hasUpdate) {
        snapshot.downloading = false;
        return { ok: true, downloaded: false, installing: false, backupPath, message: "התוכנה כבר בגרסה העדכנית ביותר" };
      }
      await autoUpdater.downloadUpdate();
      return {
        ok: true,
        downloaded: true,
        installing: false,
        backupPath,
        message: "הגרסה החדשה ירדה ומוכנה להתקנה.",
      };
    },
    quitAndInstall() {
      autoUpdater.quitAndInstall(false, true);
    },
  };
}

function resolveAppIconPath(appRoot: string): string | undefined {
  const candidates = [
    path.join(appRoot, "build", "icon.ico"),
    path.join(appRoot, "build", "icon.png"),
    path.join(process.resourcesPath || "", "icon.ico"),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

async function createMainWindow(url: string, appRoot: string) {
  Menu.setApplicationMenu(null);

  const iconPath = resolveAppIconPath(appRoot);
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: "אוצר ספרים - ניהול ספרייה תורנית",
    icon: iconPath,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Allow local PDF/blob preview windows, send external https links to default browser
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith("blob:") || targetUrl.startsWith("http://127.0.0.1:")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 1000,
          height: 780,
          autoHideMenuBar: true,
          title: "תצוגה מקדימה להדפסה",
          icon: iconPath,
        },
      };
    }
    if (targetUrl.startsWith("https://") || targetUrl.startsWith("http://")) {
      void shell.openExternal(targetUrl);
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(url);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const appRoot = app.getAppPath();
      const targetDataDir = path.join(app.getPath("appData"), "OtzarSefarim", "data");

      // 1. One-time safe copy-only migration from C:\OtzarSefarim\data -> %AppData%\OtzarSefarim\data
      const extraLegacyCandidates = app.isPackaged ? [] : [path.join(path.resolve(__dirname, ".."), "data")];
      const migration = migrateLegacyDataIfNeeded(targetDataDir, extraLegacyCandidates);

      // 2. Load Windows Root CAs (Etrog / Rimon / Hadran SSL support)
      const certSummary = loadWindowsRootCertificates(targetDataDir);
      console.log(
        `[OtzarDesktop] Data dir: ${targetDataDir} | Migration: ${migration.migrated ? migration.sourceDir : "skipped"} | Certs: ${certSummary.loadedCount} (${certSummary.mode})`
      );

      // 3. Start local Express + node:sqlite backend in-process
      const desktopUpdater = createDesktopUpdaterBridge();
      serverHandle = await startOtzarServer({
        rootDir: appRoot,
        dataDir: targetDataDir,
        preferredPort: Number(process.env.PORT || 4747),
        isElectron: true,
        appVersion: app.getVersion(),
        migratedFrom: migration.sourceDir,
        certSummary,
        desktopUpdater,
      });

      // 4. Open normal desktop window
      await createMainWindow(serverHandle.url, appRoot);
    } catch (err) {
      console.error("[OtzarDesktop] Fatal startup error:", err);
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("will-quit", () => {
    try {
      serverHandle?.close();
    } catch {}
  });
}
