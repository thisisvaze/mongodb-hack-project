# 01 — System Architecture & Live Stream Pipeline

## High-Level Architecture

```mermaid
flowchart LR
  subgraph Glasses["Mentra Live Glasses (or Phone/Webcam Dev Mode)"]
    CAM["Camera (WHIP WebRTC 15fps)"]
    MIC["Mic (STT / Audio Chunks)"]
    SPK["Open-Ear Speakers"]
  end

  subgraph FastBackend["FastAPI Backend — Hot & Cold Paths"]
    RAM["RAM Ring Buffer\n(latest_frame JPEG + rolling transcript)"]
    GATE["Scene-Change & Speech Trigger\n(pHash / pixel-diff + VAD utterance end)"]
    INGEST["Async Ingest Worker\n(Non-blocking background task)"]
    QA["Query & Navigation Router\n(<1s Hot Path)"]
    GUIDE["1-fps Active Homing Loop\n(Runs only during 'Guide me' session)"]
  end

  subgraph AI["AI Models"]
    GEM["Gemini 4 Carbon\n(Tactile Landmarks + Policy Gate + Clock Cues)"]
    VOY["Voyage AI\n(voyage-multimodal-3.5 — 1024d)"]
    EL["ElevenLabs Flash v2.5\n(Low-latency Streaming TTS)"]
  end

  subgraph Atlas["MongoDB Atlas Sandbox (Cluster0)"]
    MEM[("memories\n(Vector Search + TTL + Status)")]
    AUD[("audit_events\n(Immutable $jsonSchema Log)")]
    CS[["Change Streams\n(db.memories.watch & db.audit_events.watch)"]]
  end

  subgraph UI["Judge Control Room Web UI"]
    DASH["Live POV + Shared/Private Feed +\nUser A/B Switcher + Audit Timeline"]
  end

  CAM -->|"~300ms WebRTC"| RAM
  MIC -->|"Live utterances"| RAM
  RAM --> GATE
  GATE -->|"New view or spoken note"| INGEST
  INGEST --> GEM
  INGEST --> VOY
  GEM & VOY -->|"Reconcile: ADD / REINFORCE / SUPERSEDE"| MEM
  GEM -->|"Policy / Quarantine log"| AUD

  MIC -->|"User asks question"| QA
  RAM -.->|"0ms live frame (if needed)"| QA
  QA <-->|"~30ms $vectorSearch\n(shared + own private)"| MEM
  QA -->|"Blocked private hit"| AUD
  QA --> GEM
  GEM --> EL
  EL -->|"Streamed PCM/MP3"| SPK

  QA -->|"Start 'Guide me'"| GUIDE
  RAM -->|"1 fps frame"| GUIDE
  GUIDE --> VOY
  GUIDE --> GEM
  GUIDE -->|"Auto-mark missing/moved"| MEM
  GUIDE --> EL

  MEM --> CS
  AUD --> CS
  CS -->|"Server-Sent Events (SSE)"| DASH
```

---

## How the Stream Feeds Into MongoDB Atlas (Step-by-Step)

A naive pipeline that uploads full MP4 videos, saves every frame, or waits for database indexing before answering will lag by 5–15 seconds. Instead, we separate **Hot RAM State** from **Filtered Async Indexing**:

### 1. Transport From Mentra Live (Critical SDK Detail)
- **Do NOT use Mentra's default `ingest: "srt"` / HLS** — HLS buffers segments and adds **10–20 seconds** of latency.
- **Primary path:** Use **WHIP / WebRTC** (`streamUrl: "http://<LAN_IP>:8889/mentra-live/whip"`, `video: { fps: 15 }`) or `warmUpCamera({ size: "medium", durationMs: 30_000 })` + fast `requestPhoto({ size: "medium", compress: "medium", sound: false })` bursts every ~2s.
- **Parallel Dev Fallback (Crucial for Team Speed):** Expose the exact same `/api/ingest/frame` and `/api/ingest/utterance` endpoints to a mobile/laptop browser `getUserMedia` page so all 3 teammates can build and test simultaneously while only 1 person wears the physical glasses.

### 2. Minimal-Footprint RAM Ring Buffer (Hot Path — Ready in `~0.4s`)
- As soon as WebRTC connects (`status: "streaming"`), an ffmpeg/aiortc decoder overwrites a **single in-memory variable**:
  ```python
  latest_frame: FrameSnapshot  # { jpeg_bytes, timestamp, phash, venue_id, user_id }  (venue_id = the home or other space)
  recent_utterances: deque[Utterance]  # last 30s of spoken mic transcripts
  ```
