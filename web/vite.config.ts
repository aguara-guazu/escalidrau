import { readFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vite";
import type { Plugin as EsbuildPlugin } from "esbuild";
import react from "@vitejs/plugin-react";

// Excalidraw renders library thumbnails with `files: null`, so a library item
// made of image elements (the bundled AWS icons) shows up blank in the library
// panel. Point that single call at the live files map that src/bundledIcons.ts
// exposes. The pattern must match exactly once; after an Excalidraw upgrade a
// mismatch fails the build instead of silently losing the thumbnails.
const EXCALIDRAW_ENTRY = /@excalidraw[\\/]excalidraw[\\/]dist[\\/](?:dev|prod)[\\/]index\.js$/;
const THUMBNAIL_FILES = /files:\s*null,(\s*)renderEmbeddables:\s*(!1|false)/g;

const patchLibraryThumbnails = (code: string, id: string): string | null => {
  if (!EXCALIDRAW_ENTRY.test(id)) {
    return null;
  }
  const matches = code.match(THUMBNAIL_FILES) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `Expected one library thumbnail renderer in ${id}, found ${matches.length}`
    );
  }
  return code.replace(
    THUMBNAIL_FILES,
    "files:globalThis.__escalidrauLibraryFiles??null,$1renderEmbeddables:$2"
  );
};

const libraryThumbnails = (): Plugin => ({
  name: "excalidraw-library-thumbnails",
  transform(code, id) {
    const patched = patchLibraryThumbnails(code, id);
    return patched === null ? null : { code: patched, map: null };
  }
});

// The dev server pre-bundles dependencies with esbuild, which bypasses Rollup
// transform hooks; the same patch is applied there.
const libraryThumbnailsEsbuild: EsbuildPlugin = {
  name: "excalidraw-library-thumbnails",
  setup(build) {
    build.onLoad({ filter: EXCALIDRAW_ENTRY }, async (args) => {
      const patched = patchLibraryThumbnails(await readFile(args.path, "utf8"), args.path);
      return patched === null ? undefined : { contents: patched, loader: "js" };
    });
  }
};

export default defineConfig({
  plugins: [react(), libraryThumbnails()],
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
      },
      "/whatsnew": {
        target: "http://localhost:3580"
      },
      "/settings": {
        target: "http://localhost:3580"
      }
    }
  },
  optimizeDeps: {
    esbuildOptions: {
      // "Arbitrary module namespace identifier names" used by @excalidraw/excalidraw
      // requires es2022.
      target: "es2022",
      plugins: [libraryThumbnailsEsbuild]
    }
  },
  build: {
    target: "es2022"
  }
});
