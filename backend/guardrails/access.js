// Guardrail section 4: retrieval access control.
//
// The contract's visibility rule (docs/api-contract.md, Rules): a user can see a
// memory if they own it, or their role's `can_see` contains the memory's `group`
// or "*". This module turns that rule into MongoDB filters and checks results a
// second time in code.
//
// Who the caller is comes only from the request's `user_id` looked up in the
// `spaces` document. Nothing the user says ("I'm the resident") changes it.
// Note: the contract has no login, so `user_id` itself is trusted as sent.

import { GuardrailError, hasOwn, isObject } from './errors.js';

export const VECTOR_INDEX_NAME = 'memories_multimodal_vec';
export const EMBEDDING_DIMENSIONS = 1024;

// One fixed sentence for every denial, so the reply never hints at what exists,
// where it is, or who owns it. The details go in the audit entry only.
export const DENIED_REPLY = "Sorry, I can't share that with you.";
export const NOTHING_REPLY = "I don't have anything about that yet.";

// space_id and user_id go straight into MongoDB filters. Requiring a short plain
// string stops operator injection such as `{ "user_id": { "$ne": null } }`.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ITEM_KEY_PATTERN = /^[a-z0-9_]{1,80}$/;

export function requireId(value, field) {
  if (value == null || value === '') throw new GuardrailError(400, `${field} is required`);
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new GuardrailError(400, `${field} must be a short id of letters, numbers, "_" or "-"`);
  }
  return value;
}

// Builds the caller from the space document. `space` is the `spaces` document
// for the requested space_id, or null when it does not exist.
export function resolveCaller(space, userId) {
  if (!space) throw new GuardrailError(404, 'Unknown space_id');
  const id = requireId(userId, 'user_id');
  const member = Array.isArray(space.members) ? space.members.find((m) => m?.id === id) : undefined;
  // The same message whether the user is unknown everywhere or only in this space.
  if (!member) throw new GuardrailError(404, `Unknown user_id "${id}"`);

  const roles = isObject(space.rules?.roles) ? space.rules.roles : {};
  const roleRule = hasOwn(roles, member.role) ? roles[member.role] : null;
  // A role missing from the rules sees only its own memories.
  const groups = Array.isArray(roleRule?.can_see) ? roleRule.can_see.filter((g) => typeof g === 'string') : [];

  return Object.freeze({
    id,
    name: member.name,
    role: member.role,
    spaceId: space._id,
    seesAll: groups.includes('*'),
    groups: Object.freeze([...new Set(groups.filter((g) => g !== '*'))]),
  });
}

// The contract's rule, for one memory. Used to re-check every search result.
export function canSee(caller, memory) {
  if (!memory || memory.space_id !== caller.spaceId) return false;
  if (memory.owner_id === caller.id) return true;
  return caller.seesAll || caller.groups.includes(memory.group);
}

// Filter for active memories the caller may see. Written with explicit
// operators so the same object works in `$vectorSearch.filter` (which only
// accepts filter fields in the index: space_id, group, owner_id, status) and in
// an ordinary find.
export function visibleFilter(caller) {
  const base = [{ space_id: { $eq: caller.spaceId } }, { status: { $eq: 'active' } }];
  if (caller.seesAll) return { $and: base };
  const visible = caller.groups.length
    ? { $or: [{ owner_id: { $eq: caller.id } }, { group: { $in: [...caller.groups] } }] }
    : { owner_id: { $eq: caller.id } };
  return { $and: [...base, visible] };
}

// Doc 02 Step B: active memories of this item that the caller may NOT see.
// Run it only to decide between "denied" and "nothing found"; its results are
// never returned to the caller, only written to the audit entry.
// Returns null when the caller can see everything, so nothing can be hidden.
export function hiddenFilter(caller, itemKey) {
  if (caller.seesAll) return null;
  if (typeof itemKey !== 'string' || !ITEM_KEY_PATTERN.test(itemKey)) {
    throw new GuardrailError(400, 'item_key must be a lowercase slug');
  }
  const filter = {
    space_id: { $eq: caller.spaceId },
    status: { $eq: 'active' },
    item_key: { $eq: itemKey },
    owner_id: { $ne: caller.id },
  };
  if (caller.groups.length) filter.group = { $nin: [...caller.groups] };
  return filter;
}

// Only these fields leave the database. The embedding, transcripts and
// thumbnails stay behind.
const RESULT_FIELDS = [
  'space_id', 'owner_id', 'item', 'item_key', 'summary', 'location', 'topic', 'group',
  'source', 'status', 'superseded_by', 'created_at', 'updated_at', 'expires_at', 'image_url',
  'tactile_anchor', 'previous_location', 'missing_since',
];

