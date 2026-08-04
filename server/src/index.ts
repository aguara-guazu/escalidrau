import { startApp } from "./app.js";

try {
  const handle = await startApp();
  console.error(`[escalidrau] canvas: ${handle.canvasUrl}`);
  console.error(`[escalidrau] MCP endpoint: ${handle.mcpUrl}`);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    console.error(
      "[escalidrau] port already in use — another instance (or the desktop app) is running. " +
        "Stop it or set PORT to a free port."
    );
  } else {
    console.error("[escalidrau] failed to start:", error);
  }
  process.exit(1);
}
