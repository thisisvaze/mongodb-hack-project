# 02 — MongoDB Atlas Storage, Schemas, Dedupe & Governance

## Why MongoDB Atlas Is Doing Real Work Here
Instead of treating MongoDB as a passive CRUD table, **four native Atlas capabilities** drive the entire agent lifecycle:
1. **Atlas Vector Search (`voyage-multimodal-3.5`, 1024-d) with Pre-Filtering:** Enforces multi-user shared (`public`) vs. `private` isolation between household members, carers, and guests *inside* vector retrieval so unauthorized memories can never enter the LLM prompt.
2. **State Reconciliation (`active` → `superseded`):** Resolves contradictions across **camera sightings** and **voice transcripts** (e.g., camera saw keys on desk at 10:00 → voice says *"keys in hoodie pocket"* at 10:05).
3. **Native TTL Indexes (`expireAfterSeconds: 0`):** Automatically self-destructs temporary hazards (*freshly mopped floor* after 2h) and entire temporary-stay maps (guest room, hotel, respite stay) when the stay ends.
4. **Change Streams (`watch()`) + Strict `$jsonSchema` Validation:** Streams real-time memory births, updates, and blocked-access security alerts to User B's glasses and the Judge Control Room UI while enforcing immutable audit records at the database engine level.

---

## Collections Overview (`hackathon` database on `Cluster0`)

### 1. `memories` — Unified Multimodal & Voice Spatial Store
Stores every shared household landmark, temporary hazard, personal object sighting, and spoken/overheard location note. `venue_id` identifies the space (a home by default; the same field works for an office, care home, or hotel).

```json
{
  "_id": "mem_01J9Z8K4...",
  "venue_id": "home_vaze",
  "space_mode": "shared_home",
  "owner_id": "user_vaze",
  "visibility": "private",
  "policy_decision": {
    "gate_verdict": "quarantined_private",
    "reason": "Personal belonging (wallet) + spoken personal ownership",
    "pii_redacted": false,
    "checked_at": "2026-11-14T15:10:02Z"
  },
  "status": "active",
  "superseded_by": null,
  "reinforcement_count": 2,

  "item_key": "leather_wallet",
  "category": "personal_item",
  "source_modality": "fused",
  "summary": "Black wallet placed on wooden table, 6 inches right of MacBook charger.",
  "tactile_anchor": "Waist-high wooden table; feel for the braided laptop cable and slide 6 inches right.",
  "transcript_snippet": "Leaving my wallet right next to my laptop.",
  "bbox": [610, 480, 740, 620],
  "frame_thumb_b64": "data:image/jpeg;base64,/9j/4AAQ...",

  "embedding": [0.0184, -0.0412, "... 1024 floats from voyage-multimodal-3.5"],

  "created_at": "2026-11-14T15:10:02Z",
  "last_seen_at": "2026-11-14T15:12:40Z",
  "expires_at": null
}
```

#### Key Indexes on `memories`
1. **TTL Index (Auto-Self-Destruct):**
   ```javascript
   db.memories.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })
   ```
   - Permanent memories keep `expires_at: null` (never deleted).
   - Temporary hazards set `expires_at = now + 2h`; temporary stays set `expires_at = stay_end_timestamp` — MongoDB deletes them automatically with zero cron jobs.
2. **Active Lookup Index (Fast Reconciliation):**
   ```javascript
   db.memories.createIndex({ venue_id: 1, owner_id: 1, item_key: 1, status: 1 })
   ```
3. **Atlas Vector Search Index (`memories_multimodal_vec`):**
   ```json
   {
     "name": "memories_multimodal_vec",
     "type": "vectorSearch",
     "definition": {
       "fields": [
         {
           "type": "vector",
           "path": "embedding",
           "numDimensions": 1024,
           "similarity": "cosine"
         },
         { "type": "filter", "path": "venue_id" },
         { "type": "filter", "path": "visibility" },
         { "type": "filter", "path": "owner_id" },
         { "type": "filter", "path": "status" }
       ]
     }
   }
   ```

---

### 2. `audit_events` — Immutable Policy & Access Ledger (Track 1)
Created with strict MongoDB `$jsonSchema` validation requiring `actor_id`, `event_type`, `verdict`, and `timestamp`.

