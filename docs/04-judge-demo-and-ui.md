# 04 — How We Show It to Judges (Control Room UI & 2m30s Live Demo)

## Why the Judge UI Matters
Mentra Live glasses have **no screen** — the magic happens in the wearer's ear. If judges only watch someone wearing glasses on stage, **they can't see MongoDB Atlas, Vector Search, Policy Governance, or Change Streams working**.

To make the invisible infrastructure **unmissable** (both in the 90-second Round 1 submission video and on the Finalist stage projector), we pair the glasses with a **4-Panel Live "Judge Control Room" Dashboard** fed in real time by **MongoDB Change Streams (`watch()`) over SSE**.

---

## Judge Control Room Layout (Single Screen, Zero Scrolling)

```text
┌───────────────────────────────────────┬──────────────────────────────────────────────┐
│  1. LIVE GLASSES POV + HOMING HUD     │  2. GOVERNED ATLAS MEMORY FEED (watch() SSE) │
│  ┌─────────────────────────────────┐  │                                              │
│  │  [Live WebRTC Video Feed]       │  │  [🟢 SHARED SPACE] Garage Door & Step Hazard │
│  │    ┌──────────────┐             │  │   "1 step down just past the garage door"    │
│  │    │ 🟢 Kettle    │  ┌────────┐ │  │   voyage-multimodal-3.5 · TTL: Permanent     │
│  │    └──────────────┘  │🔒Wallet│ │  │                                              │
│  │                      └────────┘ │  │  [🔒 PRIVATE · user_vaze]  Leather Wallet    │
│  └─────────────────────────────────┘  │   "6 in right of laptop charger on desk"     │
│  🎙️ Live Mic: "Leaving my wallet..."  │   Status: ACTIVE  (Superseded kitchen @14:52)│
│  🔊 ElevenLabs: "1 o'clock, 6 inches" │                                              │
│  🎯 Visual Homing Match: ████████░ 84%│  [🔒 PRIVATE · VOICE]  House Keys            │
│                                       │   "Inside left jacket pocket" · Modality: 🎙️ │
├───────────────────────────────────────┼──────────────────────────────────────────────┤
│  3. IDENTITY & SPACE CONTROLS         │  4. TRACK 1 IMMUTABLE AUDIT & POLICY LOG     │
│                                       │                                              │
│  Active Caller:                       │  15:14:19  🛑 DENIED  user_guest_b           │
│   (•) Vaze (Owner)                    │    Query: "Where is Vaze's wallet?"          │
│   ( ) 2nd blind user (User B)         │    Rule: owner_id mismatch on private item   │
│                                       │                                              │
│  Space Mode:                          │  15:13:04  ♻️ SUPERSEDED  house_keys         │
│   [Space: Vaze's home] [Guest room]   │    Voice note overrode 15:10 camera sighting │
│   Stay TTL Countdown: 18h 45m 12s     │                                              │
│                                       │  15:12:40  🟢 PROMOTED SHARED  kettle        │
│  [Simulate TTL Expiry Now]            │    PII/Face gate passed → shared to space    │
└───────────────────────────────────────┴──────────────────────────────────────────────┘
```

### The 4 Visual Proof Points Judges See Instantly
1. **Green vs. Lock Badges Popping In Live:** One sweep of the glasses creates both a `🟢 SHARED SPACE` card and a `🔒 PRIVATE` card in real time via `db.memories.watch()`.
2. **Visual Homing Meter (`32% → 86%`):** Shows `voyage-multimodal-3.5` cosine similarity climbing live as the wearer turns their head toward the remembered landmark.
3. **Crossed-Out `SUPERSEDED` Card:** When an item moves (or the wearer says *"put my keys in my pocket"*), the old card visibly greys out with a link to the new active card.
4. **Flashing Red `🛑 DENIED` Row in Audit Log:** When switched to `User B`, asking for User A's private item triggers an unmistakable red audit event.

---

## Beat-by-Beat 2m30s Demo Script (Video & Finalist Stage)

**Setup on table (takes 10 seconds):** The table plays a kitchen counter: a kettle or water jug (shared landmark), a laptop + charger, keys, and a wallet. Projector shows the Control Room UI; speaker output split/mirrored so judges hear ElevenLabs clearly.