- **Zero disk bloat:** Frames are *not* written to disk unless the Change Gate promotes one to a memory keyframe.
- **Instant Frame-1 Queries:** If the user asks *"What's on the counter in front of me?"* **0.4 seconds** after starting the stream, the Query Router reads `latest_frame` straight from RAM (**0 ms capture wait**) and answers via Gemini 4 + ElevenLabs in **~1.1 seconds**.

### 3. The Change Gate (Prevents Flooding MongoDB)
Every `1.5 seconds`, a lightweight gate checks if anything meaningful happened:
1. **Visual change:** Perceptual hash (`pHash`) distance between `latest_frame` and `last_indexed_frame` exceeds threshold (i.e., user turned their head or entered a new area, and frame isn't motion-blurred).
2. **Spoken/overheard audio trigger:** Mic VAD finishes an utterance containing spatial, object, or note content (e.g., *"Putting my keys in my left coat pocket"*, *"The step down to the garage is on the right"*, *"Your new pills are in the top cupboard"*).

If **neither** changed (e.g., user is staring at the same wall in silence), **nothing is sent to Gemini, Voyage, or MongoDB**.

### 4. Async Extraction, Multimodal Embedding & Policy Split (`~2–3s` in Background)
When the gate triggers, `asyncio.create_task(process_observation(...))` runs off the main thread:
1. **Gemini 4 Carbon (Single Structured JSON Call):**
   - Inputs: `latest_frame` JPEG (if visual) + `utterance_text` (if audio) + `venue_id`.
   - Outputs structured list of observations:
     - `item_key`: canonical normalized slug (`"house_keys"`, `"bathroom_door"`, `"ibuprofen_bottle"`, `"wall_outlet"`).
     - `category`: `"venue_fixture" | "hazard" | "personal_item" | "spoken_note"` (`venue_fixture` = a fixed part of the space, such as a door, stairs, or an appliance).
     - `tactile_anchor`: **strictly non-visual, touch/body-relative landmarks** (*"6 inches left of the electric kettle on the waist-high counter"*, never *"next to the blue box"*).
     - `proposed_visibility`: `"public"` (shared with everyone in the home; only permanent fixtures & hazards with zero PII/faces) vs. `"private"` (personal belongings, meds, IDs, wallets, pockets, private speech).
     - `ttl_seconds`: `null` (durable), `7200` (temporary hazard like a freshly mopped floor), or the stay's end time (temporary stay mode).
     - `bbox`: `[ymin, xmin, ymax, xmax]` (0–1000 normalized coordinates from Gemini for drawing highlights on the Judge UI!).
2. **Voyage Multimodal 3.5 (`voyage-multimodal-3.5`):**
   - Calls `voyageai.Client.multimodal_embed` with `[frame_image, summary_text + transcript]` (`model="voyage-multimodal-3.5"`, `input_type="document"`, `output_dimension=1024`).
   - Why this matters: even background items Gemini didn't explicitly itemize stay visually searchable in the 1024-d vector!
3. **MongoDB Reconciler & Audit Writer:**
   - Deduplicates or supersedes prior records for the same `(owner_id, item_key)` or `(venue_id, item_key)` and logs the policy decision to `audit_events` (see [`02-mongodb-schema-and-governance.md`](./02-mongodb-schema-and-governance.md)).

---

## End-to-End Latency Budget

| User Action | Path Taken | Target Latency to First Word |
| --- | --- | --- |
| *"Where did I leave my keys?"* / *"Where's the thermostat?"* | STT → `voyage-multimodal-3.5` query embed (`~90ms`) → Atlas `$vectorSearch` (`~30ms`) → Gemini 4 short answer (`~350ms`) → ElevenLabs Flash v2.5 (`~180ms`) | **~0.8 – 1.0 sec** |
| *"What bottle am I holding right now?"* | STT → grab `latest_frame` already in RAM (`0ms`) → Gemini 4 vision (`~650ms`) → ElevenLabs Flash v2.5 (`~180ms`) | **~1.1 – 1.3 sec** |
| *"Guide me to my keys"* (Active Homing ticks) | 1-fps `latest_frame` → clock-face check (`~450ms`) → cached/streamed 3-word ElevenLabs cue (*"11 o'clock, two steps"*) | **Updates every ~1.0 sec** |
