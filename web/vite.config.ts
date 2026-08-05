import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3579,
    proxy: {
      // In dev these live in the server process; in prod both share the port.
      "/ws": {
        target: "ws://localhost:3580",
        ws: true
      },
      "/mermaid": {
        target: "http://localhost:3580"
      },
      "/changes": {
        target: "http://localhost:3580"
      },
      "/library": {
        target: "http://localhost:3580"
      }
    }
  },
  optimizeDeps: {
    esbuildOptions: {
      // "Arbitrary module namespace identifier names" used by @excalidraw/excalidraw
      // requires es2022.
      target: "es2022"
    }
  },
  build: {
    target: "es2022"
  }
});
