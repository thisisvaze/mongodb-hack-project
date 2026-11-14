# SafeSpace pipeline (Rust)

Backend for SafeSpace: it helps a blind or low-vision person find where things
are and get where they want to go, asked by voice and answered in real time.

The service takes JPEG frames and transcribed speech, keeps governed memories in
MongoDB Atlas (database `hackathon`), and answers from them. It implements
`docs/api-contract.md`, so the dashboard, the capture page and the glasses app
can use it in place of the mock server.

## What it does

```
Indexing (slow path: the extraction model reads the frame or the sentence)
  frame and/or spoken note
    -> Gemini lists the things worth remembering (it is asked for at most six),
       each with a topic and whether it has moved; for a frame it also
       describes the view (where the camera is and what is around)
    -> the space's rules turn the topic into a group and an expiry
    -> Voyage embeds each item (1024 numbers)
    -> reconcile into `memories`: add, reinforce or supersede
    -> one `audit_events` row per add or supersede, one `observations` row per capture
    -> a frame sent with "index": true also stores the view description as a memory

Live guidance (fast path: no extraction model)
  frame -> Voyage embeds the frame
        -> Atlas Vector Search over the memories this user may see
        -> `say` and `matches` in the response

Question
  text -> Voyage embeds it
       -> Atlas Vector Search over the memories this user may see
       -> Gemini words an answer from those memories only
  A picture sent with the question is matched to a stored view, so the answer
  can start from where the person is standing.
```

Indexing starts in four ways: a note sent to `POST /api/turn`, a frame sent to
`POST /api/frames` with `"index": true`, the change gate deciding that a user's
latest frame is a new view, or a spoken note sent to `POST /api/ingest/utterance`.

Full frames are held in memory only (the latest one per user) and are never
written to disk. A memory may store a thumbnail of at most 200 px.

The service does not create collections, validators or indexes. Run
`db/setup.js` first; it also seeds the spaces `home` and `stay_guest_room`.

## Run and test

Needs Rust and a `.env` in the repo root (copy `.env.example`). Real environment
variables take priority over `.env`.

```sh
cd pipeline
cargo run --release
```

It listens on `0.0.0.0:8080`. At startup it pings Atlas and stops if that fails.

```sh
cargo test               # unit tests: gate, rules, turn sorting, parsing of model output. No network.
cargo test -- --ignored  # one test against the real Atlas database and Voyage
```

The ignored test writes to the real `memories`, `audit_events` and
`observations` collections (so their validators are exercised) under the space
id `test_pipeline_<process id>`, then deletes what it wrote. It needs
`MONGODB_URI` and a Voyage key and makes a few embedding calls. It does not call
Gemini and does not touch `spaces`. If it fails part-way its rows are left
behind; delete them by that `space_id`.

Two scripts stand in for the glasses. Both take
`<video> [user_id] [space_id] [frames_per_second]` (defaults `u_resident`,
`home`, `1`) and read the server address from `PIPELINE_URL` (default
`http://127.0.0.1:8080`).

`scripts/replay.sh` indexes a recorded walk-through (needs `ffmpeg` and `curl`).
It sends four frames at a time (`PARALLEL=4`; eight was measured no faster) and
skips frames that repeat the one before (`DEDUPE=1`). On a 20-frame clip that
took 34 s instead of 127 s one at a time. The server orders the writes about
any one thing, so two frames that see the same thing strengthen one memory
instead of adding two.
It cuts the video into frames and posts each one to `POST /api/frames` with
`"index": true`, then prints the total time and `/stats`.

`scripts/live.sh` runs live guidance over a video file, or over a stream that
ffmpeg can read (`rtsp://`, `rtmp://`, `srt://`, an HLS `.m3u8`). It needs
`ffmpeg`, `curl` and `python3`. It posts each sampled frame to
`POST /api/frames` and prints what the server would say, the server's time and
the best match score. A file is played at its real speed; if the server is
slower than the camera, it skips to the newest frame. `SPEAK=1` also reads each
line aloud with the macOS `say` command.

```sh
scripts/replay.sh venue.mp4                      # index a walk-through first
scripts/replay.sh venue.mp4 u_caregiver home 2   # user, space, frames per second
scripts/live.sh venue.mp4 u_visitor              # then walk it again as someone else
SPEAK=1 PIPELINE_URL=http://192.168.1.20:8080 scripts/live.sh rtsp://192.168.1.30/stream
```

### Pointing the frontend at this server

Open the web app with `?api=http://<host>:8080`, for example
`http://localhost:5180/?api=http://192.168.1.20:8080`. The web app saves the
value in the browser. The glasses app takes the backend address in its own
settings (`frontend/miniapp/README.md`). Any origin may call the API.

