# Spatial Recall — Governed Multimodal & Voice Memory for Blind Navigation

> **"Waze for Blind Indoor Spaces + Private Personal Memory" on Mentra Live Smart Glasses**
> Built for *Agents in Context Toronto: a MongoDB Hackathon* (Sat, Nov 14, 2026)

## The Problem
Current AI vision tools for blind and low-vision users (*Be My Eyes*, *Seeing AI*, *ChatGPT Voice*) have **total amnesia**:
1. They only describe what is directly in front of the camera **right now** — put your meds, cane, or keys down an hour ago (or inside a pocket/drawer a camera can't see), and they cannot help.
2. Every blind person entering an unfamiliar hotel room, cafe, or office starts from **zero**, even if another user walked through 5 minutes ago.
3. Always-on cameras and mics inside homes and hotels capture deeply sensitive data (passports, prescriptions, wallets, private conversations) that **cannot** sit in an ungoverned prompt or leak across users.

## Our Solution
Wearing **Mentra Live** camera + audio glasses (or using a phone browser fallback), users naturally walk and speak. Our agent fuses **live camera frames + microphone transcripts** into a governed **MongoDB Atlas + Voyage Multimodal 3.5** memory engine and guides users back to landmarks and personal items step-by-step using **ElevenLabs** low-latency voice:

- **🟢 Public Venue Layer ("Waze Indoors"):** Doors, stairs, restroom signs, outlets, counters, and temporary hazards (*wet floor, blocked aisle*) pass a **pre-write Policy & PII Gate** and become immediately searchable by *any* blind visitor in that venue via MongoDB Change Streams (`watch()`).
- **🔒 Private Personal Layer:** Wallets, keys, medications, room numbers, and spoken self-notes (*"keys in my left jacket pocket"*) are automatically quarantined to `visibility: "private"` (`owner_id` locked) — invisible to anyone else.
- **♻️ Self-Healing & Expiring Memory:** When objects move (or a voice note updates a camera sighting), older memories automatically flip to `status: "superseded"`. Hotel rooms and temporary hazards auto-delete via **MongoDB TTL indexes**, and saying *"Forget my nightstand"* wipes matching memories immediately.

---

## Hackathon Track & Prize Alignment
- **Primary Track — `#memory-you-can-govern` (Track 2):**
  - Multi-tenant / public-vs-private isolation enforced inside `$vectorSearch` pre-filters.
  - Cross-modal reconciliation (`ADD` / `REINFORCE` / `SUPERSEDE`) across camera sightings and voice notes.
  - Automatic TTL expiration (hotel checkout / temporary hazards) + surgical voice `"forget"`.
  - Provable behavioral delta: User B navigates a room they have never scanned; moved items update live.
- **Secondary Alignment — `#agents-you-can-audit` (Track 1):**
  - Pre-write Policy Gate inspects every candidate memory before promotion to `public`.
  - Immutable `$jsonSchema`-validated `audit_events` collection logs every policy decision, redaction, `forget` wipe, and blocked cross-user query.
- **Partner Prize — Best Project Built with ElevenLabs:**
  - Mentra Live has **no screen** — **ElevenLabs Flash v2.5** streaming voice is the primary human interface for recall, tactile landmark orientation, and 1-fps clock-face hand guidance.

---

## Documentation Index
| Doc | What It Covers |
| --- | --- |
| [`01-architecture-and-stream-pipeline.md`](./01-architecture-and-stream-pipeline.md) | System diagram, Mentra Live WHIP WebRTC + mic ingest, `<1s` hot-frame RAM path vs. async Voyage 3.5 + Gemini 4 background indexing, and phone/webcam dev mode. |
| [`02-mongodb-schema-and-governance.md`](./02-mongodb-schema-and-governance.md) | Exact MongoDB collections, JSON schemas, `voyage-multimodal-3.5` Vector Search index, zero-leak `$vectorSearch` query, camera+voice dedupe state machine, TTL, and `watch()`. |
| [`03-features-and-navigation-loop.md`](./03-features-and-navigation-loop.md) | Detailed breakdown of every feature, pocket/drawer voice memory fusion, hotel check-in TTL mode, and the 2-stage ElevenLabs step-by-step navigation loop. |
| [`04-judge-demo-and-ui.md`](./04-judge-demo-and-ui.md) | How to **show** an audio/glasses product to judges: 4-panel Control Room UI layout, beat-by-beat 2m30s live demo script, and judge Q&A cheat sheet. |

---

## 3-Person Parallel Build Split
| Owner | Scope | Key Deliverables |
| --- | --- | --- |
| **Stream, Hardware & Voice** | Mentra Live + Webcam/Mic fallback + ElevenLabs | Mentra WHIP/photo + mic ingest, browser webcam/mic simulator (so all 3 devs can test in parallel), ElevenLabs Flash TTS streaming, 1-fps active guidance loop. |
| **MongoDB & Multimodal Brain** | Atlas + Voyage 3.5 + Gemini 4 Carbon | `memories` & `audit_events` setup, `voyage-multimodal-3.5` embeddings, Gemini 4 tactile landmark + policy extractor, `ADD/REINFORCE/SUPERSEDE` reconciler, `$vectorSearch` + `watch()` SSE feed. |
| **Judge Control Room UI** | Next.js / React Live Dashboard | Split-screen live visualizer: glasses POV with object highlights, real-time `🟢 PUBLIC` vs `🔒 PRIVATE` memory cards via SSE (`watch()`), `User A / User B` switcher, and live Audit Log. |
