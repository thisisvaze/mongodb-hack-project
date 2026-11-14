# 05 — Build Plan for the Stream Pipeline

Work plan for everything in [`01-architecture-and-stream-pipeline.md`](./01-architecture-and-stream-pipeline.md), in the same order as that doc. Each step lists the work, who owns it, and how to tell it is done.

The product helps blind and low-vision guests find their way around venues they have never visited (see the [README](./README.md)). `venue_id` in the data shapes below identifies the venue the guest is in (a hotel, conference centre, restaurant, ...), or a guest's own room stay.

Owners follow the 3-person split in the [README](./README.md):

- **S** — Stream, Hardware & Voice
- **M** — MongoDB & Multimodal Brain
- **U** — Judge Control Room UI

## Before Step 1: shared setup (everyone, ~30 min)

Nothing in the repo exists yet except docs, so do this together first.

- [ ] Create the folders: `backend/` (Rust: `axum` + `tokio`), `dev-sim/` (browser webcam/mic page), `ui/` (Next.js), `mentra-app/` (glasses relay, if needed).
- [ ] Add `.env.example` with `MONGODB_URI`, `VOYAGE_API_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`.
- [ ] Add the backend crates: `axum` (with the `multipart` feature), `tokio`, `serde` / `serde_json`, `reqwest` (with `json` and `stream`), `mongodb`, `image`, `image_hasher`, `base64`, `dotenvy`.
- [ ] Commit the shared data shapes as `serde` structs in `backend/src/models.rs`. Once these are fixed, all three people can build against them without waiting on each other:
  - `FrameSnapshot { jpeg_bytes, timestamp, phash, venue_id, user_id }`
  - `Utterance { text, timestamp, venue_id, user_id }`
  - `Observation { item_key, category, tactile_anchor, proposed_visibility, ttl_seconds, bbox, summary }`
- [ ] **M:** create the Atlas Vector Search index now (definition in [doc 02](./02-mongodb-schema-and-governance.md)). It takes a few minutes to build.

**Done when:** `cargo run` serves `GET /health` and everyone's `.env` loads.

---

## Step 1 — Transport from Mentra Live (S)

Build the dev fallback first. It gives M and U real frames within the first hour, while only one person has the glasses.

### 1a. Dev fallback (do first)