A phone browser only allows the camera and microphone on HTTPS pages, so put the
server behind an HTTPS tunnel for the capture page. Links in `frame` events are
built from `PUBLIC_BASE`, or from the request's `X-Forwarded-Proto`,
`X-Forwarded-Host` and `Host` headers when it is not set.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `MONGODB_URI` | required | Atlas connection string. `MDB_MCP_CONNECTION_STRING` is used if this is not set. |
| `DB_NAME` | `hackathon` | Database. `MONGODB_DB` is also accepted; `DB_NAME` wins. |
| `VOYAGE_API_KEY`, `VOYAGE_API_KEY_<NAME>` | at least one required | Embedding keys, see below. |
| `GEMINI_API_KEY` | not set | Key for the extraction and answering model. |
| `GEMINI_MODEL` | not set | Gemini model id. No default. `gemini-3.5-flash-lite` is the one to use (see Timings). |
| `GEMINI_THINKING_LEVEL` | not set | `low`, `medium` or `high`, for models that think by default. Leave unset for `gemini-3.5-flash-lite`. |
| `BIND_ADDR` | `0.0.0.0:8080` | Address to listen on. |
| `PUBLIC_BASE` | from the request | Address clients reach this server at, used in `frame` event links. |
| `GATE_TICK_MS` | `1500` | How often the change gate checks each user. Values under 100 become 100. |
| `PHASH_THRESHOLD` | `10` | A frame is a new view when more than this many of its 64 hash bits differ from the last indexed frame. |
| `MIN_SHARPNESS` | `0` | Frames with a sharpness score below this are not indexed by the gate. `0` accepts every frame. |
| `INDEX_LIVE_FRAMES` | `true` | `false` stops the gate from indexing frames: they are only searched (live guidance). Notes and `"index": true` still index. |
| `GUIDE_MIN_SCORE` | `0.80` | Live guidance: lowest vector-search score that counts as "this view is remembered". |
| `GUIDE_REPEAT_SECS` | `30` | Live guidance: how long before the same thing is said to the same user again. |
| `OBSERVATION_TTL_HOURS` | `24` | How long an `observations` row is kept. |

A number that cannot be parsed is ignored and the default is used.
`VOYAGE_API_BASE`, `ATLAS_MODEL_API_KEY` and the `ELEVENLABS_*` variables in
`.env.example` are not read by this service.

**Voyage keys.** The service uses `VOYAGE_API_KEY` and every variable whose name
starts with `VOYAGE_API_KEY_` (for example `VOYAGE_API_KEY_D`), so each team
member can add their own. Identical keys are used once.

- A key that starts with `al-` is an Atlas model key and goes to
  `ai.mongodb.com`. Any other key goes to `api.voyageai.com`. To use an Atlas
  model key, put it in one of the `VOYAGE_API_KEY...` variables.
- Atlas keys are placed first. Embeddings for a question or a live frame always
  start on the first key, so on an Atlas key when one is configured, because
  that endpoint is faster. Embeddings for stored memories start on the next key
  in turn, to spread the load.
- If a key is rate-limited (429), gets a server error or a network error, the
  same request moves to the next key. After every key has been tried it waits
  (250 ms, doubling) and goes round again, up to four rounds.
- A key rejected with 401 or 403 is not used again until the service restarts,
  as long as another key is available. With a single key, a 401 or 403 fails
  the request at once.
- The model is `voyage-multimodal-3.5` with 1024 dimensions. The startup log
  lists the key variable names in the order they are used.

**Gemini.** With `GEMINI_API_KEY` set but no `GEMINI_MODEL` the service refuses
to start. With neither set it runs without extraction: live guidance and
"forget" still work, notes and questions return `503`, and captures are logged
to `observations` with no memories. `/stats` shows `extraction_enabled`.

## HTTP endpoints

Seed ids: space `home` with users `u_resident` (role `resident`), `u_caregiver`
(`caregiver`) and `u_visitor` (`visitor`); space `stay_guest_room` with
`u_resident` only.

| Endpoint | What it does |
| --- | --- |
| `GET /api/state?space_id=..` | Users, rules, memories and recent audit entries of a space. |
| `POST /api/turn` | One spoken or typed turn (note, question or "forget"), answered in the same request. |
| `POST /api/frames` | A frame with no speech: live guidance, or indexing with `"index": true`. |
| `PUT /api/rules?space_id=..` | Replaces the space's rules. |
| `GET /api/events?space_id=..` | Server-sent events for the live dashboard. |
| `GET /api/health` | `{"ok": true}` |
| `GET /api/frame/latest?user_id=..` | The user's latest frame as a JPEG. |
| `POST /api/ingest/frame`, `POST /api/ingest/utterance` | Older ingest endpoints. Reply `202`; processing happens later through the change gate. |
| `GET /health`, `GET /healthz`, `GET /stats` | Plain `ok`; JSON counters. |

Common behaviour of the `/api/state`, `/api/turn`, `/api/frames` and `/api/rules` endpoints:

- Errors are `{"error": "..."}` with a non-2xx status. An unknown `space_id` is
  `404`. On `/api/turn` and `/api/frames`, a `user_id` that is not in the
  space's `members` is also `404`. A failure in Atlas, Voyage or Gemini is `500`.
- A request the framework cannot parse (missing query parameter, invalid JSON,
  missing required field) gets a plain-text `4xx`, not the JSON error shape.
- `ts` in a request body is ignored; the server uses the time of arrival.
- An image is `image_b64` (base64 JPEG, with or without a `data:` prefix) or
  `image_url` (an `http(s)` link to a JPEG of at most 8 MB, downloaded straight
  away with a 10 second limit). Request bodies are limited to 12 MB.
- Every accepted image becomes that user's latest frame and produces a `frame` event.

### `GET /api/state?space_id=home`

```sh
curl "http://127.0.0.1:8080/api/state?space_id=home"
```

```json
{
  "space_id": "home",
  "users": [{ "id": "u_resident", "name": "Resident", "role": "resident" }],
  "rules": { "roles": {}, "topics": {}, "default_group": "resident_only" },
  "memories": [],
  "audit": []
}
```

The example is shortened. `users` is the space's `members` and `rules` is its
`rules`, as stored.
`memories` is the newest 300 by `created_at`, of every status, not filtered by
role (this is the admin view). `audit` is the newest 200.

