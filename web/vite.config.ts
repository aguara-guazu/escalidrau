import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3579,
    proxy: {
      // In dev the WS bridge lives in the server process; in prod both share the port.
      "/ws": {
        target: "ws://localhost:3580",
        ws: true
      }
    }
  },
  optimizeDeps: {
    esbuildOptions: {
      // "Arbitrary module namespace identifier names" used by @excalidraw/excalidraw
      // requires es2022 (see excalidraw examples/with-script-in-browser).
      target: "es2022"
    }
  },
  build: {
    target: "es2022"
  }
});
