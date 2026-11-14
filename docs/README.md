# SafeSpace — Governed Spatial Memory for Blind & Low-Vision Guests in Unfamiliar Venues

> **"Walk into any hotel, venue or restaurant you have never visited, and get around it on your own" on Mentra Live Smart Glasses**
> Built for *Agents in Context Toronto: a MongoDB Hackathon* (Sat, Nov 14, 2026)

## The Problem
Hospitality is built around places the guest has never seen before. For a blind or low-vision guest, every new hotel, conference centre or restaurant starts from zero:
1. **No map of the place.** Where is the reception desk from the entrance? Which way to the elevators, the restrooms, the breakfast room, room 412, the emergency exit? Today the answer is "ask a staff member to walk you there", every time. AI vision tools (*Be My Eyes*, *Seeing AI*, *ChatGPT Voice*) only describe what is in front of the camera **right now**; they have no memory of the building and cannot plan a route through it.
2. **Blockers nobody tells you about.** Venues change by the hour: a housekeeping cart in the corridor, a freshly mopped floor, a luggage trolley by the elevator, chairs moved for an event, a door closed for maintenance. None of this is on any map, so a blind guest finds it with their cane or their shins.
3. **Cameras in a shared building are a privacy problem.** Glasses worn around a hotel capture other guests, room numbers, documents and conversations. The guest's own things (room key, passport, medication) must stay private, from other guests and from staff, and nothing should outlive the stay.

## Our Solution
The guest wears **Mentra Live** camera + audio glasses (or uses a phone browser) and simply speaks. Staff, or the first guest to walk a route, build up a **shared map of the venue**; every later guest is guided through it by voice from the moment they arrive, without scanning anything themselves. Camera frames and spoken notes go into a governed **MongoDB Atlas + Voyage Multimodal 3.5** memory, and **ElevenLabs** low-latency voice guides the guest step by step, warning them about blockers on the way.

- **🗺️ Shared Venue Map:** Entrances, reception, elevators, stairs, ramps, restrooms, room doors, the breakfast buffet, emergency exits, with **touch- and step-based directions** (*"elevators are 10 steps left of the main doors; call button at waist height"*). Mapped once, usable by every guest in the venue.
- **⚠️ Live Blocker Alerts:** Obstacles spotted by any camera or reported by staff or guests (*wet floor, housekeeping cart, luggage trolley, event chairs, closed corridor*) pass a **pre-write Policy & PII Gate**, reach every guest in the venue within a second through MongoDB Change Streams (`watch()`), and **expire automatically** via TTL indexes once they are stale. "Guide me" warns about and routes around them.
- **🔒 Private Guest Layer:** Room key, passport, wallet, medication and spoken self-notes (*"room key in my left jacket pocket"*) are locked to the guest, invisible to other guests **and** to staff.
- **🧳 Stay-Scoped Memory:** A guest's room is a **temporary stay**: everything remembered there is private and **wiped at checkout**. Saying *"forget my passport"* wipes a memory immediately.
- **🛎️ Staff Layer:** Staff-only notes (maintenance, back-of-house routes) are visible to staff, never to guests.

### Built for the venue and the guest
A venue sets up its space once: the map, which topics are shared, who can see what, and how long blockers last. Guests come and go; each one gets the full venue map plus their own private layer for the length of their stay. The same model works for hotels, conference centres, restaurants, airports and hospitals. The demo uses a tabletop "hotel lobby" because it is easy to set up.

> **Naming note:** the API contract and seed data (`docs/api-contract.md`, `db/setup.js`, the mock server) still use the earlier home example (roles `resident` / `caregiver` / `visitor`). The model is the same: a space with roles, topics and groups. In this use case the space is a venue, and the roles are guests and staff.

---

## Hackathon Track & Prize Alignment
- **Primary Track — `#memory-you-can-govern` (Track 2):**
  - Shared venue map vs. per-guest private memory, enforced inside `$vectorSearch` pre-filters.
  - Cross-modal reconciliation (`ADD` / `REINFORCE` / `SUPERSEDE`) across camera sightings and voice notes, so a moved blocker or a moved room key updates in place.
  - Automatic TTL expiry (stale blockers, checkout) + surgical voice `"forget"`.
  - Provable behavioral delta: Guest B is guided around a lobby they have never scanned, and warned about a blocker someone else reported a minute ago.
- **Secondary Alignment — `#agents-you-can-audit` (Track 1):**
  - Pre-write Policy Gate inspects every candidate memory before it reaches the shared venue map.
  - Immutable `$jsonSchema`-validated `audit_events` collection logs every policy decision, redaction, `forget` wipe, checkout wipe, and blocked cross-guest query.
- **Partner Prize — Best Project Built with ElevenLabs:**
  - Mentra Live has **no screen** — **ElevenLabs Flash v2.5** streaming voice is the guest's only interface for directions, blocker warnings, and 1-fps clock-face hand guidance.

---

## Documentation Index
| Doc | What It Covers |
| --- | --- |
| [`01-architecture-and-stream-pipeline.md`](./01-architecture-and-stream-pipeline.md) | System diagram, Mentra Live WHIP WebRTC + mic ingest, `<1s` hot-frame RAM path vs. async Voyage 3.5 + Gemini 4 background indexing, and phone/webcam dev mode. |
| [`02-mongodb-schema-and-governance.md`](./02-mongodb-schema-and-governance.md) | MongoDB collections, JSON schemas, `voyage-multimodal-3.5` Vector Search index, zero-leak `$vectorSearch` query, camera+voice dedupe state machine, TTL, and `watch()`. |
| [`03-features-and-navigation-loop.md`](./03-features-and-navigation-loop.md) | Every feature in detail: venue mapping, blocker alerts, private guest memory, stay-scoped TTL, and the 2-stage ElevenLabs step-by-step guidance loop. |
| [`04-judge-demo-and-ui.md`](./04-judge-demo-and-ui.md) | How to **show** an audio/glasses product to judges: 4-panel Control Room UI, beat-by-beat 2m30s "hotel lobby" demo script, and judge Q&A cheat sheet. |
| [`05-build-plan.md`](./05-build-plan.md) | Step-by-step build plan for the stream pipeline, with owners and done-checks. |

---

## 3-Person Parallel Build Split
| Owner | Scope | Key Deliverables |
| --- | --- | --- |
| **Stream, Hardware & Voice** | Mentra Live + Webcam/Mic fallback + ElevenLabs | Mentra WHIP/photo + mic ingest, browser webcam/mic simulator (so all 3 devs can test in parallel), ElevenLabs Flash TTS streaming, 1-fps guidance loop with blocker warnings. |
| **MongoDB & Multimodal Brain** | Atlas + Voyage 3.5 + Gemini 4 Carbon | `memories` & `audit_events` setup, `voyage-multimodal-3.5` embeddings, Gemini 4 tactile landmark + blocker + policy extractor, `ADD/REINFORCE/SUPERSEDE` reconciler, `$vectorSearch` + `watch()` SSE feed. |
| **Judge Control Room UI** | React Live Dashboard | Split-screen live visualizer: glasses POV with landmark and blocker highlights, real-time `🗺️ VENUE MAP` / `⚠️ BLOCKER` / `🔒 PRIVATE` memory cards via SSE (`watch()`), Guest A / Guest B / Staff switcher, and live Audit Log. |
