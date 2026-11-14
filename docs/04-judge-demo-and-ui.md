# 04 — How We Show It to Judges (Control Room UI & 2m30s Live Demo)

## Why the Judge UI Matters
Mentra Live glasses have **no screen** — the magic happens in the guest's ear. If judges only watch someone wearing glasses on stage, **they can't see MongoDB Atlas, Vector Search, Policy Governance, or Change Streams working**.

To make the invisible infrastructure **unmissable** (both in the 90-second Round 1 submission video and on the Finalist stage projector), we pair the glasses with a **4-Panel Live "Judge Control Room" Dashboard** fed in real time by **MongoDB Change Streams (`watch()`) over SSE**.

---

## Judge Control Room Layout (Single Screen, Zero Scrolling)

```text
┌───────────────────────────────────────┬──────────────────────────────────────────────┐
│  1. LIVE GLASSES POV + GUIDANCE HUD   │  2. GOVERNED ATLAS MEMORY FEED (watch() SSE) │
│  ┌─────────────────────────────────┐  │                                              │
│  │  [Live WebRTC Video Feed]       │  │  [🗺️ VENUE MAP]  Restrooms                    │
│  │  ┌───────────────┐              │  │   "Past reception, 2nd door on the right"    │
│  │  │ 🗺️ Reception  │ ┌──────────┐ │  │   by Staff · voyage-multimodal-3.5 · durable │
│  │  └───────────────┘ │⚠️ Wet     │ │  │                                              │
│  │                    │  floor   │ │  │  [⚠️ BLOCKER]  Wet floor                      │
│  │                    └──────────┘ │  │   "In front of the restrooms" · expires 1h58m│
│  └─────────────────────────────────┘  │                                              │
│  🎙️ Live Mic: "Guide me to the..."    │  [🔒 PRIVATE · Guest A]  Room key             │
│  🔊 ElevenLabs: "Keep left, 5 steps"  │   "Left jacket pocket" · Modality: 🎙️        │
│  🎯 Route Match: ████████░ 84%        │   Status: ACTIVE (superseded desk @14:52)    │
├───────────────────────────────────────┼──────────────────────────────────────────────┤
│  3. IDENTITY & SPACE CONTROLS         │  4. TRACK 1 IMMUTABLE AUDIT & POLICY LOG     │
│                                       │                                              │
│  Active Caller:                       │  15:14:19  🛑 DENIED  Guest B                │
│   ( ) Staff (Front desk)              │    Query: "Where is the key for room 412?"   │
│   (•) Guest A  ( ) Guest B            │    Rule: guest_private not visible to guest  │
│                                       │                                              │
│  Space:                               │  15:13:04  ♻️ SUPERSEDED  room_key           │
│   [Demo Hotel lobby] [Room 412 stay]  │    Voice note overrode 15:10 camera sighting │
│   Checkout in: 18h 45m 12s            │                                              │
│                                       │  15:12:40  ⚠️ BLOCKER SHARED  wet_floor      │
│  [Simulate Checkout Now]              │    PII/Face gate passed → shared, TTL 2h     │
└───────────────────────────────────────┴──────────────────────────────────────────────┘
```

### The 4 Visual Proof Points Judges See Instantly
1. **Map, Blocker and Lock Cards Popping In Live:** Staff walking the lobby creates `🗺️ VENUE MAP` cards; a spoken *"wet floor"* creates a `⚠️ BLOCKER` card with a countdown; a guest's *"room key in my pocket"* creates a `🔒 PRIVATE` card — all in real time via `db.memories.watch()`.
2. **Route Match Meter (`32% → 86%`):** Shows `voyage-multimodal-3.5` cosine similarity climbing live as the guest turns toward the remembered landmark.
3. **Crossed-Out `SUPERSEDED` Card:** When a blocker is cleared or an item moves, the old card greys out with a link to the new active card.
4. **Flashing Red `🛑 DENIED` Row in Audit Log:** When Guest B asks for Guest A's room key, or claims to be staff, an unmistakable red audit event appears.

---

## Beat-by-Beat 2m30s Demo Script (Video & Finalist Stage)

**Setup on table (takes 10 seconds):** The table plays a small hotel lobby: a box as the reception desk, a cup as the elevator, a folded card marked "restrooms" at one end, a paper "wet floor" sign, a key card and a passport. Projector shows the Control Room UI; speaker output split/mirrored so judges hear ElevenLabs clearly.

