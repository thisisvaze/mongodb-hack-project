// SafeSpace — MongoDB Atlas setup
//
// Creates the collections, validators and indexes described in
// docs/02-mongodb-schema-and-governance.md. Field names and values follow
// docs/api-contract.md, so a stored document maps onto the contract's objects
// with only two changes: `_id` becomes `id`, and dates become ISO 8601 strings.
// Fields the contract does not have (embedding, tactile_anchor, ...) are
// backend-only and are left out of API responses.
//
// Safe to run more than once: existing collections get their validator
// updated, and indexes that already exist are left alone.
//
// Run:
//   mongosh "<your Atlas connection string>" --file db/setup.js
//
// Optional settings (environment variables):
//   DB_NAME            database name (default: hackathon)
//   WITH_OBSERVATIONS  "false" to skip the optional observations collection
//   SEED_SPACES        "false" to skip inserting the demo spaces

const DB_NAME = process.env.DB_NAME || "hackathon";
const WITH_OBSERVATIONS = process.env.WITH_OBSERVATIONS !== "false";
const SEED_SPACES = process.env.SEED_SPACES !== "false";

const EMBEDDING_DIMENSIONS = 1024; // voyage-multimodal-3.5, output_dimension=1024
const VECTOR_INDEX_NAME = "memories_multimodal_vec";

const target = db.getSiblingDB(DB_NAME);

// ---------------------------------------------------------------------------
// Shared value lists. Keep these in sync with docs/api-contract.md,
// frontend/web/src/types.ts and the Rust enums in models.rs.
// ---------------------------------------------------------------------------

// api-contract: Memory.source / Memory.status
const MEMORY_SOURCES = ["camera", "voice", "both"];
const MEMORY_STATUS = ["active", "superseded", "forgotten", "expired"];

// api-contract: AuditEntry.action / AuditEntry.verdict
const AUDIT_ACTIONS = [
  "memory_stored",
  "memory_superseded",
  "memory_forgotten",
  "memory_expired",
  "query_answered",
  "query_denied",
  "rule_changed",
];
const AUDIT_VERDICTS = ["allowed", "denied", "info"];

// api-contract: POST /api/turn response
const TURN_KINDS = ["saved", "answer", "denied", "forgot", "ignored", null];
const INPUTS_USED = ["text", "audio", null];

// Backend-only.
const SPACE_MODES = ["shared_space", "temporary_stay"];
const OBSERVATION_TYPES = ["turn", "frame"]; // POST /api/turn, POST /api/frames
const GATE_REASONS = ["visual_change", "speech_keyword", "manual"];
// Who said an utterance. "self" = the user wearing the device; "other" = an
// overheard helper (family, carer, co-worker). The Policy Gate treats these differently.
const SPEAKERS = ["self", "other", "unknown", null];

const MAX_TRANSCRIPT_CHARS = 2000;
const MAX_UTTERANCE_MS = 25000; // api-contract caps an utterance at 25 s

// Topic and group names are set by the Rules document, so they are checked
// for shape only, not against a fixed list.
const SLUG = { bsonType: "string", pattern: "^[a-z0-9_]+$" };
const KEEP_FOR = { bsonType: ["string", "null"], pattern: "^[0-9]+[smhdw]$" }; // api-contract clarification 10

const nullableString = { bsonType: ["string", "null"] };
const nullableDate = { bsonType: ["date", "null"] };
const nullableId = { bsonType: ["string", "objectId", "null"] };
const nullableTranscript = { bsonType: ["string", "null"], maxLength: MAX_TRANSCRIPT_CHARS };
const nullableConfidence = { bsonType: ["double", "int", "null"], minimum: 0, maximum: 1 };
const stringArray = { bsonType: "array", items: { bsonType: "string" } };

// Raw audio bytes are never stored in MongoDB. These are the names a raw
// payload would arrive under (see the audio object in docs/api-contract.md).
const NO_RAW_AUDIO = {
  anyOf: [{ required: ["audio"] }, { required: ["audio_b64"] }, { required: ["data_b64"] }],
};

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

// One document per space. `members` is the contract's User list for the space,
// and `rules` is the contract's Rules object, stored as is.
const spacesValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["_id", "name", "mode", "members", "rules"],
    properties: {
      _id: { bsonType: "string", description: "api-contract space_id" },
      name: { bsonType: "string" },
      mode: { enum: SPACE_MODES },
      owner_id: nullableString,
      members: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["id", "name", "role"],
          properties: {
            id: { bsonType: "string" },
            name: { bsonType: "string" },
            role: SLUG,
          },
        },
      },
      rules: {
        bsonType: "object",
        required: ["roles", "topics", "default_group"],
        properties: {
          roles: {
            bsonType: "object",
            additionalProperties: {
              bsonType: "object",
              required: ["can_see"],
              properties: { can_see: stringArray }, // group names, or "*"
            },
          },
          topics: {
            bsonType: "object",
            additionalProperties: {
              bsonType: "object",
              required: ["group", "keep_for"],
              properties: { group: SLUG, keep_for: KEEP_FOR },
            },
          },
          default_group: SLUG,
        },
      },
      // Temporary stays: every memory made here expires at this time.
      default_expires_at: nullableDate,
    },
  },
};

const memoriesValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "_id",
      "space_id",
      "owner_id",
      "item",
      "item_key",
      "summary",
      "topic",
      "group",
      "source",
      "status",
      "created_at",
      "updated_at",
    ],
    properties: {
      // ---- Fields in the api-contract Memory object ----
      _id: { bsonType: ["string", "objectId"], description: "api-contract id" },
      space_id: { bsonType: "string" },
      owner_id: { bsonType: "string" },
      item: { bsonType: "string" }, // human-readable, e.g. "house keys"
      summary: { bsonType: "string" },
      location: nullableString, // short, e.g. "left jacket pocket"; may be null
      topic: SLUG, // a key of rules.topics, or "other"
      group: SLUG, // copied from the topic's group when stored; not regrouped later
      source: { enum: MEMORY_SOURCES },
      status: { enum: MEMORY_STATUS },
      superseded_by: nullableId,
      created_at: { bsonType: "date" },
      updated_at: { bsonType: "date" },
      expires_at: nullableDate, // when status becomes "expired"
      image_url: nullableString, // backend's own copy of the keyframe, never the glasses' signed URL

      // ---- Backend-only ----
      item_key: SLUG, // normalised slug the reconciler matches on, e.g. "house_keys"
      policy_decision: {
        bsonType: "object",
        required: ["topic", "group", "reason", "checked_at"],
        properties: {
          topic: SLUG,
          group: SLUG,
          reason: { bsonType: "string" },
          pii_redacted: { bsonType: "bool" },
          checked_at: { bsonType: "date" },
        },
      },
      reinforcement_count: { bsonType: ["int", "long"], minimum: 1 },
      tactile_anchor: nullableString, // touch/body-relative guidance used by the guide loop
      previous_location: nullableString,
      // Set by the guide loop when the user reaches the landmark and the item is not there.
      // The memory stays "active" (the contract has no "missing" status) until a newer one supersedes it.
      missing_since: nullableDate,

      transcript_snippet: nullableTranscript,
      speaker: { enum: SPEAKERS },
      stt_confidence: nullableConfidence,
      source_observation_id: nullableId,

      bbox: {
        bsonType: ["array", "null"],
        minItems: 4,
        maxItems: 4,
        items: { bsonType: ["int", "long", "double"], minimum: 0, maximum: 1000 },
      },
      frame_thumb_b64: nullableString, // served at image_url

      // Optional so a memory can be written before the embedding is ready,
      // but when present it must be the full 1024-number vector.
      embedding: {
        bsonType: "array",
        minItems: EMBEDDING_DIMENSIONS,
        maxItems: EMBEDDING_DIMENSIONS,
        items: { bsonType: "double" },
      },

      // TTL: MongoDB deletes the document at this time. Set it some time after
      // the memory is marked "expired" or "forgotten", so the dashboard can show
      // the change before the data is gone. null = keep.
      purge_at: nullableDate,
    },
    not: NO_RAW_AUDIO,
  },
};

// The api-contract AuditEntry, plus query_text.
const auditValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["_id", "ts", "space_id", "actor_id", "action", "verdict", "detail", "memory_ids"],
    properties: {
      _id: { bsonType: ["string", "objectId"], description: "api-contract id" },
      ts: { bsonType: "date" },
      space_id: { bsonType: "string" },
      actor_id: { bsonType: "string" }, // a user id, "dashboard" or "system"
      action: { enum: AUDIT_ACTIONS },
      verdict: { enum: AUDIT_VERDICTS },
      detail: { bsonType: "string" },
      memory_ids: stringArray,
      query_text: nullableTranscript, // backend-only
    },
  },
};

