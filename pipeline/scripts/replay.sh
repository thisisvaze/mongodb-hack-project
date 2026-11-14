#!/usr/bin/env bash
# Indexes a recorded video of a place: cuts it into frames, drops frames that
# show the same view as the one before, and sends the rest through extraction,
# several at a time. This is the "walk through first" pass that live guidance
# later searches.
#
#   scripts/replay.sh venue.mp4 [user_id] [space_id] [frames_per_second]
#
# Needs ffmpeg and curl.
#   PIPELINE_URL  the server (default http://127.0.0.1:8080)
#   PARALLEL      frames sent at the same time (default 4; 1 = one after another)
#   DEDUPE        0 keeps every frame (default 1: drop near-identical neighbours)
set -euo pipefail

video="${1:?usage: replay.sh <video file> [user_id] [space_id] [frames_per_second]}"
user="${2:-u_resident}"
space="${3:-home}"
fps="${4:-1}"
base="${PIPELINE_URL:-http://127.0.0.1:8080}"
parallel="${PARALLEL:-4}"
dedupe="${DEDUPE:-1}"

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
mkdir "$dir/all" "$dir/keep"

# At most 1280 px wide (smaller videos keep their size).
ffmpeg -loglevel error -i "$video" -an -vf "fps=$fps,scale='min(1280,iw)':-2" -q:v 3 "$dir/all/frame-%05d.jpg"
all=("$dir"/all/frame-*.jpg)
[ -e "${all[0]}" ] || { echo "no frames could be read from $video" >&2; exit 1; }

# A camera that stands still or pans slowly gives the same view several times.
# One model call per view is enough: keep a frame only if it differs from the
# last one kept.
if [ "$dedupe" = "1" ]; then
  ffmpeg -loglevel error -framerate 1 -i "$dir/all/frame-%05d.jpg" -vf "mpdecimate=hi=64*40:lo=64*16:frac=0.5" -fps_mode vfr -q:v 2 "$dir/keep/frame-%05d.jpg"
else
  mv "$dir"/all/frame-*.jpg "$dir/keep/"
fi
frames=("$dir"/keep/frame-*.jpg)
echo "${#all[@]} frames from $(basename "$video"), $(( ${#all[@]} - ${#frames[@]} )) dropped as repeats of the view before, ${#frames[@]} to index, $parallel at a time"

# Sends one frame. "index": true makes the server process it now and reply with
# what it remembered.
send='
frame="$1"
body="$frame.json"
{ printf "{\"space_id\":\"%s\",\"user_id\":\"%s\",\"index\":true,\"image_b64\":\"" "$SPACE" "$USER_ID"; base64 < "$frame" | tr -d "\n"; printf "\"}"; } > "$body"
reply="$(curl -sS --max-time 120 -X POST -H "Content-Type: application/json" --data-binary "@$body" "$BASE/api/frames" 2>&1)" || reply="FAILED: $reply"
rm -f "$body"
printf "%s -> %s\n" "$(basename "$frame")" "$(printf "%s" "$reply" | cut -c1-300)"
'

started=$(date +%s)
printf '%s\0' "${frames[@]}" | SPACE="$space" USER_ID="$user" BASE="$base" xargs -0 -n 1 -P "$parallel" sh -c "$send" sh
took=$(( $(date +%s) - started ))
[ "$took" -gt 0 ] || took=1

echo "${#frames[@]} frames indexed in ${took}s ($(awk -v n="${#frames[@]}" -v t="$took" 'BEGIN { printf "%.2f", n / t }') frames a second)"
curl -sS "$base/stats"
echo
