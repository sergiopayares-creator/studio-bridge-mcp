#!/usr/bin/env bash
set -euo pipefail

# Studio Bridge — CEP Extension & MCP Server Installer (macOS)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_SRC="$ROOT/extension"
SERVER_DIR="$ROOT/mcp-video-server"

echo "=========================================================="
echo "   Installing Studio Bridge MCP (macOS)"
echo "=========================================================="

# 0. Verify Node.js and FFmpeg
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js 20+ is not installed or not in PATH." >&2
  echo "Install it from https://nodejs.org (or: brew install node) and re-run this script." >&2
  exit 1
fi
echo "OK Node.js: $(node -v)"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "WARN: FFmpeg not found in PATH (required for contactSheet, compare, JPEG recompression, and local media tools)." >&2
  echo "      Install with: brew install ffmpeg" >&2
else
  echo "OK FFmpeg detected."
fi

# 1. Enable PlayerDebugMode for Adobe CSXS (9-24)
echo ""
echo "[1/3] Enabling Adobe CSXS PlayerDebugMode (9-24)..."
for v in $(seq 9 24); do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null || true
done
echo "OK CSXS debug mode enabled."

# 2. Link CEP extension into Adobe extensions directory
echo ""
echo "[2/3] Linking Studio Bridge into Adobe CEP extensions..."
CEP_ROOT="$HOME/Library/Application Support/Adobe/CEP/extensions"
TARGET="$CEP_ROOT/com.antigravity.bridge"
mkdir -p "$CEP_ROOT"

if [ -L "$TARGET" ]; then
  rm "$TARGET"
elif [ -e "$TARGET" ]; then
  rm -rf "$TARGET"
fi

ln -s "$EXTENSION_SRC" "$TARGET"
echo "OK Linked: $TARGET -> $EXTENSION_SRC"

# 3. Install mcp-video-server dependencies if missing
echo ""
echo "[3/3] Checking mcp-video-server dependencies..."
if [ -d "$SERVER_DIR" ]; then
  if [ ! -d "$SERVER_DIR/node_modules" ]; then
    (cd "$SERVER_DIR" && npm install --no-audit --no-fund)
  fi
  echo "OK mcp-video-server dependencies ready."
fi

echo ""
echo "=========================================================="
echo "  STUDIO BRIDGE MCP INSTALLED"
echo "=========================================================="
echo "Next step: restart Premiere Pro / After Effects and open:"
echo "  Window > Extensions > Studio Bridge"