```json
{
  "_id": "aud_01J9Z8P9...",
  "venue_id": "home_vaze",
  "actor_id": "user_guest_b",
  "event_type": "cross_tenant_query_blocked",
  "query_text": "Where did Vaze leave his wallet?",
  "target_item_key": "leather_wallet",
  "verdict": "DENIED",
  "reason": "Target item exists in space 'home_vaze' under visibility='private' owned by 'user_vaze' (caller='user_guest_b').",
  "timestamp": "2026-11-14T15:14:19Z"
}
```
Other `event_type` values logged live:
- `memory_promoted_public` — Fixture/hazard passed PII & face check and entered the shared household map.
- `memory_quarantined_private` — Personal item/meds/pocket speech forced to `private`.
- `memory_superseded` — Newer camera sighting or spoken update retired an outdated location.
- `memory_forgotten_by_user` — User issued voice `"Forget ..."` command; records purged.

---

### 3. `spaces` — Home & Temporary Stay Metadata
A home is a long-lived space with sharing on:
```json
{
  "_id": "home_vaze",
  "name": "Vaze's home",
  "mode": "shared_home",
  "owner_id": "user_vaze",
  "members": ["user_vaze", "user_guest_b"],
  "allow_public_sharing": true,
  "default_expires_at": null
}
```
A temporary stay (guest room at a relative's house, hotel, respite stay) is private and expires on its own:
```json
{
  "_id": "stay_guest_room",
  "name": "Guest room at Mum's",
  "mode": "temporary_stay",
  "owner_id": "user_vaze",
  "allow_public_sharing": false,
  "default_expires_at": "2026-11-15T11:00:00Z"
}
```

---

## Zero-Leak Retrieval Query (One `$vectorSearch` Call)

When `caller_id` asks a question inside `current_venue_id`, we embed the spoken question with `voyage-multimodal-3.5` (`input_type="query"`) and run **two fast checks**:

### Step A — Governed Retrieval (Only returns what `caller_id` is allowed to know)
Note: Because Atlas `$vectorSearch` pre-filters support `$or` / `$in`, we run shared (`public`) + caller-owned retrieval cleanly:

```python
pipeline = [
    {
        "$vectorSearch": {
            "index": "memories_multimodal_vec",
            "path": "embedding",
            "queryVector": query_vec,
            "numCandidates": 60,
            "limit": 5,
            "filter": {
                "$and": [
                    {"venue_id": current_venue_id},
                    {"status": "active"},
                    {
                        "$or": [
                            {"visibility": "public"},
                            {"owner_id": caller_id}
                        ]
                    }
                ]
            }
        }
    },
    {
        "$project": {
            "embedding": 0,
            "score": {"$meta": "vectorSearchScore"}
        }
    }
]
```

### Step B — Auditable Denial Detection (For the Judge Demo!)
If Step A returns low-confidence/no match for an item request (e.g., User B asks *"Where is Vaze's wallet?"*), we check if an `active` `private` document matching that `item_key` belongs to someone else in `current_venue_id` — **never returning its location**, only writing `cross_tenant_query_blocked` to `audit_events` and replying: *"That's a private personal item belonging to another user — access denied."* Judges see the red `DENIED` row pop up live in the Audit Log!

---

## Cross-Modal Reconciliation State Machine (`ADD` / `REINFORCE` / `SUPERSEDE`)

Every new observation (whether from **camera**, **voice**, or **both**) runs through `reconcile_memory(obs)`:

```mermaid
stateDiagram-v2
  [*] --> CheckExisting: New observation (camera or voice) for item_key
  CheckExisting --> ADD: No active memory for (scope, item_key)
  CheckExisting --> CompareAnchor: Active memory exists
  CompareAnchor --> REINFORCE: Same landmark / cosine > 0.88
  CompareAnchor --> SUPERSEDE: Different landmark OR explicit voice move ("put keys in pocket")
  REINFORCE --> ActiveDoc: Increment reinforcement_count + update last_seen_at
  SUPERSEDE --> OldDocSuperseded: Set old.status = "superseded", old.superseded_by = new_id
  SUPERSEDE --> NewActiveDoc: Insert new doc with status = "active", previous_location = old.tactile_anchor
```

- **Why storing `previous_location` is magic for the user:** ElevenLabs can answer *"Your keys are in your left hoodie pocket — you moved them from the desk 8 minutes ago."*
