# 03 — Features in Detail & Continuous ElevenLabs Navigation

## Feature 1: Fused Camera + Microphone Memory
Cameras alone fail whenever an item goes out of line-of-sight (pockets, bags, closed drawers, cupboards). Our ingest handles **three input modes seamlessly**:
1. **Silent Visual Sighting (Camera only):** Glasses pan past the kitchen counter and spot `ibuprofen_bottle` left of the kettle → indexed via `voyage-multimodal-3.5` + Gemini tactile anchor.
2. **Pure Voice / Overheard Memory (Mic only):**
   - Self-note: *"Keys in my left jacket pocket"* or *"Passport in the top desk drawer."*
   - Overheard sighted helper (family, carer, co-worker): *"I put your new pills in the top cupboard"* or *"Clean towels are in the bottom bathroom cabinet."*
   - Saved into the **exact same `memories` collection** (`source_modality: "voice"`), embedded with `voyage-multimodal-3.5` (which natively embeds pure text into the same 1024-d vector space as images!).
3. **Fused Multimodal Observation (Camera + Voice together):** User looks at a doorway while saying *"Careful, single step down into the garage"* → stores both the visual doorway vector and spoken hazard warning in one shared space memory.

---

## Feature 2: Automatic Shared Space vs. Private Governance
Every incoming memory passes through a deterministic + LLM **Policy Gate** before hitting MongoDB. "Shared" is stored as `visibility: "public"` and means *everyone who belongs to this space*, not the world:

| Detected Observation | Visibility Assigned | Why / Policy Rule |
| --- | --- | --- |
| Doors, stairs, light switches, wall outlets, appliances, counters, thermostat | `🟢 shared` | Permanent layout of the space, useful to everyone who uses it; stripped of any faces or names. |
| *"Floor is wet, I just mopped"*, *"Bag left on the stairs"*, *"Dishwasher door is open"* | `🟢 shared` (`TTL = 2h`) | Short-lived hazard that everyone should know about; auto-expires in 2 hours. |
| Wallet, keys, phone, bag, laptop, cane | `🔒 private` (`owner_id`) | Personal property — locked strictly to owner, even from other people in the same space. |
| Prescriptions, IDs, mail, bank cards, pocket/bag voice notes | `🔒 private` (`owner_id`) | Sensitive PII/health — quarantined; raw frame thumbnail optionally omitted or blurred. |
| **Temporary Stay Mode (`space_mode: "temporary_stay"`)** | **All `🔒 private` + `TTL = end of stay`** | Staying in a guest room, hotel, or respite facility: sharing is auto-disabled and every memory self-destructs when the stay ends. |

The same table applies unchanged in every space the user moves through (home, office, care home, hotel): only the space and its members differ.

---

## Feature 3: Voice Memory Controls (*"Forget"*, *"I'm Staying At"*, *"What Changed?"*)
Users manage governance completely hands-free by voice:
- **"I'm staying in Mum's guest room until tomorrow 11 AM"** → Creates a scoped `spaces` entry; every scan in that space inherits `expires_at = tomorrow 11:00 AM` and `visibility = "private"`.
- **"Forget my prescriptions" / "Clear everything from the last 5 minutes"** → Soft/hard deletes matching `owner_id` records in `memories` and appends a `memory_forgotten_by_user` receipt to `audit_events`.
- **"What moved on this counter?"** → Queries recent `superseded` + `active` transitions in the current space (*"The kettle moved from left of the sink to beside the toaster 4 minutes ago"*). Useful after someone else has tidied up or rearranged things.

---

## Feature 4: 2-Stage Step-by-Step Navigation Loop (ElevenLabs + Live Video)

When a blind user asks *"Help me find my keys"* or *"Guide me to the kettle"*, knowing the text answer isn't enough — they need **calm, real-time physical guidance that adapts as they turn and reach**.

```mermaid
sequenceDiagram
  participant User as Blind User (Mentra Live)
  participant Backend as FastAPI Guidance State Machine
  participant DB as MongoDB Atlas ($vectorSearch)
  participant Vision as Voyage 3.5 + Gemini 4
  participant TTS as ElevenLabs Flash v2.5

  User->>Backend: "Guide me to my wallet"
  Backend->>DB: $vectorSearch (public + owner_id=User)
  DB-->>Backend: Active memory (anchor: "right of MacBook cable on desk", ref_vec, ref_thumb)
  Backend->>TTS: Stage 1 Coarse Cue: "On the wooden desk right of your laptop cable. Turn slowly right."
  TTS-->>User: Speaks in <1.0s

  loop Every 1.0s while Guidance Active (max 45s or until "Stop" / Found)
    User->>Backend: latest_frame from WHIP stream
    Backend->>Vision: Compare latest_frame vs ref_vec + check target/hand clock position
    alt Turning toward landmark (similarity rising 0.35 -> 0.72)
      Backend->>TTS: "Keep turning right... stop, desk straight ahead, 2 steps."
    else Target visible within arm's reach
      Backend->>TTS: "1 o'clock... reach forward 6 inches... right there."
    else Arrived at landmark, but target is GONE!
      Backend->>DB: Update memory status="missing", log audit_event
      Backend->>TTS: "Hold on — the desk is here, but your wallet was moved. Checking newer notes..."
    end
  end
```

### Anti-Chatter Rules (Critical for Blind UX & Clean Stage Demos)
1. **Speak only on state transitions:** Store `last_spoken_bucket` (`TURN_RIGHT`, `STRAIGHT_AHEAD`, `REACH_1_OCLOCK`, `FOUND`, `MISSING`) and enforce a **2.2-second minimum cooldown** between non-urgent cues so ElevenLabs never talks over itself.
2. **Tactile + Clock-Face Language Only:** System prompt bans visual-only words (*"blue", "shiny", "over there"*). Every cue uses **clock positions** (`10 o'clock`, `straight ahead at 12`), **step/inch estimates**, and **touchable reference objects** (*"feel the edge of the laptop, slide 4 inches right"*).
3. **Instant Barge-In:** Any spoken `"stop"`, `"got it"`, or new question immediately cancels the active guidance loop and clears the audio queue.