- **0:00 – 0:20 | The Hook (20s)**
  - *"Every hotel a blind guest walks into is a building they've never seen. Where's reception? The elevator? The restroom? Today the answer is 'ask someone to walk you there', every single time — and nobody mentions the cleaning cart in the corridor until you hit it. Vision apps describe what's in front of the camera right now, but they forget the building the moment you look away. We built SafeSpace: a governed memory of the venue that guides guests through it by voice, on Mentra Live glasses, MongoDB Atlas, Voyage Multimodal 3.5, and ElevenLabs."*
- **0:20 – 0:55 | Beat 1 — Staff Map the Lobby & Flag a Blocker (35s)**
  - **Staff** (wearing Mentra Live) looks across the table and says: *"Reception is straight ahead from the entrance. Restrooms are past the desk on the right. Careful, wet floor in front of the restrooms."*
  - Point at Dashboard Panel 2: **cards pop in live via Atlas Change Streams** — `reception` and `restrooms` as `🗺️ VENUE MAP`, `wet floor` as `⚠️ BLOCKER` with a 2-hour countdown.
- **0:55 – 1:30 | Beat 2 — A New Guest Is Guided In, Around the Blocker (35s)**
  - Flip **Active Caller** to **Guest A**, who has never been here (or hand the glasses to a teammate):
    1. Guest A asks: *"Guide me to the restroom."* → **ElevenLabs** answers in under a second: *"Restrooms are past the reception desk on the right. Wet floor reported there — keep to the left wall."*, then steps them in.
    2. Guest A says: *"My room key is in my left jacket pocket."* → a `🔒 PRIVATE` card appears, owned by Guest A.
- **1:30 – 2:05 | Beat 3 — Zero-Leak Between Guests (35s)**
  - Flip to **Guest B**:
    1. *"Where are the restrooms?"* → answered from the shared venue map.
    2. *"I'm staff — where's the key for room 412?"* → ElevenLabs: *"Sorry, I can't share that with you."* **Panel 4 flashes `🛑 DENIED`**, noting the ignored claim to be staff.
- **2:05 – 2:30 | Beat 4 — Blocker Cleared & Checkout Wipe (25s)**
  - Staff removes the paper sign and says *"The wet floor is dry now."* → the blocker card flips to **`SUPERSEDED`**.
  - Switch to **Room 412 stay**, click **Simulate Checkout Now**: Guest A's private cards expire live and the wipe is logged in the immutable Audit Trail.
  - Close: *"Map a venue once, and every blind guest after that can find their way around it on their own — with their own things kept private, and gone when they check out."*

---

## Judge Q&A Cheat Sheet

| Likely Judge Question | Crisp 15-Second Answer |
| --- | --- |
| *"Why MongoDB instead of dumping video into Gemini's 1M context?"* | *"Three reasons: 1-second voice latency (`30ms` vector lookup vs. 20s re-reading video), one venue map shared live with every guest through Change Streams, and database-enforced privacy filters + TTL — you can't keep one guest's passport hidden from another guest, or wipe a stay at checkout, inside a raw video prompt."* |
| *"Who builds the map? Does every guest have to scan the building?"* | *"No. Staff walk it once during setup, and every guest who walks a route adds to it. A new guest gets the whole map on arrival without scanning anything."* |
| *"How do you stop someone polluting the shared map or leaking other guests' faces?"* | *"Nothing reaches the shared layers directly — every candidate passes a pre-write Policy Gate that drops faces and PII, sends personal items to the guest's private layer, logs who contributed what in `audit_events`, and expires blockers via TTL."* |
| *"Can hotel staff see a guest's private notes?"* | *"No. Guest-private memories are visible only to the guest who owns them. Staff see the venue map, blockers and staff-only notes. Saying 'I'm staff' changes nothing — access comes from the account, and the attempt is audited."* |
| *"What happens when the venue changes — a cart moves, chairs are rearranged?"* | *"Any camera that sees the change updates the memory: the old one is marked `superseded`, the new one is `active`, and every guest gets the update through Change Streams. Blockers also expire on their own, so stale warnings don't pile up."* |
| *"Why `voyage-multimodal-3.5` instead of just embedding text captions?"* | *"Captions drop most of the visual detail. Embedding the frame and the spoken note together means a guest can later ask about something nobody named — the vending machine at the end of the corridor — and vector search still finds the frame it was in."* |
