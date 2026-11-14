# API contract: frontend ↔ backend

Status: proposed by the frontend side. The backend owner should confirm or change it.
The frontend keeps every call in one module, so changes here are cheap.

## Conventions

- Base URL is configurable (`API_BASE`), for example `https://example.trycloudflare.com`.
- JSON in and out, UTF-8. Times are ISO 8601 UTC strings.
- No auth for the hackathon. `user_id` is trusted as sent.
- CORS: allow any origin, methods `GET, POST, PUT, OPTIONS`, header `Content-Type`.
- Errors: non-2xx status with `{ "error": "message" }`.
- The phone and the glasses call these endpoints too, so the server must be reachable over HTTPS (a tunnel is fine).

## Objects

### User

```json
{ "id": "u_caregiver", "name": "Caregiver", "role": "caregiver" }
```

### Rules

One document per space. Topics map to groups, and roles list the groups they can see.

```json
{
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
}
```

Visibility rule, enforced by the backend: a user can see a memory if they own it, or their
role's `can_see` contains the memory's `group` or `"*"`. Anything without a matching topic
gets `default_group`, so new memories are private unless a rule shares them.

### Memory

```json
{
  "id": "m_01",
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
  "created_at": "2026-11-14T17:02:11Z",
  "updated_at": "2026-11-14T17:02:11Z",
  "expires_at": null,
  "image_url": null
}
```

- `source`: `"camera" | "voice" | "both"`
- `status`: `"active" | "superseded" | "forgotten" | "expired"`
- `superseded_by`: id of the memory that replaced this one, or `null`
- `image_url`: absolute URL of a small keyframe, or `null`

### AuditEntry

```json
{
  "id": "a_01",
  "ts": "2026-11-14T17:05:40Z",
  "space_id": "home",
  "actor_id": "u_visitor",
  "action": "query_denied",
  "verdict": "denied",
  "detail": "Asked about house keys. Group resident_only is not visible to role visitor.",
  "memory_ids": ["m_01"]
}
```

- `action`: `memory_stored | memory_superseded | memory_forgotten | memory_expired | query_answered | query_denied | rule_changed`
- `verdict`: `"allowed" | "denied" | "info"`

## Endpoints

### 1. `GET /api/state?space_id=home`

Snapshot for the dashboard. This is the admin view: it returns every memory in the space,
not filtered by role.

```json
{
  "space_id": "home",
  "users": [ /* User */ ],
  "rules": { /* Rules */ },
  "memories": [ /* Memory, newest first */ ],
  "audit": [ /* AuditEntry, newest first, last 200 */ ]
}
```

### 2. `POST /api/turn`

One spoken or typed turn from a user. The backend decides whether it is a note to remember,
a question, or a command such as "forget my keys".

Request:

```json
{
  "space_id": "home",
  "user_id": "u_resident",
  "ts": "2026-11-14T17:02:10Z",
  "text": "I'm putting my keys in my left jacket pocket",
  "audio": null,
  "image_b64": null,
  "image_url": null
}
```

- `text`: the client's own transcript, or `null` when the client sends audio only.
- `audio`: the recorded utterance, or `null`. See below.
- At least one of `text` and `audio` is set. When both are set, the backend chooses which to use.
- `image_b64`: optional JPEG, base64 without a `data:` prefix. Sent by the browser capture page
  (about 640 px wide, under 200 KB).
- `image_url`: optional. Sent by the glasses app. It is a signed URL that expires in about
  30 minutes, so download it straight away.
- At most one of the two image fields is set. Both may be `null`.

#### Audio

Each client has a setting, "Send: text, audio or both". The default is text. Audio is recorded
only between the button press and the end of the utterance, never continuously, to save
battery. It arrives as one piece with the turn, not as a live stream.

```json
"audio": {
  "format": "wav",
  "sample_rate": 16000,
  "channels": 1,
  "data_b64": "..."
}
```

- `format`:
  - `"wav"`: 16-bit PCM in a WAV container. Sent by the browser capture page.
  - `"pcm_s16le"`: 16-bit little-endian PCM with no header. Sent by the glasses app.
  - Anything else is passed through as the glasses SDK reported it (for example `"lc3"`).
    The backend may reject a format it cannot read with 415 and `{ "error": "..." }`.