// Doc 02 Step A as one aggregation pipeline. The access filter is inside
// $vectorSearch (a pre-filter), so hidden memories never reach the ranking.
export function vectorSearchPipeline(caller, queryVector, { limit = 5, numCandidates = 60 } = {}) {
  if (
    !Array.isArray(queryVector) ||
    queryVector.length !== EMBEDDING_DIMENSIONS ||
    !queryVector.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw new GuardrailError(500, `queryVector must be ${EMBEDDING_DIMENSIONS} finite numbers`);
  }
  const project = { _id: 1, score: { $meta: 'vectorSearchScore' } };
  for (const field of RESULT_FIELDS) project[field] = 1;
  return [
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: 'embedding',
        queryVector,
        numCandidates: Math.max(numCandidates, limit),
        limit,
        filter: visibleFilter(caller),
      },
    },
    { $project: project },
  ];
}

// Second check in code. Anything in `blocked` means a filter bug: the caller
// must not get it, and the backend should log it loudly.
export function checkResults(caller, docs) {
  const visible = [];
  const blocked = [];
  for (const doc of docs ?? []) {
    const memory = { ...doc, id: doc.id ?? String(doc._id) };
    (memory.status === 'active' && canSee(caller, memory) ? visible : blocked).push(memory);
  }
  return { visible, blocked };
}

// Spots a spoken claim to be someone else, such as "I'm the resident" or
// "as the caregiver". It never changes access; it is only noted in the audit
// entry so the dashboard shows the attempt.
export function detectIdentityClaim(text, space) {
  if (typeof text !== 'string' || !text) return null;
  const names = new Set(['owner', 'admin', 'administrator', 'resident', 'caregiver']);
  for (const role of Object.keys(isObject(space?.rules?.roles) ? space.rules.roles : {})) names.add(role);
  for (const m of space?.members ?? []) {
    if (typeof m?.name === 'string' && m.name) names.add(m.name.toLowerCase());
  }
  const escaped = [...names].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[ _]'));
  const re = new RegExp(
    `\\b(?:i am|i'm|im|this is|it's|it is|speaking as|as)\\s+(?:the |an? |your )?(${escaped.join('|')})\\b`,
    'i',
  );
  const match = re.exec(text);
  return match ? match[1].toLowerCase().replace(/ /g, '_') : null;
}

// Combines Step A and Step B into the turn result and its audit entry.
//   results:  docs from vectorSearchPipeline (with `score`), best first
//   hidden:   docs from hiddenFilter, or [] / null
//   minScore: results below this score do not count as a match (section 5 sets it)
// Returns { response, hit, audit, blocked }:
//   response: safe to send to the client as is (kind, reply_text, memory_ids)
//   hit:      the memory used for the answer, or null, for the speech layer
//   audit:    the audit entry without _id or ts; the caller adds them
export function decideAnswer({ caller, results, hidden, queryText = null, itemLabel = null, identityClaim = null, minScore = 0 }) {
  const { visible, blocked } = checkResults(caller, results);
  const hit = visible.find((m) => (m.score ?? 1) >= minScore) ?? null;
  const hiddenList = (hidden ?? []).filter((m) => m.space_id === caller.spaceId && m.status === 'active' && !canSee(caller, m));
  const claimNote = identityClaim && identityClaim !== caller.role
    ? ` Ignored a spoken claim to be ${identityClaim}; checked as role ${caller.role}.`
    : '';
  const audit = (action, verdict, detail, ids) => ({
    space_id: caller.spaceId,
    actor_id: caller.id,
    action,
    verdict,
    detail: detail + claimNote,
    memory_ids: ids,
    query_text: queryText,
  });

  if (hit) {
    const reason = hit.owner_id === caller.id ? `${caller.name} owns the memory.` : `Group ${hit.group} is visible to role ${caller.role}.`;
    return {
      response: { kind: 'answer', reply_text: hit.summary, memory_ids: [hit.id] },
      hit,
      audit: audit('query_answered', 'allowed', `Asked about ${hit.item}. ${reason}`, [hit.id]),
      blocked,
    };
  }

  if (hiddenList.length) {
    const groups = [...new Set(hiddenList.map((m) => m.group))].join(', ');
    const label = itemLabel ?? hiddenList[0].item;
    return {
      // memory_ids stays empty (contract clarification 8).
      response: { kind: 'denied', reply_text: DENIED_REPLY, memory_ids: [] },
      hit: null,
      audit: audit(
        'query_denied',
        'denied',
        `Asked about ${label}. Group ${groups} is not visible to role ${caller.role}.`,
        hiddenList.map((m) => m.id ?? String(m._id)),
      ),
      blocked,
    };
  }

  return {
    response: { kind: 'answer', reply_text: NOTHING_REPLY, memory_ids: [] },
    hit: null,
    audit: audit('query_answered', 'info', `Asked about ${itemLabel ?? 'something'}. No matching memory.`, []),
    blocked,
  };
}
