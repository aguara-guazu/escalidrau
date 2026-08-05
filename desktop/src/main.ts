import { accessSync, constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BrowserWindow, app, dialog, shell } from "electron";
import { startApp, type AppHandle } from "../../server/src/app.js";
import { rebuildMenu } from "./menu.js";
import { Splash } from "./splash.js";
import { AppState } from "./state.js";
import {
  canSelfInstall,
  cleanupLeftovers,
  compareVersions,
  downloadUpdate,
  fetchLatestRelease,
  fetchReleaseNotes,
  installUpdate,
  releasesPage
} from "./updater.js";

const PORT = Number(process.env.PORT ?? 3580);
const MCP_URL = `http://localhost:${PORT}/mcp`;
const CANVAS_URL = `http://localhost:${PORT}`;
const LIBRARIES_ORIGIN = "https://libraries.excalidraw.com";

// Without this, userData defaults to the package name ("desktop") and lands
// in a generically named directory.
app.setName("Escalidrau");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let appHandle: AppHandle | null = null;
  let quitRequested = false;
  let mainWindow: BrowserWindow | null = null;
  let whatsNew: { version: string; notes: string } | null = null;
  let updateNotice: { version: string; url: string } | null = null;

  const bundlePath = () => process.execPath.split("/Contents/MacOS/")[0];

  const canWriteBundle = () => {
    try {
      accessSync(dirname(bundlePath()), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Updates itself: Squirrel.Mac refuses to update an app that is not
   * code-signed, so the bundle is replaced by hand from the published DMG.
   * Any failure is non-fatal — the app simply starts on the current version.
   */
  const runUpdateFlow = async (splash: Splash): Promise<boolean> => {
    if (!app.isPackaged) {
      return false;
    }
    splash.status("Checking for updates…");
    const release = await fetchLatestRelease();
    if (!release || compareVersions(release.version, app.getVersion()) <= 0) {
      return false;
    }
    // Windows and Linux builds report the new version instead of replacing
    // themselves: that path is not implemented for their package formats.
    if (!canSelfInstall || !release.downloadUrl || !canWriteBundle()) {
      updateNotice = { version: release.version, url: releasesPage };
      return false;
    }
    const controller = new AbortController();
    let skipped = false;
    splash.onSkip = () => {
      skipped = true;
      controller.abort();
    };
    splash.allowSkip();
    splash.status(`Downloading version ${release.version}…`, 0);
    try {
      const dmgPath = await downloadUpdate(
        release.downloadUrl,
        (fraction) => splash.status(`Downloading version ${release.version}…`, fraction),
        controller.signal
      );
      splash.status("Installing the update…");
      await installUpdate(dmgPath, bundlePath(), "app.escalidrau.local");
      splash.status("Restarting…");
      return true;
    } catch (error) {
      if (!skipped) {
        console.error("[updater] update failed:", error);
      }
      return false;
    }
  };

  const isLibraryReturn = (url: string) =>
    url.startsWith(CANVAS_URL) && url.includes("addLibrary");

  // The public libraries catalog redirects back to the canvas URL with the
  // library reference in the hash; deliver that hash to the main window (its
  // hashchange listener performs the import) instead of loading a second
  // canvas in the catalog window.
  const deliverLibrary = (url: string, contents: Electron.WebContents) => {
    const hash = new URL(url).hash;
    if (mainWindow && hash) {
      void mainWindow.webContents.executeJavaScript(
        `window.location.hash = ${JSON.stringify(hash)};`
      );
      mainWindow.focus();
    }
    const child = BrowserWindow.fromWebContents(contents);
    if (child && child !== mainWindow) {
      child.close();
    }
  };

  // The scene only lives in memory; offer to save it before the window goes.
  // Returns false to abort the close.
  const confirmClose = async (window: BrowserWindow): Promise<boolean> => {
    if (!appHandle?.hasContent()) {
      return true;
    }
    const { response } = await dialog.showMessageBox(window, {
      type: "question",
      buttons: ["Save…", "Don't Save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: "Save your canvas before closing?",
      detail: "The canvas only lives in this window; closing without saving discards it."
    });
    if (response === 2) {
      return false;
    }
    if (response === 1) {
      return true;
    }
    try {
      const json = await appHandle.exportScene();
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        defaultPath: join(app.getPath("documents"), "canvas.excalidraw"),
        filters: [{ name: "Canvas scene", extensions: ["excalidraw"] }]
      });
      if (canceled || !filePath) {
        return false;
      }
      await writeFile(filePath, json, "utf8");
      return true;
    } catch (error) {
      dialog.showErrorBox(
        "Could not save the canvas",
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  };

  const createWindow = () => {
    let forceClose = false;
    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      title: "Escalidrau"
    });
    void window.loadURL(`http://localhost:${PORT}`);
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(LIBRARIES_ORIGIN)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: { width: 1100, height: 800 }
        };
      }
      void shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow = window;
    window.on("closed", () => {
      if (mainWindow === window) {
        mainWindow = null;
      }
    });
    window.on("close", (event) => {
      if (forceClose) {
        return;
      }
      event.preventDefault();
      void confirmClose(window).then((shouldClose) => {
        if (!shouldClose) {
          quitRequested = false;
          return;
        }
        forceClose = true;
        // destroy() skips re-emitting "close"; quit() must be deferred out of
        // the aborted quit cycle or Electron swallows it.
        window.destroy();
        if (quitRequested) {
          setImmediate(() => app.quit());
        }
      });
    });
  };

  app.on("web-contents-created", (_event, contents) => {
    // The catalog uses window.open(returnUrl, "_excalidraw") as well as plain
    // navigation; the main window overrides this handler with its own later.
    contents.setWindowOpenHandler(({ url }) => {
      if (isLibraryReturn(url)) {
        deliverLibrary(url, contents);
        return { action: "deny" };
      }
      if (url.startsWith(LIBRARIES_ORIGIN)) {
        return { action: "allow" };
      }
      void shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (contents !== mainWindow?.webContents && isLibraryReturn(url)) {
        event.preventDefault();
        deliverLibrary(url, contents);
      }
    });
    contents.on("will-redirect", (event, url) => {
      if (contents !== mainWindow?.webContents && isLibraryReturn(url)) {
        event.preventDefault();
        deliverLibrary(url, contents);
      }
    });
  });

  app.on("before-quit", () => {
    quitRequested = true;
  });

  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
  });

  void app.whenReady().then(async () => {
    const dataDir = app.getPath("userData");
    mkdirSync(dataDir, { recursive: true });
    const state = new AppState(dataDir);
    await state.load();

    if (app.isPackaged && canSelfInstall) {
      await cleanupLeftovers(bundlePath());
    }

    const splash = new Splash();
    splash.show();
    const updated = await runUpdateFlow(splash);
    if (updated) {
      splash.close();
      app.relaunch();
      app.exit(0);
      return;
    }
    splash.status("Starting the canvas…");

    // Release notes for the version now running, shown once per version.
    if (app.isPackaged && state.lastSeenVersion !== app.getVersion()) {
      const notes = await fetchReleaseNotes(app.getVersion());
      whatsNew = { version: app.getVersion(), notes: notes ?? "" };
    }

    // One-time migration from builds whose userData dir was named "desktop".
    const legacyLibrary = join(dirname(dataDir), "desktop", "library.json");
    const currentLibrary = join(dataDir, "library.json");
    if (!existsSync(currentLibrary) && existsSync(legacyLibrary)) {
      mkdirSync(dataDir, { recursive: true });
      copyFileSync(legacyLibrary, currentLibrary);
    }
    const webDist = app.isPackaged
      ? join(process.resourcesPath, "web")
      : join(app.getAppPath(), "..", "web", "dist");
    try {
      appHandle = await startApp({
        port: PORT,
        webDist,
        dataDir,
        updateNotice: { get: () => updateNotice },
        whatsNew: {
          get: () => whatsNew,
          markSeen: () => {
            whatsNew = null;
            void state.setLastSeenVersion(app.getVersion());
          }
        }
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      dialog.showErrorBox(
        "Escalidrau",
        code === "EADDRINUSE"
          ? `Port ${PORT} is already in use. Close the other Escalidrau instance (or the headless server) and reopen the app.`
          : `Failed to start the embedded server: ${String(error)}`
      );
      splash.close();
      app.quit();
      return;
    }
    await rebuildMenu(MCP_URL);
    createWindow();
    mainWindow?.once("ready-to-show", () => splash.close());
    // Safety net in case the window never signals readiness.
    setTimeout(() => splash.close(), 8000);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
    // Refresh client statuses when the user comes back to the app (they may
    // have installed a client or edited configs meanwhile).
    app.on("browser-window-focus", () => void rebuildMenu(MCP_URL));
  });

  // On macOS the app (and the MCP endpoint) stays alive with all windows
  // closed; without a window there is no canvas, so tools will ask to reopen.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
