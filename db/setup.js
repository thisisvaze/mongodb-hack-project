// Spatial Recall — MongoDB Atlas setup
//
// Creates the collections, validators and indexes described in
// docs/02-mongodb-schema-and-governance.md. Safe to run more than once:
// existing collections get their validator updated, and indexes that
// already exist are left alone.
//
// Run:
//   mongosh "<your Atlas connection string>" --file db/setup.js
//
// Optional settings (environment variables):
//   DB_NAME            database name (default: hackathon)
//   WITH_OBSERVATIONS  "false" to skip the optional observations collection
//   SEED_SPACES        "false" to skip inserting the demo home and stay

const DB_NAME = process.env.DB_NAME || "hackathon";
const WITH_OBSERVATIONS = process.env.WITH_OBSERVATIONS !== "false";
const SEED_SPACES = process.env.SEED_SPACES !== "false";

const EMBEDDING_DIMENSIONS = 1024; // voyage-multimodal-3.5, output_dimension=1024
const VECTOR_INDEX_NAME = "memories_multimodal_vec";

const target = db.getSiblingDB(DB_NAME);

// ---------------------------------------------------------------------------
// Shared value lists. Keep these in sync with the Rust enums in models.rs.
// ---------------------------------------------------------------------------

const SPACE_MODES = ["shared_home", "temporary_stay"];
const VISIBILITY = ["public", "private"]; // "public" = shared with everyone in the space
const MEMORY_STATUS = ["active", "superseded", "missing"];
const CATEGORIES = ["venue_fixture", "hazard", "personal_item", "spoken_note"];
const SOURCE_MODALITIES = ["camera", "voice", "fused"];
const GATE_VERDICTS = ["promoted_public", "quarantined_private"];

const AUDIT_EVENT_TYPES = [
  "memory_promoted_public",
  "memory_quarantined_private",
  "memory_reinforced",
  "memory_superseded",
  "memory_marked_missing",
  "memory_forgotten_by_user",
  "cross_tenant_query_blocked",
];
const AUDIT_VERDICTS = ["SHARED", "PRIVATE", "REINFORCED", "SUPERSEDED", "MISSING", "FORGOTTEN", "DENIED"];

const OBSERVATION_TYPES = ["photo", "utterance"];
const GATE_REASONS = ["visual_change", "speech_keyword", "manual"];

// Fields that may be a string or null.
const nullableString = { bsonType: ["string", "null"] };
const nullableDate = { bsonType: ["date", "null"] };

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const spacesValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["_id", "name", "mode", "owner_id", "allow_public_sharing"],
    properties: {
      _id: { bsonType: "string", description: "Space id, used as venue_id elsewhere" },
      name: { bsonType: "string" },
      mode: { enum: SPACE_MODES },
      owner_id: { bsonType: "string" },
      members: { bsonType: "array", items: { bsonType: "string" } },
      allow_public_sharing: { bsonType: "bool" },
      default_expires_at: nullableDate,
    },
  },
};

const memoriesValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "venue_id",
      "space_mode",
      "owner_id",
      "visibility",
      "policy_decision",
      "status",
      "reinforcement_count",
      "item_key",
      "category",
      "source_modality",
      "summary",
      "created_at",
      "last_seen_at",
    ],
    properties: {
      venue_id: { bsonType: "string" },
      space_mode: { enum: SPACE_MODES },
      owner_id: { bsonType: "string" },
      visibility: { enum: VISIBILITY },
      policy_decision: {
        bsonType: "object",
        required: ["gate_verdict", "reason", "checked_at"],
        properties: {
          gate_verdict: { enum: GATE_VERDICTS },
          reason: { bsonType: "string" },
          pii_redacted: { bsonType: "bool" },
          checked_at: { bsonType: "date" },
        },
      },
      status: { enum: MEMORY_STATUS },
      superseded_by: { bsonType: ["string", "objectId", "null"] },
      reinforcement_count: { bsonType: ["int", "long"], minimum: 1 },

      item_key: { bsonType: "string", pattern: "^[a-z0-9_]+$" },
      category: { enum: CATEGORIES },
      source_modality: { enum: SOURCE_MODALITIES },
      summary: { bsonType: "string" },
      tactile_anchor: nullableString,
      previous_location: nullableString,
      transcript_snippet: nullableString,
      bbox: {
        bsonType: ["array", "null"],
        minItems: 4,
        maxItems: 4,
        items: { bsonType: ["int", "long", "double"], minimum: 0, maximum: 1000 },
      },
      frame_thumb_b64: nullableString,

      // Optional so a memory can be written before the embedding is ready,
      // but when present it must be the full 1024-number vector.
      embedding: {
        bsonType: "array",
        minItems: EMBEDDING_DIMENSIONS,
        maxItems: EMBEDDING_DIMENSIONS,
        items: { bsonType: "double" },
      },

      created_at: { bsonType: "date" },
      last_seen_at: { bsonType: "date" },
      expires_at: nullableDate,
    },
  },
};

const auditValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["venue_id", "actor_id", "event_type", "verdict", "reason", "timestamp"],
    properties: {
      venue_id: { bsonType: "string" },
      actor_id: { bsonType: "string" },
      event_type: { enum: AUDIT_EVENT_TYPES },
      verdict: { enum: AUDIT_VERDICTS },
      reason: { bsonType: "string" },
      target_item_key: nullableString,
      memory_id: { bsonType: ["string", "objectId", "null"] },
      query_text: nullableString,
      timestamp: { bsonType: "date" },
    },
  },
};

const observationsValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["type", "session_id", "user_id", "venue_id", "gate_reason", "expires_at"],
    properties: {
      type: { enum: OBSERVATION_TYPES },
      session_id: { bsonType: "string" },
      user_id: { bsonType: "string" },
      venue_id: { bsonType: "string" },
      captured_at: { bsonType: "date" }, // photos
      spoken_at: { bsonType: "date" }, // utterances
      mentra_request_id: nullableString,
      text: nullableString, // utterance text only; never images or audio
      phash_distance: { bsonType: ["int", "long", "null"] },
      gate_reason: { enum: GATE_REASONS },
      result_memory_ids: { bsonType: "array" },
      expires_at: { bsonType: "date" },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureCollection(name, validator) {
  const exists = target.getCollectionNames().includes(name);
  if (exists) {
    target.runCommand({ collMod: name, validator, validationLevel: "strict", validationAction: "error" });
    print(`  ${name}: updated validator`);
  } else {
    target.createCollection(name, { validator, validationLevel: "strict", validationAction: "error" });
    print(`  ${name}: created`);
  }
}

function ensureIndex(collection, keys, options) {
  const name = target.getCollection(collection).createIndex(keys, options);
  print(`  ${collection}: index ${name}`);
}

function ensureVectorIndex() {
  const coll = target.getCollection("memories");
  const definition = {
    fields: [
      { type: "vector", path: "embedding", numDimensions: EMBEDDING_DIMENSIONS, similarity: "cosine" },
      { type: "filter", path: "venue_id" },
      { type: "filter", path: "visibility" },
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

  if (existing.length > 0) {
    coll.updateSearchIndex(VECTOR_INDEX_NAME, definition);
    print(`  memories: vector index ${VECTOR_INDEX_NAME} updated (status: ${existing[0].status})`);
  } else {
    coll.createSearchIndex({ name: VECTOR_INDEX_NAME, type: "vectorSearch", definition });
    print(`  memories: vector index ${VECTOR_INDEX_NAME} requested (takes a minute or two to build)`);
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
// TTL: deletes a memory once expires_at has passed. Documents with
// expires_at: null are never deleted.
ensureIndex("memories", { expires_at: 1 }, { name: "ttl_expires_at", expireAfterSeconds: 0 });
// Reconciler lookup for private items: (venue_id, owner_id, item_key) among active memories.
ensureIndex("memories", { venue_id: 1, owner_id: 1, item_key: 1, status: 1 }, { name: "lookup_owner_item" });
// Reconciler lookup for shared items: (venue_id, item_key) among active memories.
ensureIndex("memories", { venue_id: 1, item_key: 1, visibility: 1, status: 1 }, { name: "lookup_venue_item" });

ensureIndex("audit_events", { venue_id: 1, timestamp: -1 }, { name: "venue_timeline" });
ensureIndex("audit_events", { actor_id: 1, timestamp: -1 }, { name: "actor_timeline" });

ensureIndex("spaces", { members: 1 }, { name: "members" });

if (WITH_OBSERVATIONS) {
  ensureIndex("observations", { expires_at: 1 }, { name: "ttl_expires_at", expireAfterSeconds: 0 });
  ensureIndex("observations", { session_id: 1, _id: -1 }, { name: "session_recent" });
}

print("Vector search:");
ensureVectorIndex();

if (SEED_SPACES) {
  print("Seed data:");
  const spaces = target.getCollection("spaces");
  spaces.replaceOne(
    { _id: "home_vaze" },
    {
      _id: "home_vaze",
      name: "Vaze's home",
      mode: "shared_home",
      owner_id: "user_vaze",
      members: ["user_vaze", "user_guest_b"],
      allow_public_sharing: true,
      default_expires_at: null,
    },
    { upsert: true }
  );
  spaces.replaceOne(
    { _id: "stay_guest_room" },
    {
      _id: "stay_guest_room",
      name: "Guest room at Mum's",
      mode: "temporary_stay",
      owner_id: "user_vaze",
      members: ["user_vaze"],
      allow_public_sharing: false,
      default_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    { upsert: true }
  );
  print("  spaces: home_vaze, stay_guest_room");
}

print("Done.");
