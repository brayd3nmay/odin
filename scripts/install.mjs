// Copy the built plugin (main.js, manifest.json, styles.css) into your Obsidian vault's plugin
// folder so you can reload + test. Leaves data.json (settings + chat threads) alone.
//
// Destination resolution, in order:
//   1. ODIN_INSTALL_DIR env var
//   2. a .install-path file at the repo root (gitignored — so your vault path never lands in git)
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ -> repo root

let dest = process.env.ODIN_INSTALL_DIR;
const cfg = join(root, ".install-path");
if (!dest && existsSync(cfg)) dest = readFileSync(cfg, "utf8").trim();
if (!dest) {
  console.error(
    "[install] No destination. Set ODIN_INSTALL_DIR, or write your vault plugin dir to .install-path:\n" +
      '  echo "/path/to/Your Vault/.obsidian/plugins/odin" > .install-path',
  );
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
const files = ["main.js", "manifest.json", "styles.css"];
for (const f of files) {
  const src = join(root, f);
  if (!existsSync(src)) {
    console.error(`[install] missing ${f} — run the build first (npm run build)`);
    process.exit(1);
  }
  copyFileSync(src, join(dest, f));
}
console.log(`[install] copied ${files.join(", ")} -> ${dest}`);
console.log("[install] now toggle Odin off/on in Obsidian (Settings -> Community plugins) to reload.");