A memory:

```json
{
  "id": "m_6737a1c2e4b0f1a2b3c4d5e6",
  "space_id": "home",
  "owner_id": "u_resident",
  "item": "house keys",
  "summary": "Keys are in the left jacket pocket.",
  "location": "left jacket pocket",
  "topic": "valuables",
  "group": "resident_only",
  "source": "voice",
  "status": "active",
  "superseded_by": null,
  "created_at": "2026-11-14T17:02:11.512Z",
  "updated_at": "2026-11-14T17:02:11.512Z",
  "expires_at": null,
  "image_url": null
}
```

`image_url` is either `null` or a `data:image/jpeg;base64,...` thumbnail (at most
200 px on its longer side), not an `http` link. It can be used directly as an
image source. Backend-only fields (`embedding`, `item_key`, `tactile_anchor`
and others) are not returned.

An audit entry has `id`, `ts`, `space_id`, `actor_id`, `action`, `verdict`,
`detail` and `memory_ids`, as in the contract.

### `POST /api/turn`

```sh
curl -X POST -H 'Content-Type: application/json' \
  -d '{"space_id":"home","user_id":"u_resident","text":"I am putting my keys in my left jacket pocket"}' \
  http://127.0.0.1:8080/api/turn
```

Body: `space_id`, `user_id`, `text`, and optionally `audio`, `image_b64` or
`image_url`.

```json
{
  "kind": "saved",
  "reply_text": "Saved. Keys are in the left jacket pocket.",
  "audio_url": null,
  "memory_ids": ["m_6737a1c2e4b0f1a2b3c4d5e6"],
  "heard_text": "I am putting my keys in my left jacket pocket",
  "input_used": "text"
}
```

- `kind` is `saved`, `answer`, `denied`, `forgot` or `ignored`. See "How a turn
  is classified" for which one and what is written.
- `audio_url` is always `null`. `input_used` is always `"text"`, and
  `heard_text` is the trimmed `text`.
- `audio` is never read. With `text` present it is ignored. With `audio` and no
  `text` the reply is `415`.
- With neither `text` nor `audio` the reply is `kind: "ignored"` with an empty
  `reply_text`.
- A picture that cannot be read is dropped and the words are still processed.
- Notes and questions need Gemini; without it they return `503`.

### `POST /api/frames`

```sh
(printf '{"space_id":"home","user_id":"u_resident","image_b64":"'; base64 < frame.jpg | tr -d '\n'; printf '"}') \
  | curl -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:8080/api/frames
```

Body: `space_id`, `user_id`, one of `image_b64` or `image_url`, and optionally
`"index": true`. `400` if the image is missing or is not a readable JPEG.

Without `index` (the normal case, live guidance):

```json
{
  "ok": true,
  "say": "Careful. Water spilled on the floor by the sink. You are facing the kitchen counter, about three steps ahead. The fridge is at your two o'clock.",
  "matches": [
    { "id": "m_...", "item": "kitchen by the back door", "view": true, "topic": "house_guide", "location": "kitchen by the back door", "score": 0.88 },
    { "id": "m_...", "item": "wet kitchen floor", "view": false, "topic": "hazard", "location": "by the sink", "score": 0.84 }
  ],
  "ms": 412
}
```

The values only show the shape. `say` is text to speak, or `null` when there is
nothing new to say. `matches` holds up to 8 memories, closest first; `view` is
`true` for a stored view (see Views) and `false` for a thing. `ms` is the
server's time for the embedding and the search. If guidance fails, the reply is
still `200` with `"say": null, "matches": []` and no `ms`. The frame also goes
through the change gate, which may index it in the background.

With `"index": true`, the frame is run through extraction before the reply, and
the reply lists the item memories it added, reinforced or replaced. A view
stored from the same frame is not in the list. There is no guidance in this
reply, and the gate does not process this frame again.

```json
{ "ok": true, "indexed": [{ "id": "m_...", "summary": "Kettle on the kitchen counter." }] }
```

Without Gemini configured, `indexed` is always empty.

### `PUT /api/rules?space_id=home`

The body is a full Rules document; it replaces the stored one.

```sh
curl -X PUT -H 'Content-Type: application/json' "http://127.0.0.1:8080/api/rules?space_id=home" -d '{
  "roles": {
    "resident":  { "can_see": ["*"] },
    "caregiver": { "can_see": ["care", "supplies", "house_guide"] },
    "visitor":   { "can_see": ["house_guide"] }
  },
  "topics": {
    "medication":  { "group": "care", "keep_for": "30d" },
    "supplies":    { "group": "supplies", "keep_for": null },
    "valuables":   { "group": "resident_only", "keep_for": null },
    "documents":   { "group": "resident_only", "keep_for": null },
    "house_guide": { "group": "house_guide", "keep_for": null },
    "hazard":      { "group": "house_guide", "keep_for": "2h" }
  },
  "default_group": "resident_only"
}'
```

Reply: `{"ok": true, "rules": { ... }}`. It writes one `rule_changed` audit row
(actor `dashboard`) and sends a `rules` event. `400` if a role, topic or group
name is not lowercase letters, digits and underscores, if a `can_see` entry is
neither such a name nor `"*"`, or if a `keep_for` is not a number followed by
`s`, `m`, `h`, `d` or `w` (or `null`).

New rules apply to the next memory stored and the next question asked. Memories
already stored keep their group and expiry.

### `GET /api/events?space_id=home`

```sh
curl -N "http://127.0.0.1:8080/api/events?space_id=home"
```

