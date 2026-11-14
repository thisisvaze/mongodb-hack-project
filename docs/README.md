# SafeSpace — Governed Multimodal & Voice Memory for Blind & Low-Vision Support

> **"A memory that remembers where things are, so a blind person doesn't have to ask" on Mentra Live Smart Glasses**
> Built for *Agents in Context Toronto: a MongoDB Hackathon* (Sat, Nov 14, 2026)

## The Problem
Current AI vision tools for blind and low-vision people (*Be My Eyes*, *Seeing AI*, *ChatGPT Voice*) have **total amnesia**:
1. They only describe what is directly in front of the camera **right now** — put your meds, cane, or keys down an hour ago (or inside a pocket/drawer a camera can't see), and they cannot help.
2. The world around a blind person changes constantly. Someone moves the kettle, a co-worker shifts a chair, a carer restocks the meds, a hotel room is laid out differently from the last one — and the person who needs to know has no way to find out without asking a sighted person.
3. Always-on cameras and mics worn all day capture deeply sensitive data (prescriptions, IDs, wallets, mail, private conversations) that **cannot** sit in an ungoverned prompt or leak to the other people sharing the same spaces.

## Our Solution
Wearing **Mentra Live** camera + audio glasses (or using a phone browser fallback), blind and low-vision users go about their day — at home, at work, at a friend's place, in a hotel — and simply speak. Our agent fuses **live camera frames + microphone transcripts** into a governed **MongoDB Atlas + Voyage Multimodal 3.5** memory engine and guides them back to landmarks and personal items step-by-step using **ElevenLabs** low-latency voice:

- **🟢 Shared Space Layer:** Doors, stairs, light switches, outlets, appliances, counters, and temporary hazards (*wet floor, a bag left on the stairs, an open dishwasher*) pass a **pre-write Policy & PII Gate** and become immediately searchable by *everyone in that space* via MongoDB Change Streams (`watch()`) — so a second blind user can be guided around a room they have never scanned.
- **🔒 Private Personal Layer:** Wallets, keys, medications, documents, and spoken self-notes (*"keys in my left jacket pocket"*) are automatically quarantined to `visibility: "private"` (`owner_id` locked) — invisible to anyone else in the space.
- **♻️ Self-Healing & Expiring Memory:** When objects move (or a voice note updates a camera sighting), older memories automatically flip to `status: "superseded"`. Temporary hazards and temporary stays (a guest room, a hotel, a respite stay) auto-delete via **MongoDB TTL indexes**, and saying *"Forget my nightstand"* wipes matching memories immediately.

### Built around the person, not the place
The product is for the blind or low-vision person, and it goes wherever they go. A "space" is just a `venue_id` with its own shared layer and per-person private layers: a home, an office, a care home, a hotel room, or a cafe all work the same way. The demo uses a kitchen counter only because it is easy to set up on a table.

> **Naming note:** the field names in the schema and code stay as they are. `venue_id` identifies a space (any place the user spends time), and `visibility: "public"` means *shared with everyone in that space*, not with the world.

---

## Hackathon Track & Prize Alignment
- **Primary Track — `#memory-you-can-govern` (Track 2):**
  - Multi-tenant / shared-vs-private isolation enforced inside `$vectorSearch` pre-filters.
  - Cross-modal reconciliation (`ADD` / `REINFORCE` / `SUPERSEDE`) across camera sightings and voice notes.
  - Automatic TTL expiration (temporary hazards / temporary stays) + surgical voice `"forget"`.
  - Provable behavioral delta: User B finds things in a room they have never scanned; moved items update live.
- **Secondary Alignment — `#agents-you-can-audit` (Track 1):**
  - Pre-write Policy Gate inspects every candidate memory before promotion to the shared layer.
  - Immutable `$jsonSchema`-validated `audit_events` collection logs every policy decision, redaction, `forget` wipe, and blocked cross-user query.
- **Partner Prize — Best Project Built with ElevenLabs:**
  - Mentra Live has **no screen** — **ElevenLabs Flash v2.5** streaming voice is the primary human interface for recall, tactile landmark orientation, and 1-fps clock-face hand guidance.

---

## Documentation Index
| Doc | What It Covers |
| --- | --- |
| [`01-architecture-and-stream-pipeline.md`](./01-architecture-and-stream-pipeline.md) | System diagram, Mentra Live WHIP WebRTC + mic ingest, `<1s` hot-frame RAM path vs. async Voyage 3.5 + Gemini 4 background indexing, and phone/webcam dev mode. |
| [`02-mongodb-schema-and-governance.md`](./02-mongodb-schema-and-governance.md) | Exact MongoDB collections, JSON schemas, `voyage-multimodal-3.5` Vector Search index, zero-leak `$vectorSearch` query, camera+voice dedupe state machine, TTL, and `watch()`. |
| [`03-features-and-navigation-loop.md`](./03-features-and-navigation-loop.md) | Detailed breakdown of every feature, pocket/drawer voice memory fusion, temporary stay TTL mode, and the 2-stage ElevenLabs step-by-step navigation loop. |
| [`04-judge-demo-and-ui.md`](./04-judge-demo-and-ui.md) | How to **show** an audio/glasses product to judges: 4-panel Control Room UI layout, beat-by-beat 2m30s live demo script, and judge Q&A cheat sheet. |
| [`05-build-plan.md`](./05-build-plan.md) | Step-by-step build plan for the stream pipeline, with owners and done-checks. |

---

## 3-Person Parallel Build Split
| Owner | Scope | Key Deliverables |
| --- | --- | --- |
| **Stream, Hardware & Voice** | Mentra Live + Webcam/Mic fallback + ElevenLabs | Mentra WHIP/photo + mic ingest, browser webcam/mic simulator (so all 3 devs can test in parallel), ElevenLabs Flash TTS streaming, 1-fps active guidance loop. |
| **MongoDB & Multimodal Brain** | Atlas + Voyage 3.5 + Gemini 4 Carbon | `memories` & `audit_events` setup, `voyage-multimodal-3.5` embeddings, Gemini 4 tactile landmark + policy extractor, `ADD/REINFORCE/SUPERSEDE` reconciler, `$vectorSearch` + `watch()` SSE feed. |
| **Judge Control Room UI** | Next.js / React Live Dashboard | Split-screen live visualizer: glasses POV with object highlights, real-time `🟢 SHARED` vs `🔒 PRIVATE` memory cards via SSE (`watch()`), `User A / User B` switcher, and live Audit Log. |