// One row per POST /api/turn or POST /api/frames call that the backend
// processed, kept until expires_at (TTL) so a memory can be traced back to
// what was seen or said.
const observationsValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["type", "space_id", "user_id", "ts", "expires_at"],
    properties: {
      type: { enum: OBSERVATION_TYPES },
      space_id: { bsonType: "string" },
      user_id: { bsonType: "string" },
      ts: { bsonType: "date" }, // the request's ts
      session_id: nullableString,
      mentra_request_id: nullableString,

      // Turn input and result (POST /api/turn).
      text: nullableTranscript, // the client's own transcript, or null
      heard_text: nullableTranscript, // the words the backend acted on
      input_used: { enum: INPUTS_USED },
      kind: { enum: TURN_KINDS },
      memory_ids: stringArray,

      // Audio details. The audio bytes themselves are never stored.
      audio_format: nullableString, // "wav" | "pcm_s16le" | as reported by the glasses SDK
      sample_rate: { bsonType: ["int", "long", "null"] },
      duration_ms: { bsonType: ["int", "long", "null"], minimum: 0, maximum: MAX_UTTERANCE_MS },
      speaker: { enum: SPEAKERS },
      stt_confidence: nullableConfidence, // null when the backend used the client's text
      language: nullableString, // e.g. "en-CA"
      // Only if short clips are kept: id of a GridFS file with its own TTL.
      audio_ref: nullableId,

      // Image (turn image or frame): the backend's own copy, never the signed URL.
      image_url: nullableString,
      phash_distance: { bsonType: ["int", "long", "null"] },
      gate_reason: { enum: GATE_REASONS },

      expires_at: { bsonType: "date" },
    },
    not: NO_RAW_AUDIO,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEED_SPACE_IDS = ["home", "home_vaze", "stay_guest_room"];

function isUnauthorized(e) {
  return e && (e.code === 13 || /not authorized|unauthorized/i.test(e.message || ""));
}

// True when dropping the collection loses nothing: it is empty, or (for
// spaces) it holds only the seed documents this script puts back.
function safeToRecreate(name) {
  const coll = target.getCollection(name);
  if (name === "spaces" && SEED_SPACES) {
    return coll.countDocuments({ _id: { $nin: SEED_SPACE_IDS } }) === 0;
  }
  return coll.countDocuments({}) === 0;
}

function createWithValidator(name, validator) {
  target.createCollection(name, { validator, validationLevel: "strict", validationAction: "error" });
}

function ensureCollection(name, validator) {
  const exists = target.getCollectionNames().includes(name);
  if (!exists) {
    createWithValidator(name, validator);
    print(`  ${name}: created`);
    return;
  }

  // Changing the validator of an existing collection (collMod) needs the
  // dbAdmin role. A user with only readWrite gets "not authorized".
  let error = null;
  try {
    const res = target.runCommand({ collMod: name, validator, validationLevel: "strict", validationAction: "error" });
    if (res && res.ok === 0) error = res;
  } catch (e) {
    error = e;
  }
  if (!error) {
    print(`  ${name}: updated validator`);
    return;
  }
  if (!isUnauthorized(error)) throw error;

  // readWrite can still drop and create collections, so recreate the
  // collection when that loses no data.
  if (safeToRecreate(name)) {
    target.getCollection(name).drop();
    createWithValidator(name, validator);
    print(`  ${name}: recreated with the new validator (no permission to change it in place)`);
    return;
  }

  throw new Error(
    `Not authorized to change the validator on "${name}", and it holds data, so it was not recreated. ` +
      `In Atlas > Database Access, give this user the dbAdmin role on "${DB_NAME}" (or Atlas admin) and run again.`
  );
}

function ensureIndex(collection, keys, options) {
  const name = target.getCollection(collection).createIndex(keys, options);
  print(`  ${collection}: index ${name}`);
}

// Drops an index left over from an earlier version of this script, if present.
function dropOldIndex(collection, name) {
  const coll = target.getCollection(collection);
  if (coll.getIndexes().some((ix) => ix.name === name)) {
    coll.dropIndex(name);
    print(`  ${collection}: dropped old index ${name}`);
  }
}

