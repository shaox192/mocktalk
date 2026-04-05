// Copies runtime assets for @ricky0123/vad-web and onnxruntime-web
// into public/ so they are served at the site root (where MicVAD
// looks for them via baseAssetPath: "/" and onnxWASMBasePath: "/").
//
// Run automatically via the "postinstall" script in package.json.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, "..");
const publicDir = join(frontendRoot, "public");
const vadDist = join(frontendRoot, "node_modules", "@ricky0123", "vad-web", "dist");
const ortDist = join(frontendRoot, "node_modules", "onnxruntime-web", "dist");

if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true });

const vadFiles = ["silero_vad_legacy.onnx", "vad.worklet.bundle.min.js"];

// Copy every ort-wasm-simd-threaded.* file — onnxruntime-web picks the
// variant at runtime based on browser capabilities (jsep, jspi, asyncify, base).
const ortFiles = existsSync(ortDist)
  ? readdirSync(ortDist).filter((f) => f.startsWith("ort-wasm-simd-threaded."))
  : [];

let copied = 0;
let skipped = 0;

for (const [srcDir, files] of [
  [vadDist, vadFiles],
  [ortDist, ortFiles],
]) {
  for (const name of files) {
    const src = join(srcDir, name);
    const dest = join(publicDir, name);
    if (!existsSync(src)) {
      console.warn(`[copy-vad-assets] missing source: ${src}`);
      skipped++;
      continue;
    }
    copyFileSync(src, dest);
    copied++;
  }
}

console.log(
  `[copy-vad-assets] copied ${copied} file(s) into public/` +
    (skipped ? ` (${skipped} skipped)` : "")
);