- [ ] `POST /api/ingest/frame` — multipart JPEG plus `user_id` and `venue_id`.
- [ ] `POST /api/ingest/utterance` — JSON `{ text, user_id, venue_id }`.
- [ ] `dev-sim/index.html`:
  - webcam via `getUserMedia`, drawn to a canvas, posted as JPEG every ~500 ms
  - mic transcripts via the browser's `SpeechRecognition` API, posted when an utterance is final
  - dropdowns for user (Guest A / Guest B / Staff) and space (`venue_id`: the demo venue, or a guest's room stay)

**Done when:** two laptops post frames at the same time as different users.

### 1b. Glasses

- [ ] Check the Mentra SDK docs for camera streaming, `requestPhoto`, `warmUpCamera`, and transcription events. **Check the SDK language first:** if it is TypeScript only, the glasses need a small relay app in `mentra-app/` that forwards frames and transcripts to the two endpoints above.
- [ ] Start with photo bursts: `warmUpCamera` then `requestPhoto({ size: "medium", compress: "medium", sound: false })` every ~2 s, posted to `/api/ingest/frame`.
- [ ] Forward final mic transcripts to `/api/ingest/utterance`.
- [ ] Stretch: WHIP/WebRTC at 15 fps. The URL in doc 01 (`:8889/.../whip`) is the MediaMTX default port, so this means running MediaMTX on the laptop and pulling frames from it with ffmpeg into the backend. Only do this if photo bursts feel too slow in the demo.
- [ ] Do not use `ingest: "srt"` / HLS (10–20 s lag).
- [ ] Test on the hackathon Wi-Fi early. If the glasses cannot reach the laptop, switch to a phone hotspot.

**Done when:** a frame from the glasses reaches the backend within ~2 s.

---

## Step 2 — RAM ring buffer (S)

- [ ] `backend/src/state.rs`: a shared map (`Arc<RwLock<HashMap<..>>>` in axum state) with one session per `user_id` holding `latest_frame`, `last_indexed_frame`, and `recent_utterances` (a `VecDeque`). Per-user sessions are required for the User A / User B demo.
- [ ] Each ingest call overwrites `latest_frame` and computes its pHash (`image_hasher` crate). Decode and hash inside `tokio::task::spawn_blocking` so ingest requests do not stall the async runtime.
- [ ] Drop utterances older than 30 s.
- [ ] Compute a blur score per frame (variance of the Laplacian, computed on a downscaled grayscale image with the `image` / `imageproc` crates; this avoids an OpenCV build) so Step 3 can skip motion-blurred frames.
- [ ] Never write frames to disk.
- [ ] `GET /api/frame/latest?user_id=` returns the current JPEG, for the UI's live POV panel.

**Done when:** a posted frame is readable from RAM straight away, and two users' frames never mix.

---

## Step 3 — Change gate (S, with M for the hand-off)

- [ ] `backend/src/gate.rs`: a background task spawned at startup, using `tokio::time::interval` to tick every 1.5 s per active session.
- [ ] Visual trigger: pHash distance between `latest_frame` and `last_indexed_frame` is over a threshold, and the frame is not blurry. Start the threshold around 10 and tune it by walking around.
- [ ] Speech trigger: a new final utterance that matches a keyword list (left, right, past, steps, door, stairs, elevator, lift, restroom, reception, exit, wet floor, cart, blocking, careful, room key, passport, put, moved, …). Keep this as a plain keyword check; an LLM call on every tick is too slow.
- [ ] If neither trigger fires, make no API or database calls.
- [ ] If one fires, set `last_indexed_frame = latest_frame` and start `tokio::spawn(process_observation(...))`.
- [ ] Allow only one `process_observation` per user at a time (an `AtomicBool` flag on the session), so triggers cannot pile up.
- [ ] Count triggers and skips. U can show the count as proof that the pipeline does not flood MongoDB.

**Done when:**

| Action | Calls to Gemini / Voyage / MongoDB |
| --- | --- |
| Stare at a wall in silence | 0 |
| Turn your head to a new view | 1 |
| Say "wet floor outside the restrooms" | 1 |

---

## Step 4 — Async extraction, embedding and policy split (M)

### 4.1 Gemini structured extraction

- [ ] `backend/src/ai/gemini.rs`: one REST call through `reqwest` with the JPEG (base64) (if visual), the utterance text (if audio), and `venue_id`, returning a JSON list of `Observation`.
- [ ] Set a response schema in the request so the JSON always deserialises into `Vec<Observation>` with `serde`.
- [ ] The prompt must enforce:
  - `tactile_anchor` uses touch and body-relative landmarks only, never colours or appearance
  - `proposed_visibility` is `public` (shared with everyone in the venue) only for venue fixtures and blockers with no PII or faces
  - `ttl_seconds` is `null` for map entries, `7200` for blockers, or the checkout time in a room stay
  - `bbox` is `[ymin, xmin, ymax, xmax]` on a 0–1000 scale
- [ ] Normalise `item_key` (for example `lift` → `elevator_bank`, `key card` → `room_key`) so the reconciler can match items across sightings.
- [ ] Server-side override: `personal_item` and `spoken_note` are always stored as `private`, whatever Gemini proposes.
- [ ] Confirm the exact model ID for "Gemini 4 Carbon" on your API key and keep it in `GEMINI_MODEL`.

### 4.2 Voyage multimodal embedding

- [ ] `backend/src/ai/voyage.rs`: Voyage's multimodal embeddings REST endpoint through `reqwest` (doc 01 shows the Python client; confirm the request body in the Voyage API reference). Send `[frame_image as base64, summary_text + transcript]` with `model="voyage-multimodal-3.5"`, `input_type="document"`, `output_dimension=1024`.
- [ ] Voice-only notes have no frame: embed the text alone.
- [ ] Add `embed_query(text)` with `input_type="query"` for the query path later.

### 4.3 Reconciler and audit writer

Follows the state machine in [doc 02](./02-mongodb-schema-and-governance.md).

- [ ] `backend/src/reconcile.rs`, using the official `mongodb` crate: find the active memory for `(owner_id, item_key)` or `(venue_id, item_key)`.
  - none found → **ADD**
  - same landmark, or cosine similarity over 0.88 → **REINFORCE** (increment `reinforcement_count`, update `last_seen_at`)
  - different landmark, or the user said they moved it → **SUPERSEDE** (old doc gets `status: "superseded"` and `superseded_by`; new doc stores `previous_location`)
- [ ] Set `expires_at` from `ttl_seconds`.
- [ ] Store a small thumbnail (`frame_thumb_b64`) and the `bbox` for the UI.
- [ ] Write one `audit_events` row per decision: added to the venue map, shared as a blocker, quarantined private, or superseded.

**Done when:** showing a room key card on the desk and then saying "room key is in my pocket" leaves one superseded memory, one active memory, and the matching audit rows, about 3 s after each trigger.

---

## Latency budget — the three query paths

Doc 01 ends with a latency table. Each row is a path that still has to be built on top of Steps 1–4.

| Path | Work | Owner | Target to first word |
| --- | --- | --- | --- |
| Recall ("Where's the elevator?" / "Where did I put my room key?") | `embed_query` → `$vectorSearch` with the venue map + blockers + own-private filter → short Gemini answer → ElevenLabs Flash v2.5 stream | M, S for voice | 0.8–1.0 s |
| Live vision ("What's in front of me?") | `latest_frame` from RAM → Gemini vision → ElevenLabs | M, S for voice | 1.1–1.3 s |
| Guide me (route guidance) | 1-fps loop: `latest_frame` → clock-face + obstacle check → short cue, warning about blockers on the route; pre-generate and cache common cues | S | one update per ~1 s |

- [ ] `POST /api/query { user_id, venue_id, text }` with a keyword-based intent split (where / what / guide me / forget).
- [ ] `backend/src/ai/tts.rs`: ElevenLabs Flash v2.5 streaming endpoint through `reqwest`, forwarding the byte stream as it arrives to the glasses speakers and to the dev-sim page.
- [ ] Log time per stage (embed, search, Gemini, first TTS byte) and compare with the table.
- [ ] Make one warm-up call to each API at startup so the first demo query is not slow.

Details of the guide loop are in [doc 03](./03-features-and-navigation-loop.md). The change-stream feed to the UI is in [doc 02](./02-mongodb-schema-and-governance.md) and [doc 04](./04-judge-demo-and-ui.md).

---

## Build order

1. Shared setup, Step 1a, Step 2 — everyone has frames.
2. In parallel: S on Step 1b and TTS; M on Step 4; U on the UI against sample events.
3. Step 3 connects ingest to extraction.
4. Query paths, then latency checks and demo rehearsal.
