import { join } from "node:path";
import { BrowserWindow, app, dialog, shell } from "electron";
import { startApp } from "../../server/src/app.js";
import { rebuildMenu } from "./menu.js";

const PORT = Number(process.env.PORT ?? 3580);
const MCP_URL = `http://localhost:${PORT}/mcp`;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  const createWindow = () => {
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
  };

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
      await startApp({ port: PORT, webDist });
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