- `sample_rate`: in Hz, or `null` when the glasses SDK did not report it.
- `channels`: always 1.
- `data_b64`: the audio bytes, base64 without a `data:` prefix.
- An utterance is capped at 25 seconds. At 16 kHz that is about 800 KB of audio, or about
  1.1 MB as base64, so the request body limit must allow at least 2 MB.

Response:

```json
{
  "kind": "saved",
  "reply_text": "Saved. Keys are in your left jacket pocket.",
  "audio_url": "https://example.trycloudflare.com/audio/r_01.mp3",
  "memory_ids": ["m_01"],
  "heard_text": "I'm putting my keys in my left jacket pocket",
  "input_used": "text"
}
```

- `kind`: `"saved" | "answer" | "denied" | "forgot" | "ignored"`
- `audio_url`: absolute URL of an MP3 of `reply_text`, or `null`. Clients fall back to their own
  text-to-speech when it is `null`.
- `heard_text`: the words the backend acted on (its own transcript when it used the audio), or
  `null`. Optional. Clients show it so an audio-only turn is still readable.
- `input_used`: `"text" | "audio" | null`. Optional.
- Clients wait up to 15 seconds. Aim for under 3.

### 3. `POST /api/frames`

A camera frame with no speech attached. The backend must keep the latest one per user and emit
a `frame` event. Indexing it is optional.

```json
{ "space_id": "home", "user_id": "u_resident", "ts": "2026-11-14T17:02:12Z", "image_b64": "...", "image_url": null }
```

Response: `{ "ok": true }`

### 4. `PUT /api/rules?space_id=home`

Body is a full Rules document. Response: `{ "ok": true, "rules": { /* Rules */ } }`.
Emits a `rules` event and an audit entry with action `rule_changed`.

### 5. `GET /api/events?space_id=home`

Server-sent events (`text/event-stream`). Send a comment line (`: ping`) every 15 seconds.

| Event | Data |
| --- | --- |
| `memory` | `{ "op": "created" \| "updated", "memory": Memory }` |
| `audit` | `{ "entry": AuditEntry }` |
| `rules` | `{ "rules": Rules }` |
| `frame` | `{ "user_id": "u_resident", "ts": "...", "image_url": "https://..." }` |

`updated` covers a memory being superseded, forgotten or expired.

## Clarifications

Building the frontend and the mock raised these questions. The answers below are what the mock
does. The backend owner can change any of them; the frontend only depends on the first six.

1. `location` may be `null`.
2. A turn's image also becomes that user's latest frame, and a `frame` event is emitted.
3. Never pass the glasses' signed `image_url` on to clients. Download it and serve your own copy
   in `frame` events and in `Memory.image_url`.
4. `audio_url` must be reachable and playable from a phone, not only from the laptop.
5. `reply_text` may be empty (for example for `ignored`). Clients stay silent when there is
   neither text nor audio.
6. Unknown `user_id` or `space_id` returns 404 with `{ "error": "..." }`.
7. A question with no matching memory returns `kind: "answer"` with empty `memory_ids`.
8. A denied turn returns `memory_ids: []`. The ids go in the audit entry only.
9. A memory that matches no topic gets topic `"other"` and the `default_group`.
10. `keep_for` is a number followed by `s`, `m`, `h`, `d` or `w`, or `null`.
11. Only the owner can forget a memory.
12. Changing a topic's group does not regroup memories already stored. Changing a role's
    `can_see` takes effect on the next question.
13. Audit `actor_id` is `"dashboard"` for rule changes made there and `"system"` for expiry.
14. `ts` may or may not carry milliseconds. Accept both.

Not in the contract yet, but worth adding if there is time:

- `frames` in `GET /api/state` (latest frame per user), so a dashboard reload shows them
  without waiting for the next `frame` event.
- A small `GET /api/health`, so clients can test the connection without pulling the full state.

## Clients

| Client | Calls |
| --- | --- |
| Dashboard (browser) | `GET /api/state`, `GET /api/events`, `POST /api/turn`, `PUT /api/rules` |
| Capture page (browser, phone or laptop) | `GET /api/state`, `POST /api/turn`, `POST /api/frames` |
| Glasses app (Mentra miniapp) | `GET /api/state`, `POST /api/turn`, `POST /api/frames` |

A mock server that implements this contract with in-memory data lives in `frontend/mock-server`.
