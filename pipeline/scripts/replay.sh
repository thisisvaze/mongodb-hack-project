#!/usr/bin/env bash
# Indexes a recorded video of a place: cuts it into frames and sends each one
# through extraction, waiting for it to finish before sending the next. This is
# the "walk through first" pass that live guidance later searches.
#
#   scripts/replay.sh venue.mp4 [user_id] [space_id] [frames_per_second]
#
# Needs ffmpeg and curl. PIPELINE_URL sets the server (default http://127.0.0.1:8080).
set -euo pipefail

video="${1:?usage: replay.sh <video file> [user_id] [space_id] [frames_per_second]}"
user="${2:-u_resident}"
space="${3:-home}"
fps="${4:-1}"
base="${PIPELINE_URL:-http://127.0.0.1:8080}"

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

# At most 1280 px wide (smaller videos keep their size).
ffmpeg -loglevel error -i "$video" -an -vf "fps=$fps,scale='min(1280,iw)':-2" -q:v 3 "$dir/frame-%05d.jpg"

frames=("$dir"/frame-*.jpg)
[ -e "${frames[0]}" ] || { echo "no frames could be read from $video" >&2; exit 1; }
echo "${#frames[@]} frames from $(basename "$video")"

for frame in "${frames[@]}"; do
  # "index": true makes the server process this frame now and reply with what it remembered.
  { printf '{"space_id":"%s","user_id":"%s","index":true,"image_b64":"' "$space" "$user"; base64 < "$frame" | tr -d '\n'; printf '"}'; } > "$dir/body.json"
  reply="$(curl -sS --max-time 90 -X POST -H 'Content-Type: application/json' --data-binary "@$dir/body.json" "$base/api/frames")"
  echo "$(basename "$frame") -> ${reply:0:300}"
done

curl -sS "$base/stats"
echo