| Event | Data | Sent when |
| --- | --- | --- |
| `memory` | `{"op": "created", "memory": Memory}` | A document is inserted into `memories`. |
| `memory` | `{"op": "updated", "memory": Memory}` | A memory document changes: seen again, superseded, forgotten or expired. |
| `audit` | `{"entry": AuditEntry}` | A document is inserted into `audit_events`. |
| `rules` | `{"rules": Rules}` | `PUT /api/rules` succeeds. |
| `frame` | `{"user_id", "ts", "image_url"}` | Any endpoint accepts an image. `image_url` is `<base>/api/frame/latest?user_id=..&t=..`. |
| `guide` | `{"user_id", "say", "matches"}` | Live guidance has something to say (`say` is not `null`). |

`memory` and `audit` events come from MongoDB change streams on those two
collections, so a document written by anything else (for example by hand in
Atlas) also shows up. A comment line (`: ping`) is sent every 15 seconds. The
`space_id` is not checked; an unknown one gives a stream with no events. A
client that falls more than 256 events behind misses the ones in between.

### `GET /api/health`

```sh
curl http://127.0.0.1:8080/api/health
```

### `GET /api/frame/latest?user_id=u_resident`

```sh
curl -o latest.jpg "http://127.0.0.1:8080/api/frame/latest?user_id=u_resident"
```

The user's latest frame as `image/jpeg`, or `404` if there is none. Frames are
dropped when the user changes space or sends nothing for 10 minutes.

### `POST /api/ingest/frame` and `POST /api/ingest/utterance`

Older endpoints, kept for clients that push frames and transcripts separately.
They reply `202` (accepted, not yet processed) or `400` with a plain-text
reason. They give no live guidance. An unknown space or a user who is not one
of its members gets `404`. `space_id` may also be sent as `venue_id`.

```sh
# Multipart: text fields plus the image as a file part under any name.
curl -X POST http://127.0.0.1:8080/api/ingest/frame \
  -F user_id=u_resident -F space_id=home -F frame=@frame.jpg

# Or the JPEG as the raw body, with the ids in the query string.
curl -X POST -H 'Content-Type: image/jpeg' --data-binary @frame.jpg \
  "http://127.0.0.1:8080/api/ingest/frame?user_id=u_resident&space_id=home"

curl -X POST -H 'Content-Type: application/json' \
  -d '{"text":"Putting my keys in my left coat pocket.","user_id":"u_resident","space_id":"home"}' \
  http://127.0.0.1:8080/api/ingest/utterance
```

Optional on both: `session_id`. Optional on frames: `mentra_request_id`, which
is copied to the `observations` row.

### `GET /health` and `GET /stats`

```sh
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/stats
```

```json
{
  "extraction_enabled": true,
  "frames_in": 42,
  "utterances_in": 3,
  "gate": { "checks": 30, "skipped_no_change": 24, "triggers_visual": 5, "triggers_speech": 1 },
  "observations_logged": 6,
  "memories": { "added": 7, "reinforced": 4, "superseded": 1, "views": 5 },
  "failed": 0,
  "queries_denied": 1,
  "live_guidance": { "frames": 20, "avg_ms": 400 },
  "avg_ms": { "extract": 1900, "embed": 300, "store": 120 }
}
```

The numbers only show the shape. Counters start at zero on each run.

## How a turn is classified

`POST /api/turn` sorts the text with fixed word rules, not a model. The first
rule that matches applies.

| # | The text | Treated as |
| --- | --- | --- |
| 1 | Has no letters or digits | nothing: `ignored`, empty reply |
| 2 | First word is `forget`, or it contains `please forget` | forget |
| 3 | Ends with `?`, or its first word is one of: where, what, which, who, how, when, why, is, are, do, does, did, can, could, would, will, tell, show, find, guide, help, any, take; or it starts with "I want to go", "I need to find", "I'm looking for" or "I am looking for" | question |
| 4 | Anything else | note |

