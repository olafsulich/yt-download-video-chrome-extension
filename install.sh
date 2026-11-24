#!/usr/bin/env bash
# Registers the native messaging host that does the actual download (yt-dlp + ffmpeg).
# Run it once after cloning, and again if you move the folder.
# Usage: ./install.sh [extra NativeMessagingHosts dir ...]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
NAME="com.ytvideo.downloader"
EXT_ID="nkhohmmohkjheogehgcdlkkhnpmeginc" # fixed by "key" in manifest.json

for tool in yt-dlp ffmpeg; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Install it with: brew install yt-dlp ffmpeg"; exit 1; }
done
PY="$(command -v python3)" || { echo "Missing python3"; exit 1; }

# Chrome launches hosts with a bare environment, so pin the interpreter by absolute path.
LAUNCHER="$ROOT/host/run-host.sh"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$PY" "$ROOT/host/ytvideo_host.py" "\$@"
EOF
chmod +x "$LAUNCHER"

MANIFEST=$(cat <<EOF
{
  "name": "$NAME",
  "description": "YouTube Video Downloader helper (yt-dlp)",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

SUPPORT="$HOME/Library/Application Support"
DIRS=(
  "$SUPPORT/Google/Chrome/NativeMessagingHosts"
  "$SUPPORT/Google/Chrome Beta/NativeMessagingHosts"
  "$SUPPORT/Google/Chrome Canary/NativeMessagingHosts"
  "$SUPPORT/Chromium/NativeMessagingHosts"
  "$SUPPORT/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$SUPPORT/Microsoft Edge/NativeMessagingHosts"
  "$SUPPORT/Arc/User Data/NativeMessagingHosts"
)
for d in "$@"; do DIRS+=("$d"); done

for d in "${DIRS[@]}"; do
  # Only browsers that are installed (their profile folder exists), plus dirs passed explicitly.
  [ -d "$(dirname "$d")" ] || continue
  mkdir -p "$d"
  printf '%s\n' "$MANIFEST" > "$d/$NAME.json"
  echo "Installed host for: $d"
done
echo "Done. Reload the extension in chrome://extensions if it was already loaded."
