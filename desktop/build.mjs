import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  // bufferutil / utf-8-validate are optional ws accelerators loaded in a
  // try/catch; leaving them external keeps the bundle resolvable without them.
  external: ["electron", "bufferutil", "utf-8-validate"],
  sourcemap: false
};

await build({
  ...common,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.cjs"
});

await build({
  ...common,
  entryPoints: ["src/bridge.ts"],
  outfile: "dist/bridge.cjs"
});

await build({
  ...common,
  entryPoints: ["src/canvas-hook.ts"],
  outfile: "dist/canvas-hook.cjs"
});