**Note.** The text, with the turn's picture if one was sent, goes through
extraction, the rules, embedding and the reconciler before the reply.
`kind: "saved"` with `reply_text` "Saved. " plus the first item's summary and
the ids of every memory touched; or `kind: "ignored"` ("I didn't catch anything
to remember in that.") when the model found nothing.

**Question.**

1. The question is embedded and run through Atlas Vector Search with the filter
   "this space, active, and readable by this user" (see Rules). The filter runs
   inside the search, so a memory the user may not see never reaches the model.
   The 5 closest results that are not stored views are kept.
2. If the turn has a picture, the picture is embedded and searched at the same
   time. The closest stored view with a score of at least `GUIDE_MIN_SCORE` is
   given to the model as "you are here", so it can answer "where am I" and give
   directions from that spot. Without it, the model is told to answer with the
   item's `location` and not with steps or clock directions.
3. If there is anything to answer from, Gemini answers from it alone in one or
   two sentences. If it finds an answer: `kind: "answer"`, `memory_ids` are the
   memories it used (this can include the view), and a `query_answered` audit
   row is written.
4. Otherwise the service checks whether the question names an item that exists
   but is hidden from this user (an active memory they do not own, in a group
   their role cannot see). If so: `kind: "denied"`, "Sorry, I can't share that
   with you.", empty `memory_ids`, and a `query_denied` audit row that holds the
   hidden memory's id.
5. Otherwise: `kind: "answer"`, "I don't have anything about that yet.", empty
   `memory_ids`, no audit row.

**Forget.** Every active memory the user owns whose item is named in the text is
marked `forgotten` (see `memories` below), with one `memory_forgotten` audit row
each: `kind: "forgot"` with their ids. If the text names only an item owned by
someone else: `kind: "denied"` ("Sorry, I can't forget that. It belongs to
someone else."), nothing is written. If it names nothing known: `kind: "ignored"`.

"Names an item" (in the hidden-item check and in forget) compares words in the
text with the words of the memory's `item_key`, ignoring a final "s", words
under three letters and a list of general words (the, your, house, room, left,
...; `GENERIC` in `src/api.rs`). "Forget my keys" matches `house_keys` and also `car_keys`.

A memory written a moment ago can take a second or two to appear in vector search.

## Live guidance

`POST /api/frames` without `index` answers "what is already remembered about
this view":

1. The frame is shrunk to at most 768 px and embedded on its own with Voyage.
2. Atlas Vector Search returns the 8 closest active memories in the space that
   this user may read (same filter as a question). Stored views are among them.
3. Results with a score under `GUIDE_MIN_SCORE` are dropped. The rest are
   returned in `matches`, closest first.
4. `say` is built from up to two parts:
   - the closest hazard, as "Careful. " plus its summary;
   - then, if a stored view matched, the closest view's description: where the
     person is and what is around, in steps and clock positions. If no view
     matched, the closest thing that is not a hazard: its name, then how to
     reach it by touch (its `tactile_anchor`, or its summary when there is none).

   A hazard or a thing is not said to the same user again within
   `GUIDE_REPEAT_SECS`. A view description is said once per area name in that time.

No extraction model is called, so nothing new is learned in this path: it only
finds what was indexed earlier, by a note, the change gate, or a walk-through
indexed with `scripts/replay.sh`. Nothing is written to MongoDB. The "already
said" list is per user, in memory, and is lost on restart or after 10 idle minutes.

## Change gate

Each `user_id` has one session in memory: the latest frame, the hash of the last
indexed frame, and speech from `/api/ingest/utterance` from the last 30 seconds.
Every `GATE_TICK_MS` the gate looks at each session and starts indexing only if
one of these holds:

- **New view.** A frame has arrived since the last indexed one, more than
  `PHASH_THRESHOLD` of its 64 hash bits differ from the last indexed frame (the
  first frame of a session always counts), its sharpness is at least
  `MIN_SHARPNESS`, and `INDEX_LIVE_FRAMES` is not `false`. The hash is a 64-bit
  difference hash of a small grayscale copy; sharpness is the variance of the
  Laplacian. Recorded as `visual_change`.
- **Spoken note.** An utterance contains one of a fixed list of words about
  placing things, belongings, fixtures and hazards (put, left, moved, keys,
  wallet, pills, kettle, door, stairs, drawer, wet, careful, ...), does not end
  with `?`, and does not start with a question or command word (where, what,
  can, please, find, forget, ...). Both lists are in `src/gate.rs`; they are
  separate from the turn rules above. Recorded as `speech_keyword`.

A new view is indexed with its frame. A spoken note is indexed with the current
frame only if that frame arrived in the last 3 seconds, otherwise as text alone.
Several notes waiting at the same tick are joined. Other speech is dropped after
30 seconds. Questions sent to `/api/ingest/utterance` are never answered; use
`/api/turn`.

If neither holds, no model is called and nothing is written. One capture per
user is processed at a time. The gate looks at frames from every endpoint; a
frame already indexed by a note turn or by `"index": true` is not indexed again.
Sending a different space for a user clears that user's frame and pending
speech.

If a gate capture fails (for example a Gemini or Voyage error), no
`observations` row is written and `failed` goes up in `/stats`. After a 5 second
pause the same view can trigger again, and the note is retried until it is 30
seconds old.

## Rules: group and expiry

Each `spaces` document carries its own `members` (`id`, `name`, `role`) and
`rules`. The service reads them on every request and every capture, with no
cache, so an edit to the document takes effect at once.

```json
{
  "roles":  { "caregiver": { "can_see": ["care", "supplies", "house_guide"] } },
  "topics": { "medication": { "group": "care", "keep_for": "30d" } },
  "default_group": "resident_only"
}
```

**Who can read a memory.** A user can read a memory if they own it
(`owner_id`), or their role's `can_see` lists the memory's `group`, or lists
`"*"`. A user with no role in the space reads only what they own. This filter
is applied in three places: the vector search for questions and live guidance,
the list of remembered items shown to the extraction model, and the
hidden-item check behind `denied`. `GET /api/state` is not filtered.

**Which group a new memory gets.** The extraction model only names a topic,
chosen from the topic names in the space's rules. Then:

1. If the topic is in `rules.topics`, the memory gets that topic and its
   `group`. Otherwise it gets topic `other` and `default_group`.
2. If the model flagged the item as personal (`contains_pii`: a person, a face,
   an identity or bank document, mail, a screen) and the group from step 1 can
   be seen by every role, the memory goes to `default_group` instead.

The group is stored on the memory and is not changed afterwards.
`policy_decision.reason` on the memory says which rule applied.

**When it expires.** `expires_at` is now plus the topic's `keep_for` (`10s`,
`30m`, `2h`, `30d`, `2w`), or `null` when `keep_for` is `null` or the topic is
`other`. In a space with `mode: "temporary_stay"`, the space's
`default_expires_at` also applies; if both apply, the sooner one.

**Pictures and spoken text.** A frame shows everything in view and a sentence
can mention several things, so one memory's picture or text could give away
another. An item gets the thumbnail (`image_url`), the spoken text
(`transcript_snippet`), and the frame and text in its embedding only if every
role that can see that item's group can also see the group of every other item
found in the same capture. The other items are embedded from their summary and
tactile anchor alone. An item flagged `contains_pii` never gets the
picture, in the memory or in its embedding.

Example with the seed rules: a frame shows house keys (`resident_only`, one
role) and a kettle (`house_guide`, three roles). The keys memory gets the
thumbnail; the kettle memory gets none.

## What is read and written in MongoDB

### `spaces`

Read: `_id`, `mode`, `members`, `rules`, `default_expires_at`. `name` and
`owner_id` are not used. Written only by `PUT /api/rules`, which sets `rules`.
The service never creates or deletes a space.

### `memories`

**Reconcile.** For each extracted item the service looks for the current
memory, an `active` document with the same `space_id` and `item_key`:

- If the item's group is the space's `default_group` (the owner-only one): in
  that group and with the same `owner_id`. A sighting filed there never changes
  someone else's memory.
- Otherwise: in any group other than `default_group`, whoever owns it. The same
  thing filed under two shared topics on two occasions stays one memory, and
  keeps the topic and group it was first stored with until it is superseded.

Whether the thing moved is judged by the extraction model. It is shown the
active memories the user can read (up to 100, most recently updated first,
without stored views, as `item_key: tactile_anchor`), asked to reuse those
keys, and asked to set `moved` when the thing is now somewhere else. There is
no similarity threshold.

| Case | What is written |
| --- | --- |
| No current memory | **Add**: a new `active` document, and a `memory_stored` audit row. |
| Current memory exists, and the model did not set `moved` or the `tactile_anchor` text is the same (ignoring case) | **Reinforce**: `reinforcement_count` + 1 and `updated_at` = now. If the memory already had an `expires_at` and the new sighting has one, it is moved forward to the new one, so a hazard seen again stays alive. No audit row. |
| Current memory exists and the model set `moved` | **Supersede**: a new `active` document with `previous_location` set to the old `location` (or `tactile_anchor`); the old one gets `status: "superseded"`, `superseded_by` = the new id and `updated_at` = now; and a `memory_superseded` audit row. |

If a sighting with topic `hazard` has an expiry and the current memory under
that key has none (a hazard reported under a permanent fixture's key), it is
stored under `<item_key>_hazard` instead, so it cannot replace the fixture or
put an expiry on it.

Each memory change and its audit row are one transaction, retried up to three
times on a transient error. If the current memory stopped being `active` in the
meantime, that item fails and nothing is written for it. One item failing does
not stop the others from the same capture.

**Fields of a new item memory.**

| Field | Value |
| --- | --- |
| `_id` | `m_` followed by 24 hex characters |
| `space_id`, `owner_id` | From the request. `owner_id` is the user who sent the capture. |
| `item_key` | The model's key, normalised to lowercase letters, digits and underscores |
| `item` | `item_key` with underscores replaced by spaces |
| `summary`, `location`, `tactile_anchor` | From the model. `location` and `tactile_anchor` may be `null`. |
| `topic`, `group`, `expires_at` | From the rules (above) |
| `source` | `camera` (frame only), `both` (frame and text) or `voice` (text only) |
| `status` | `active` |
| `superseded_by`, `purge_at` | `null` |
| `created_at`, `updated_at` | Now |
| `image_url` | `data:image/jpeg;base64,...` thumbnail, at most 200 px, or `null` (see "Pictures and spoken text") |
| `transcript_snippet` | The spoken text, at most 2000 characters, or `null` (same rule) |
| `policy_decision` | `topic`, `group`, `reason`, `checked_at`, and `pii_redacted`: `true` when there was a frame but no picture was stored on this memory |
| `reinforcement_count` | `1` |
| `previous_location` | Set on a supersede, otherwise `null` |
| `bbox` | `[ymin, xmin, ymax, xmax]` on a 0 to 1000 scale, or `null`. Only with a frame. |
| `embedding` | 1024 numbers from Voyage |

The schema fields `missing_since`, `speaker`, `stt_confidence`,
`source_observation_id` and `frame_thumb_b64` are never set by this service.

**Views.** A frame sent with `"index": true` also stores one memory that
describes the view from that spot. Live guidance says it, and a question with a
picture uses it as "you are here". It is stored only when the model returned a
description, and nothing found in the frame is flagged `contains_pii` or is in a
group that fewer roles can see than the view's group. Frames indexed by the
change gate and note turns store no view.

| Field | Value |
| --- | --- |
| `item_key` | `view_` followed by the time in milliseconds, in hex |
| `item`, `location` | The model's short name for the area, for example "reception area by the entrance". Without one, `item` is "view of the space" and `location` is `null`. |
| `summary`, `tactile_anchor` | The model's description of what is around, in steps and clock positions |
| `topic`, `group`, `expires_at` | What the rules give for the topic `house_guide`. The topic name is fixed in the code; in a space without it the view gets `other` and `default_group`. |
| `source`, `status` | `camera`, `active` |
| `image_url` | The thumbnail of the frame |
| `embedding` | Of the area name, the description and the frame together |
| `policy_decision`, `reinforcement_count`, `superseded_by`, `purge_at`, dates | As for an item memory; `pii_redacted` is `false` |

A view has no `previous_location`, `transcript_snippet` or `bbox`. Views are not
reconciled: every indexed frame that qualifies adds a new one. A view gets no
audit row and is not in the `indexed` reply or in the observation's
`memory_ids`; `/stats` counts them under `memories.views`. Views are left
out of `GET /api/state` unless the request adds `&views=true`, and are never
sent as `memory` events, so one per indexed frame does not flood the dashboard. Expiry applies to views as to any memory. An item key from the model
that starts with `view_` is dropped.

**Forgetting and expiry.** "Forget" marks the memory `forgotten`. A background
sweeper runs every 15 seconds and marks every `active` memory whose `expires_at`
has passed as `expired` (up to 200 per run), with a `memory_expired` audit row
each. In both cases, in one transaction with the audit rows:

- `status`, `updated_at` and `purge_at` (now + 10 minutes) are set;
- `embedding`, `image_url`, `frame_thumb_b64` and `transcript_snippet` are
  removed;
- for "forget", the words go too: `summary` becomes "Forgotten at the owner's
  request." and `location`, `tactile_anchor`, `previous_location` and `bbox`
  are removed. An expired memory keeps its words until the document is deleted.

The memory can no longer be found by search (search only returns `active`) but
is still listed by `GET /api/state` until MongoDB's TTL index on `purge_at`
deletes it. The service itself never deletes a memory. Superseded memories are
kept, with their embedding, and have no `purge_at`.

**Reads.** Vector search uses the index `memories_multimodal_vec` with filters
on `space_id`, `status`, `group` and `owner_id`. Other reads: the reconciler
lookup, the remembered-items list, the user's own active memories (forget), the
hidden-item check, the expiry sweep, the list for `GET /api/state`, and a change
stream.

### `audit_events`

Every row has `_id` (`a_` + 24 hex characters), `ts`, `space_id`, `actor_id`,
`action`, `verdict`, `detail` (a sentence), `memory_ids` and `query_text`
(backend-only, at most 2000 characters, or `null`).

| `action` | `verdict` | `actor_id` | `memory_ids` | `query_text` | Written when |
| --- | --- | --- | --- | --- | --- |
| `memory_stored` | `info` | the user | the new memory | `null` | A memory is added |
| `memory_superseded` | `info` | the user | the new memory, then the old one | `null` | A memory is replaced because the item moved |
| `memory_forgotten` | `info` | the user | the memory | the turn's text | One per memory forgotten |
| `memory_expired` | `info` | `system` | the memory | `null` | One per memory the sweeper expires |
| `query_answered` | `allowed` | the user | the memories the answer used | the question | A question is answered from memories |
| `query_denied` | `denied` | the user | the hidden memory | the question | A question names an item hidden from the asker |
| `rule_changed` | `info` | `dashboard` | empty | `null` | `PUT /api/rules` |

No row is written for a re-sighting, a stored view, a question with no answer,
a forget that is denied or matches nothing, or live guidance.

### `observations`

One row per capture that went through indexing (a gate trigger, a note turn, or
a frame with `"index": true`), written after its memories. Questions, forgets
and live-guidance frames write no row.

| Field | Value |
| --- | --- |
| `type` | `turn` when there was text, otherwise `frame` |
| `space_id`, `user_id`, `ts` | The capture; `ts` is when processing started |
| `session_id` | `<user_id>-turns` for a note turn, `<user_id>-index` for `"index": true`; for the gate, the session id sent to the ingest endpoints or `<user_id>-<first request time in ms>` |
| `gate_reason` | `visual_change`, `speech_keyword` or `manual` (note turn or `"index": true`) |
| `phash_distance` | Hash bits changed from the last indexed frame; `null` for a first frame and when the gate saw no new view |
| `text`, `heard_text` | The spoken text (at most 2000 characters), or `null` |
| `input_used` | `text` when there was text, otherwise `null` |
| `kind` | Always `null` |
| `memory_ids` | The item memories added, reinforced or replaced (not a stored view) |
| `mentra_request_id` | From `/api/ingest/frame`, otherwise `null` |
| `expires_at` | Now + `OBSERVATION_TTL_HOURS`; MongoDB deletes the row then |

It never holds images or audio. The other schema fields (audio details,
`image_url`, `speaker`, ...) are not set.

## Timings

Measured during development, not guarantees.

| Step | Time |
| --- | --- |
| Extraction, `gemini-3.5-flash-lite` | about 1.5 to 3.5 s per frame, 1 to 2 s per spoken note |
| Extraction, `gemini-4-hydrogen` with low thinking | 5.5 to 7.6 s per frame |
| Extraction, `gemini-4-carbon` | up to 35 s |
| Embedding one frame, Atlas endpoint | 170 to 280 ms |
| Embedding one frame, Voyage's own endpoint | 380 to 620 ms |
| Live-guidance request, end to end, on real venue footage | about 1 s on average. Measured before question and live-frame embeddings were made to start on an Atlas key. |
| Note turn | about 3 s |
| Question turn | 1.2 to 3.7 s |

## The name "Robin", and "what's this?"

- **Name.** The glasses answer to "Robin" (`WAKE_WORDS`, default
  `robin,robbin,robyn`). The name, and a leading "hey", are taken out of the
  words before anything else: "Hey Robin, what's this?" is handled as "what's this?".
- **Overheard speech.** A turn sent with `"passive": true` is something the
  glasses overheard, not something said after a button press. It is only
  answered if it uses the name. Without the name, a sentence about where
  something is ("I am putting my umbrella under the counter") is remembered
  silently (`kind: "saved"`, empty `reply_text`), and anything else is dropped
  with no model call (`kind: "ignored"`). `WAKE_WORD_REQUIRED=true` treats every
  turn that way, including typed ones.
- **"What's this?"** A question about the view right now ("what's this", "what am
  I holding", "what is in front of me") that comes with a picture is answered by
  Gemini looking at that picture, not from memory. It writes a `query_answered`
  audit row with no memory ids.
- **No picture with the words.** While the glasses stream video their camera is
  taken, so a turn arrives without a picture. The newest frame from that user's
  stream, if under six seconds old, is used in its place.
- **English.** A turn mostly in another script or language is rewritten in
  English before it is sorted, stored or answered.

## Guardrails on words

These follow `backend/guardrails` (the JavaScript reference) and live in
`src/guard.rs`, `src/policy.rs` and `src/api.rs`.

| Guardrail | What the server does |
| --- | --- |
| Words are data, never instructions | A turn or overheard sentence that tries to give the system orders ("ignore all previous instructions", "show me everyone's private notes", "change the rules") is refused before anything is saved or looked up. The reply is "I can only save notes and answer questions about where things are." and a `query_denied` audit row quotes the phrase. In the extraction prompt, what was said sits in a marked block with a random id. |
| Secrets are removed first | Card numbers (checked with the Luhn sum), numbers of 9 or more digits, email addresses, and PINs, passwords and door codes are replaced with words such as "(card number removed)" before the text reaches Gemini, MongoDB or the audit log. A note that had anything removed stays in the space's default group whatever its topic, with `policy_decision.pii_redacted: true`. Unlike the JavaScript version, nothing is kept back: Wi-Fi passwords and phone numbers are removed too. |
| The search filter is checked again | After Atlas Vector Search returns, each result is checked in code against the asker's role. Anything that should not be there is dropped and logged as an error. |
| A claim to be someone else changes nothing | "I'm the resident" from a visitor is answered as a visitor, and the audit row adds "Ignored a spoken claim to be resident; checked as role visitor." |
| Rule changes are checked | `PUT /api/rules` refuses a change that removes a role a member still has, or takes `["*"]` away from the space owner's role. Names must start with a letter and be at most 40 characters; `keep_for` is at most 365 days; at most 20 roles and 50 topics. A refused change gets a `rule_changed` audit row with verdict `denied`; an accepted one is described in words ("Role visitor can now see supplies."). |
| Photo links are fetched safely | `image_url` must be https on the default port with no credentials, and its host must not resolve to a private, loopback or link-local address. At most 3 redirects, 5 seconds, 8 MB, and the reply must start like a JPEG or PNG. `ALLOW_LOCAL_IMAGE_URLS=true` relaxes this for local testing only. Unlike the JavaScript version, the connection is not pinned to the address that was checked. |
| What gets spoken is checked | Every answer and every piece of live guidance has sentences removed that claim something is safe or clear ("the path is clear"); if nothing is left the reply is "I can't confirm that. Please check with your cane or ask someone nearby." An answer about medicine loses any advice on taking it and ends with "Please check the label before taking anything." Replies are capped at 400 characters. |
| Forgetting is recorded either way | A forget request writes one `memory_forgotten` row (verdict `allowed`). Asking to forget someone else's memory writes `query_denied`; a request that matches nothing writes `query_answered` with verdict `info`. |

The dashboard's optional contract fields are served too: `GET /api/state`
includes `frames` (each user's latest frame) and `latest_turn`, and every turn
is sent as a `turn` event on `GET /api/events`.

Not ported: saying how old a memory is and who noted it, hedging a weak match,
stopping guidance when the camera feed drops, speaker labels (a note said by someone other than the wearer),
because no speaker information reaches this service, and the confirmation step
before forgetting several memories at once.

## Hosting it for a demo

MongoDB Atlas hosts the database only: the collections, Vector Search and the
change streams. This server and the web app run somewhere else. The server can
serve the web app itself, so one address covers the dashboard, the capture page
and the API.

1. Build the web app so that it calls the address it was loaded from:

   ```sh
   cd frontend/web
   npm install
   VITE_API_BASE=. npm run build
   ```

2. Start the server from `pipeline/`. It serves `../frontend/web/dist` when that
   folder exists (`WEB_DIR` points it elsewhere) and logs `web_app=true`:

   ```sh
   cd pipeline
   cargo run --release
   ```

3. Open `http://localhost:8080/?space=venue` for the dashboard and
   `http://localhost:8080/capture?space=venue` for the capture page. The web app
   opens the space `hotel` when no `space` is given, and that space is not in
   the database, so name one that is (`home`, `venue`).

4. For a public HTTPS link (phone browsers only allow the camera and microphone
   on HTTPS), put a tunnel in front of port 8080:

   ```sh
   brew install cloudflared
   cloudflared tunnel --url http://localhost:8080
   ```

   Share the `https://....trycloudflare.com` address it prints, with
   `/?space=venue` on the end. The link works for as long as this machine, the
   server and the tunnel keep running.

## Not built

- Speech-to-text. A turn that carries only `audio` gets `415`; send the transcript in `text`.
- Voice output. `audio_url` is always `null`, so clients use their own text-to-speech.
- The step-by-step "guide me" loop. "Guide me to the kettle" is answered once, as a question.
- Live video or WebRTC stream ingest in the server. Input is JPEG frames and text; `scripts/live.sh` samples frames from a file or stream with ffmpeg and posts them.
- A role-filtered state. `GET /api/state` returns every memory in the space.
- A live event when MongoDB deletes a purged memory; the dashboard drops it on its next reload.
- Authentication. `user_id` is trusted as sent.
