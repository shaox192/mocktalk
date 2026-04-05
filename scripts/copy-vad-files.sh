#!/usr/bin/env bash
# copy-vad-files.sh — Copies VAD runtime assets into public/ during build.
# These files are gitignored (~90 MB) but required at the web root for
# @ricky0123/vad-web to function (MicVAD.new uses baseAssetPath: "/").
#
# Run from the frontend/ directory after npm ci.
set -euo pipefail

echo "=== Copying VAD / ONNX runtime files to public/ ==="

VAD_DIST="node_modules/@ricky0123/vad-web/dist"
ORT_DIST="node_modules/onnxruntime-web/dist"
TARGET="public"

# 1. ONNX model file
cp "$VAD_DIST/silero_vad_legacy.onnx" "$TARGET/"

# 2. VAD worklet
cp "$VAD_DIST/vad.worklet.bundle.min.js" "$TARGET/"

# 3. All ONNX Runtime WASM + MJS files
for ext in mjs wasm; do
  cp "$ORT_DIST/"*."$ext" "$TARGET/" 2>/dev/null || true
done

# Remove any sourcemap files that may have been copied
rm -f "$TARGET/"*.map

COUNT=$(ls -1 "$TARGET/"*.mjs "$TARGET/"*.wasm "$TARGET/"*.onnx "$TARGET/vad.worklet.bundle.min.js" 2>/dev/null | wc -l)
echo "=== Copied $COUNT VAD/ONNX files to $TARGET/ ==="
