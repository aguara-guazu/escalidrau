import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow, app, dialog, shell } from "electron";
import { startApp, type AppHandle } from "../../server/src/app.js";
import { rebuildMenu } from "./menu.js";

const PORT = Number(process.env.PORT ?? 3580);
const MCP_URL = `http://localhost:${PORT}/mcp`;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let appHandle: AppHandle | null = null;
  let quitRequested = false;

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
      void shell.openExternal(url);
      return { action: "deny" };
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
    const webDist = app.isPackaged
      ? join(process.resourcesPath, "web")
      : join(app.getAppPath(), "..", "web", "dist");
    try {
      appHandle = await startApp({ port: PORT, webDist });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      dialog.showErrorBox(
        "Escalidrau",
        code === "EADDRINUSE"
          ? `Port ${PORT} is already in use. Close the other Escalidrau instance (or the headless server) and reopen the app.`
          : `Failed to start the embedded server: ${String(error)}`
      );
      app.quit();
      return;
    }
    await rebuildMenu(MCP_URL);
    createWindow();
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