function ensureVectorIndex() {
  const coll = target.getCollection("memories");
  const definition = {
    fields: [
      { type: "vector", path: "embedding", numDimensions: EMBEDDING_DIMENSIONS, similarity: "cosine" },
      { type: "filter", path: "space_id" },
      { type: "filter", path: "group" },
      { type: "filter", path: "owner_id" },
      { type: "filter", path: "status" },
    ],
  };

  let existing = [];
  try {
    existing = coll.getSearchIndexes(VECTOR_INDEX_NAME);
  } catch (e) {
    print(`  memories: could not list search indexes (${e.message})`);
    print("  Create the vector index in the Atlas UI using the definition in doc 02.");
    return;
  }

  try {
    if (existing.length > 0) {
      coll.updateSearchIndex(VECTOR_INDEX_NAME, definition);
      print(`  memories: vector index ${VECTOR_INDEX_NAME} updated (status: ${existing[0].status})`);
    } else {
      coll.createSearchIndex({ name: VECTOR_INDEX_NAME, type: "vectorSearch", definition });
      print(`  memories: vector index ${VECTOR_INDEX_NAME} requested (takes a minute or two to build)`);
    }
  } catch (e) {
    if (!isUnauthorized(e)) throw e;
    print(`  memories: not authorized to change search indexes (${e.message})`);
    print("  Edit the vector index in the Atlas UI (Search tab) using the definition in doc 02.");
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

print(`Setting up database "${DB_NAME}"`);

print("Collections:");
ensureCollection("spaces", spacesValidator);
ensureCollection("memories", memoriesValidator);
ensureCollection("audit_events", auditValidator);
if (WITH_OBSERVATIONS) ensureCollection("observations", observationsValidator);

print("Indexes:");
// Indexes from the earlier venue_id / visibility schema.
dropOldIndex("memories", "ttl_expires_at");
dropOldIndex("memories", "lookup_owner_item");
dropOldIndex("memories", "lookup_venue_item");
dropOldIndex("audit_events", "venue_timeline");
dropOldIndex("audit_events", "actor_timeline");
dropOldIndex("spaces", "members");
if (WITH_OBSERVATIONS) dropOldIndex("observations", "session_recent");

// TTL on purge_at, not expires_at: an expired memory must stay readable with
// status "expired" (GET /api/state lists it) until the backend sets purge_at.
ensureIndex("memories", { purge_at: 1 }, { name: "ttl_purge_at", expireAfterSeconds: 0 });
// GET /api/state: every memory in the space, newest first.
ensureIndex("memories", { space_id: 1, created_at: -1 }, { name: "space_newest" });
// Reconciler lookup for an owner's item among active memories.
ensureIndex("memories", { space_id: 1, owner_id: 1, item_key: 1, status: 1 }, { name: "lookup_owner_item" });
// Reconciler lookup for a shared item by group.
ensureIndex("memories", { space_id: 1, item_key: 1, group: 1, status: 1 }, { name: "lookup_group_item" });
// Expiry sweep: active memories whose expires_at has passed.
ensureIndex("memories", { status: 1, expires_at: 1 }, { name: "expiry_sweep" });

// GET /api/state: last 200 entries, newest first.
ensureIndex("audit_events", { space_id: 1, ts: -1 }, { name: "space_timeline" });
ensureIndex("audit_events", { actor_id: 1, ts: -1 }, { name: "actor_ts" });

// Unknown user_id returns 404 (api-contract clarification 6).
ensureIndex("spaces", { "members.id": 1 }, { name: "member_ids" });

if (WITH_OBSERVATIONS) {
  ensureIndex("observations", { expires_at: 1 }, { name: "ttl_expires_at", expireAfterSeconds: 0 });
  ensureIndex("observations", { space_id: 1, user_id: 1, ts: -1 }, { name: "user_recent" });
}

print("Vector search:");
ensureVectorIndex();

if (SEED_SPACES) {
  print("Seed data:");
  const spaces = target.getCollection("spaces");

  // Seed space from the earlier schema, replaced by "home".
  spaces.deleteOne({ _id: "home_vaze" });

  // Same users and rules as frontend/mock-server/server.mjs.
  spaces.replaceOne(
    { _id: "home" },
    {
      _id: "home",
      name: "Home",
      mode: "shared_space",
      owner_id: "u_resident",
      members: [
        { id: "u_resident", name: "Resident", role: "resident" },
        { id: "u_caregiver", name: "Caregiver", role: "caregiver" },
        { id: "u_visitor", name: "Visitor", role: "visitor" },
      ],
      rules: {
        roles: {
          resident: { can_see: ["*"] },
          caregiver: { can_see: ["care", "supplies", "house_guide"] },
          visitor: { can_see: ["house_guide"] },
        },
        topics: {
          medication: { group: "care", keep_for: "30d" },
          supplies: { group: "supplies", keep_for: null },
          valuables: { group: "resident_only", keep_for: null },
          documents: { group: "resident_only", keep_for: null },
          house_guide: { group: "house_guide", keep_for: null },
          hazard: { group: "house_guide", keep_for: "2h" },
        },
        default_group: "resident_only",
      },
      default_expires_at: null,
    },
    { upsert: true }
  );

  // A temporary stay: no topics are shared, so every memory falls into the
  // owner-only default group, and all of them expire when the stay ends.
  spaces.replaceOne(
    { _id: "stay_guest_room" },
    {
      _id: "stay_guest_room",
      name: "Guest room",
      mode: "temporary_stay",
      owner_id: "u_resident",
      members: [{ id: "u_resident", name: "Resident", role: "resident" }],
      rules: {
        roles: { resident: { can_see: ["*"] } },
        topics: {},
        default_group: "resident_only",
      },
      default_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    { upsert: true }
  );
  print("  spaces: home, stay_guest_room");
}

print("Done.");
