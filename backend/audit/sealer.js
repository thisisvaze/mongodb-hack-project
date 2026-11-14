// Tamper-evident audit log: the database side.
//
// The sealer runs next to the backend and seals every new `audit_events` row
// into `audit_chain`. It needs no change to the code that writes audit rows,
// so it works with the Rust pipeline as it is.
//
// What it can and cannot prove:
//   - A row changed or deleted after it was sealed is always caught.
//   - A row added by hand later, back-dated, or while the sealer was down stays
//     unsealed and is reported.
//   - A fake row inserted with the current time while the sealer is running is
//     sealed like a real one. Closing that needs the backend to seal rows itself
//     as it writes them (a later step for the Rust side).

import { idOf, sealFor, verifyChain } from './chain.js';

export const LATE_MS = 60_000; // rows older than this when first seen are not sealed

const DUPLICATE_KEY = 11000;

export async function ensureChainIndexes(chain) {
  // One seal per position: two sealers racing cannot both write seal N.
  await chain.createIndex({ space_id: 1, seq: 1 }, { unique: true, name: 'space_seq' });
}

async function headOf(chain, spaceId) {
  const [head] = await chain.find({ space_id: spaceId }).sort({ seq: -1 }).limit(1).toArray();
  return head ?? null;
}

// Seals every unsealed row, in time order, for one space or all of them.
//   adoptExisting: seal rows of any age; use once, when starting a new chain
// Returns { sealed, late, conflicts } where late lists ids left unsealed.
export async function sealPending({ audit, chain, key, spaceId = null, adoptExisting = false, lateMs = LATE_MS, now = new Date() }) {
  const spaces = spaceId ? [spaceId] : await audit.distinct('space_id');
  const result = { sealed: 0, late: [], conflicts: 0 };

  for (const space of spaces) {
    let head = await headOf(chain, space);
    const sealedIds = new Set((await chain.distinct('_id', { space_id: space })).map(String));
    const rows = await audit.find({ space_id: space }).sort({ ts: 1, _id: 1 }).toArray();

    for (const row of rows) {
      const id = idOf(row);
      if (sealedIds.has(id)) continue;
      const ts = new Date(row.ts);
      const tooOld = now.getTime() - ts.getTime() > lateMs;
      const beforeHead = head?.entry_ts && ts < new Date(head.entry_ts);
      if (!adoptExisting && (tooOld || beforeHead)) {
        result.late.push(id);
        continue;
      }
      const seal = { ...sealFor({ entry: row, prev: head, key, now }), entry_ts: row.ts };
      try {
        await chain.insertOne(seal);
      } catch (err) {
        if (err?.code === DUPLICATE_KEY) {
          result.conflicts++;
          break; // another sealer got there first; the next run picks up from its seal
        }
        throw err;
      }
      head = seal;
      result.sealed++;
    }
  }
  return result;
}

// Checks one space, or every space that has audit rows or seals.
// Returns [{ spaceId, ok, checked, issues }].
export async function verifySpaces({ audit, chain, key, spaceId = null }) {
  const spaces = spaceId ? [spaceId] : [...new Set([...(await audit.distinct('space_id')), ...(await chain.distinct('space_id'))])].sort();
  const reports = [];
  for (const space of spaces) {
    const seals = await chain.find({ space_id: space }).toArray();
    const rows = await audit.find({ space_id: space }).toArray();
    const entries = new Map(rows.map((r) => [idOf(r), r]));
    reports.push({ spaceId: space, ...verifyChain({ seals, entries, key }) });
  }
  return reports;
}

// Watches audit_events: seals each new row straight away, and checks the space
// again whenever a row is edited, replaced or deleted. `onEvent` receives
//   { type: 'sealed', spaceId, count } or { type: 'tamper', spaceId, change, report }
export async function watchAndSeal({ audit, chain, key, onEvent = () => {}, signal }) {
  const stream = audit.watch([], { fullDocumentBeforeChange: 'off' });
  signal?.addEventListener('abort', () => stream.close());
  for await (const change of stream) {
    if (change.operationType === 'insert') {
      const spaceId = change.fullDocument?.space_id;
      const out = await sealPending({ audit, chain, key, spaceId });
      if (out.sealed) onEvent({ type: 'sealed', spaceId, count: out.sealed });
      continue;
    }
    if (['update', 'replace', 'delete'].includes(change.operationType)) {
      // A deleted row's space is only known from its seal.
      const id = String(change.documentKey?._id);
      const seal = await chain.findOne({ _id: id });
      const spaceId = seal?.space_id ?? change.fullDocument?.space_id;
      if (!spaceId) continue;
      const [report] = await verifySpaces({ audit, chain, key, spaceId });
      onEvent({ type: 'tamper', spaceId, change: { operationType: change.operationType, id }, report });
    }
  }
}
