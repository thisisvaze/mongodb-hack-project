// Tamper-evident audit log: the hash chain.
//
// Every row in `audit_events` gets a seal in `audit_chain`:
//   { _id: <audit row id>, space_id, seq, prev_hash, hash, fields, alg, sealed_at }
// - `hash` covers the row's contents, its position (seq) and the previous seal's
//   hash, so changing, deleting, inserting or reordering a row breaks the chain.
// - `fields` holds one hash per field, so a check can say which field changed.
// - With a secret key (AUDIT_CHAIN_KEY) the hashes are HMACs: someone who can
//   write to the database but does not have the key cannot rebuild the chain.
//
// One chain per space, because audit rows belong to a space.
// Pure functions only; the database side is in sealer.js.

import { createHash, createHmac } from 'node:crypto';

export const GENESIS = '0'.repeat(64);

// The contract's AuditEntry fields plus query_text. These are what is sealed.
export const SEALED_FIELDS = ['_id', 'ts', 'space_id', 'actor_id', 'action', 'verdict', 'detail', 'memory_ids', 'query_text'];

// One stable text form for a value, whatever the driver returned.
function canonical(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && typeof value.toHexString === 'function') return value.toHexString(); // ObjectId
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

export const idOf = (doc) => String(canonical(doc._id));

// The row as one string, fields always in the same order.
export function canonicalEntry(doc) {
  return JSON.stringify(SEALED_FIELDS.map((f) => [f, canonical(doc[f])]));
}

function digest(key, text) {
  return key ? createHmac('sha256', key).update(text).digest('hex') : createHash('sha256').update(text).digest('hex');
}

export const algorithmFor = (key) => (key ? 'hmac-sha256' : 'sha256');

export function fieldHashes(doc, key) {
  const out = {};
  for (const f of SEALED_FIELDS) out[f] = digest(key, `${f}=${JSON.stringify(canonical(doc[f]))}`);
  return out;
}

export function linkHash({ spaceId, seq, prevHash, entry, key }) {
  return digest(key, `${spaceId}|${seq}|${prevHash}|${canonicalEntry(entry)}`);
}

// The seal for `entry`, following `prev` (the space's latest seal, or null).
export function sealFor({ entry, prev, key, now = new Date() }) {
  const seq = prev ? prev.seq + 1 : 1;
  const prevHash = prev ? prev.hash : GENESIS;
  return {
    _id: idOf(entry),
    space_id: entry.space_id,
    seq,
    prev_hash: prevHash,
    hash: linkHash({ spaceId: entry.space_id, seq, prevHash, entry, key }),
    fields: fieldHashes(entry, key),
    alg: algorithmFor(key),
    sealed_at: now,
  };
}

// Checks one space's chain.
//   seals:    that space's seals, in any order
//   entries:  Map of audit row id -> row, for that space
//   key:      the same key the seals were made with
// Returns { ok, checked, issues }. Each issue is
//   { kind, seq, id, message, fields? } with kind one of:
//   changed      the row was edited after it was sealed (fields lists which)
//   missing      the row was deleted
//   unsealed     a row with no seal: added by hand, or the sealer was not running
//   gap          a seal is missing from the sequence (a seal was deleted)
//   broken_link  a seal does not follow the one before it (seals edited or reordered)
//   bad_seal     a seal's own hash is wrong (edited without the key, or another key)
export function verifyChain({ seals, entries, key }) {
  const issues = [];
  const ordered = [...seals].sort((a, b) => a.seq - b.seq);
  const sealedIds = new Set(ordered.map((s) => s._id));
  let expectedSeq = 1;
  let expectedPrev = GENESIS;

  for (const seal of ordered) {
    if (seal.seq !== expectedSeq) {
      issues.push({ kind: 'gap', seq: expectedSeq, id: null, message: `Seals ${expectedSeq} to ${seal.seq - 1} are missing. Someone deleted part of the chain.` });
    } else if (seal.prev_hash !== expectedPrev) {
      issues.push({ kind: 'broken_link', seq: seal.seq, id: seal._id, message: `Seal ${seal.seq} does not follow seal ${seal.seq - 1}. The chain was edited or reordered.` });
    }

    const entry = entries.get(seal._id);
    if (!entry) {
      issues.push({ kind: 'missing', seq: seal.seq, id: seal._id, message: `Audit row ${seal._id} (#${seal.seq}) was deleted.` });
    } else {
      const expected = linkHash({ spaceId: seal.space_id, seq: seal.seq, prevHash: seal.prev_hash, entry, key });
      if (expected !== seal.hash) {
        const now = fieldHashes(entry, key);
        const changed = SEALED_FIELDS.filter((f) => seal.fields?.[f] !== now[f]);
        if (changed.length) {
          issues.push({ kind: 'changed', seq: seal.seq, id: seal._id, fields: changed, message: `Audit row ${seal._id} (#${seal.seq}) was changed after it was sealed: ${changed.join(', ')}.` });
        } else {
          issues.push({ kind: 'bad_seal', seq: seal.seq, id: seal._id, message: `Seal ${seal.seq} was altered, or was made with a different key.` });
        }
      }
    }
    // Carry on from this seal, so one break is reported once instead of everywhere after it.
    expectedSeq = seal.seq + 1;
    expectedPrev = seal.hash;
  }

  for (const [id, entry] of entries) {
    if (!sealedIds.has(id)) {
      issues.push({ kind: 'unsealed', seq: null, id, message: `Audit row ${id} (${entry.action}, ${canonical(entry.ts)}) has no seal: it was added by hand, or while the sealer was not running.` });
    }
  }

  return { ok: issues.length === 0, checked: ordered.length, issues };
}
