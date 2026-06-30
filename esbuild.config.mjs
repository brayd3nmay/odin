import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

// Runtime shims injected at the top of the bundle to bridge Electron's renderer (Chromium
// globals) and Node-targeted agent SDKs:
//  1. import.meta.url: the SDK uses createRequire(import.meta.url) at module top level. Bundled
//     to CJS, esbuild turns `import.meta` into `{}`, so that becomes createRequire(undefined)
//     which throws at load. Define import.meta.url as the bundle's own file URL.
//  2. events.setMaxListeners: the SDK calls Node's events.setMaxListeners(n, abortSignal), but in
//     the renderer `new AbortController()` is Chromium's web signal, which Node's events module
//     rejects ("eventTargets argument must be an instance of EventEmitter or EventTarget").
//     That call only raises a listener cap to suppress a warning, so tolerate the mismatch.
const rendererShims = [
  "const import_meta_url = require('url').pathToFileURL(__filename).href;",
  "try {",
  "  const _ev = require('events');",
  "  const _sml = _ev.setMaxListeners;",
  "  _ev.setMaxListeners = function (n, ...t) { try { return _sml.call(this, n, ...t); } catch (e) {} };",
  "} catch (e) {}",
].join("\n");

// Obsidian's plugin require resolves bare builtin names; rewrite `node:os` -> `os` so the
// SDK's node:-prefixed imports stay external and resolvable.
const stripNodePrefix = {
  name: "strip-node-prefix",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path.slice("node:".length),
      external: true,
    }));
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2020",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  banner: { js: rendererShims },
  define: { "import.meta.url": "import_meta_url" },
  plugins: [stripNodePrefix],
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  logLevel: "info",
});

if (production) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