- **0:00 – 0:20 | The Hook (20s)**
  - *"Tools like Be My Eyes tell a blind person what they're pointing at right now — but they have total amnesia. Put your keys down, have someone tidy up, walk into a room you haven't been in for a week — and you're back to asking a sighted person where everything is. And you can't give someone an always-on camera without strict memory governance. We built Spatial Recall on Mentra Live glasses, MongoDB Atlas, Voyage Multimodal 3.5, and ElevenLabs."*
- **0:20 – 0:55 | Beat 1 — Fused Camera + Voice Ingest & Shared/Private Split (35s)**
  - **User A** (wearing Mentra Live) looks across the counter and speaks: *"The kettle is at the left corner of the counter — and I'm leaving my wallet right next to my laptop charger."*
  - Point at Dashboard Panel 2: **Two cards pop in live via Atlas Change Streams** — `kettle` approved as `🟢 SHARED`, `wallet` quarantined as `🔒 PRIVATE (user_a)`.
- **0:55 – 1:30 | Beat 2 — Shared Space Memory + Zero-Leak Block (35s)**
  - Flip **Active Caller** toggle to **User B**, a second blind user who has never scanned this room (or hand glasses to teammate):
    1. User B asks: *"Guide me to the kettle."* → **ElevenLabs** immediately guides them (*"Turn slightly left… straight ahead, reach to the corner"*) using User A's shared memory!
    2. User B asks: *"Where did Vaze leave his wallet?"* → ElevenLabs refuses, and **Panel 4 flashes `🛑 DENIED — cross_tenant_query_blocked`**.
- **1:30 – 2:05 | Beat 3 — Pocket Voice Override & Moving Objects (35s)**
  - Flip back to **User A**. Pick up the keys from the table, drop them into your hoodie pocket, and mutter: *"Keys in my front hoodie pocket."*
  - Panel 2 shows the old table camera sighting flip to **`SUPERSEDED`** and the new voice memory become **`ACTIVE`**.
  - Ask: *"Where are my keys?"* → ElevenLabs answers in `<1s`: *"In your front hoodie pocket — you moved them from the table just now."*
- **2:05 – 2:30 | Beat 4 — Voice "Forget" & Temporary Stay TTL (25s)**
  - Say *"Forget my wallet"* (or click **Simulate TTL Expiry Now** in Guest room mode): watch the private card vanish live and log `memory_forgotten_by_user` in the immutable Audit Trail.
  - Close with one line on reach: *"It goes wherever the user goes — home, the office, a hotel room — with the same shared/private memory in each."*

---

## Judge Q&A Cheat Sheet

| Likely Judge Question | Crisp 15-Second Answer |
| --- | --- |
| *"Why MongoDB instead of dumping video into Gemini's 1M context?"* | *"Three reasons: 1-second voice latency (`30ms` vector lookup vs. 20s re-reading video), sharing one space's memory across everyone who uses it via Change Streams, and database-enforced privacy filters + TTL expiry — you can't enforce per-item blocks between users or end-of-stay self-destruct inside a raw video prompt."* |
| *"How do you stop someone polluting the shared layer or leaking faces of people nearby?"* | *"Nothing hits `visibility: public` directly — every candidate passes a pre-write Policy Gate that rejects faces, PII, and personal items to `private`, logs contributor identity in `audit_events`, and expires temporary hazards via TTL."* |
| *"Does this only work in one place, like the home?"* | *"No. It's built for the blind or low-vision person, and it goes wherever they go. A space is just an ID with a shared layer and per-person private layers, so it works the same at home, at the office, in a care home, or in a hotel room."* |
| *"What happens when someone else moves an item while the camera isn't looking?"* | *"During the 1-fps active guidance loop, when the user reaches the remembered landmark and the live camera sees the item isn't there, the agent automatically marks that MongoDB record `missing/superseded` in real time instead of letting them grope an empty table."* |
| *"Why `voyage-multimodal-3.5` instead of just embedding text captions?"* | *"Text captions drop 90% of background visual detail. Embedding the actual frame + transcript together in `voyage-multimodal-3.5` means if a user later asks about an uncaptioned object in the corner of an earlier scan, pixel-level vector search still retrieves the exact frame."* |
