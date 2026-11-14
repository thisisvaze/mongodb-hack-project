#!/usr/bin/env bash
# Live guidance from a video file or a live stream. Samples frames as they
# arrive, sends each to the server, and prints what the server would say to the
# wearer. Nothing here calls the extraction model: each frame is embedded and
# searched against what is already remembered about the space.
#
#   scripts/live.sh <video file or stream URL> [user_id] [space_id] [frames_per_second]
#
# A stream URL can be anything ffmpeg reads: rtsp://, rtmp://, srt://, an HLS .m3u8.
# SPEAK=1 also reads each line aloud with the macOS `say` command.
# Needs ffmpeg, curl and python3. PIPELINE_URL sets the server (default http://127.0.0.1:8080).
set -euo pipefail

src="${1:?usage: live.sh <video file or stream URL> [user_id] [space_id] [frames_per_second]}"
user="${2:-u_resident}"
space="${3:-home}"
fps="${4:-1}"
base="${PIPELINE_URL:-http://127.0.0.1:8080}"

dir="$(mktemp -d)"
ff=""
trap '[ -n "$ff" ] && kill "$ff" 2>/dev/null; rm -rf "$dir"' EXIT

filter="fps=$fps,scale='min(1280,iw)':-2"
if [ -f "$src" ]; then
  # -re plays a file at its real speed, as if it were being filmed now.
  ffmpeg -loglevel error -re -i "$src" -an -vf "$filter" -q:v 4 "$dir/frame-%06d.jpg" &
else
  ffmpeg -loglevel error -i "$src" -an -vf "$filter" -q:v 4 "$dir/frame-%06d.jpg" &
fi
ff=$!

frame_path() { printf '%s/frame-%06d.jpg' "$dir" "$1"; }

n=1
while :; do
  running=1; kill -0 "$ff" 2>/dev/null || running=0
  if [ -e "$(frame_path $((n + 1)))" ] || { [ "$running" = 0 ] && [ -e "$(frame_path "$n")" ]; }; then
    # If the server is slower than the camera, skip ahead to the newest finished frame.
    while [ -e "$(frame_path $((n + 2)))" ]; do rm -f "$(frame_path "$n")"; n=$((n + 1)); done
    frame="$(frame_path "$n")"
    { printf '{"space_id":"%s","user_id":"%s","image_b64":"' "$space" "$user"; base64 < "$frame" | tr -d '\n'; printf '"}'; } > "$dir/body.json"
    reply="$(curl -sS --max-time 15 -X POST -H 'Content-Type: application/json' --data-binary "@$dir/body.json" "$base/api/frames" || true)"
    line="$(printf '%s' "$reply" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("! no usable reply"); raise SystemExit
if "error" in d:
    print("! " + d["error"]); raise SystemExit
best = max((m["score"] for m in d.get("matches", [])), default=None)
print("%s\t%s" % (d.get("say") or "", "%d ms, best match %s" % (d.get("ms") or 0, "%.2f" % best if best else "none")))')"
    say="${line%%$'\t'*}"
    printf 'frame %4d  [%s]  %s\n' "$n" "${line#*$'\t'}" "${say:-(nothing new to say)}"
    if [ "${SPEAK:-0}" = 1 ] && [ -n "$say" ] && [ "${say:0:1}" != "!" ] && command -v say >/dev/null; then say "$say" & fi
    rm -f "$frame"
    n=$((n + 1))
  elif [ "$running" = 0 ]; then
    break
  else
    sleep 0.1
  fi
done
wait 2>/dev/null || true
