#!/usr/bin/env bash
# Receives the glasses' live video (miniapp: Camera frames -> Video) on this Mac and feeds
# it to the backend as JPEG frames, through pipeline/scripts/live.sh.
#
#   frontend/scripts/receive-video.sh [backend_url] [user_id] [space_id] [frames_per_second]
#
# Defaults: http://192.168.6.195:8080, u_guest, hotel, 2. The glasses publish to
# rtmp://<this Mac>:1935/live/glasses. Needs ffmpeg, curl and python3. Ctrl+C stops it.
set -euo pipefail

base="${1:-http://192.168.6.195:8080}"
user="${2:-u_guest}"
space="${3:-hotel}"
fps="${4:-2}"
live="$(cd "$(dirname "$0")/../../pipeline/scripts" && pwd)/live.sh"

# ffmpeg only waits for an RTMP publisher with -listen 1, which live.sh does not pass, so
# each glasses connection is relayed through a named pipe into a fresh live.sh run.
dir="$(mktemp -d)"
pipe="$dir/glasses.ts"
mkfifo "$pipe"
reader=""
trap 'kill $reader 2>/dev/null; pkill -f "rtmp://0.0.0.0:1935/live/glasses" 2>/dev/null; rm -rf "$dir"' EXIT

echo "Frames go to $base as $user in $space, $fps per second."
while :; do
  echo "Waiting for the glasses on rtmp://$(ipconfig getifaddr en0 2>/dev/null || echo this-mac):1935/live/glasses"
  PIPELINE_URL="$base" "$live" "$pipe" "$user" "$space" "$fps" &
  reader=$!
  ffmpeg -loglevel error -y -listen 1 -i rtmp://0.0.0.0:1935/live/glasses -an -c:v copy -f mpegts "$pipe" || true
  wait "$reader" || true
  echo "Glasses stream ended."
done
