import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealFor, verifyChain, canonicalEntry, GENESIS, idOf } from '../audit/chain.js';
import { sealPending, verifySpaces } from '../audit/sealer.js';

const KEY = 'test-key';
const T0 = new Date('2026-11-14T17:00:00Z');
const at = (s) => new Date(T0.getTime() + s * 1000);
const row = (n, over = {}) => ({
  _id: `a_${String(n).padStart(2, '0')}`, ts: at(n), space_id: 'home', actor_id: 'u_visitor',
  action: 'query_denied', verdict: 'denied', detail: `Entry ${n}.`, memory_ids: ['m_04'], query_text: null, ...over,
});

// Seals rows in order, like the sealer does.
function chainOf(rows, key = KEY) {
  const seals = [];
  for (const r of rows) seals.push(sealFor({ entry: r, prev: seals.at(-1) ?? null, key, now: r.ts }));
  return seals;
}
const mapOf = (rows) => new Map(rows.map((r) => [idOf(r), r]));
const kinds = (report) => report.issues.map((i) => i.kind);

// ---- The chain itself ----

test('an untouched chain checks out', () => {
  const rows = [row(1), row(2), row(3)];
  const seals = chainOf(rows);
  assert.equal(seals[0].prev_hash, GENESIS);
  assert.equal(seals[1].prev_hash, seals[0].hash);
  assert.equal(seals[2].seq, 3);
  assert.equal(seals[0].alg, 'hmac-sha256');
  assert.deepEqual(verifyChain({ seals, entries: mapOf(rows), key: KEY }), { ok: true, checked: 3, issues: [] });
});

test('an edited row is caught, and the check names the field', () => {
  const rows = [row(1), row(2), row(3)];
  const seals = chainOf(rows);
  rows[1] = { ...rows[1], detail: 'Asked about house keys. Allowed.', verdict: 'allowed' };
  const report = verifyChain({ seals, entries: mapOf(rows), key: KEY });
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    kind: 'changed', seq: 2, id: 'a_02', fields: ['verdict', 'detail'],
    message: 'Audit row a_02 (#2) was changed after it was sealed: verdict, detail.',
  }]);
});

test('a deleted row is caught', () => {
  const rows = [row(1), row(2), row(3)];
  const seals = chainOf(rows);
  const report = verifyChain({ seals, entries: mapOf([rows[0], rows[2]]), key: KEY });
  assert.deepEqual(kinds(report), ['missing']);
  assert.match(report.issues[0].message, /a_02 \(#2\) was deleted/);
});

test('a row added by hand is caught', () => {
  const rows = [row(1), row(2)];
  const seals = chainOf(rows);
  const fake = row(9, { actor_id: 'u_resident', action: 'rule_changed', verdict: 'info', detail: 'Approved by resident.' });
  const report = verifyChain({ seals, entries: mapOf([...rows, fake]), key: KEY });
  assert.deepEqual(kinds(report), ['unsealed']);
  assert.equal(report.issues[0].id, 'a_09');
});

test('a deleted seal or a reordered chain is caught', () => {
  const rows = [row(1), row(2), row(3), row(4)];
  const seals = chainOf(rows);
  assert.deepEqual(kinds(verifyChain({ seals: seals.filter((s) => s.seq !== 2), entries: mapOf(rows), key: KEY })), ['gap', 'unsealed']);
  const swapped = seals.map((s) => (s.seq === 2 ? { ...s, seq: 3 } : s.seq === 3 ? { ...s, seq: 2 } : s));
  assert.ok(kinds(verifyChain({ seals: swapped, entries: mapOf(rows), key: KEY })).includes('broken_link'));
});

test('without the key, a forger cannot rebuild the chain', () => {
  const rows = [row(1), row(2)];
  const seals = chainOf(rows);
  // An attacker edits row 2 and re-seals it with a guessed key.
  rows[1] = { ...rows[1], detail: 'Nothing happened.' };
  const forged = [seals[0], sealFor({ entry: rows[1], prev: seals[0], key: 'guess', now: rows[1].ts })];
  const report = verifyChain({ seals: forged, entries: mapOf(rows), key: KEY });
  assert.equal(report.ok, false);
  assert.deepEqual(kinds(report), ['changed']);
});

test('the same row always gives the same text, whatever the driver returned', () => {
  const a = row(1);
  const b = { ...a, ts: new Date(a.ts.getTime()), extra_field: 'ignored', memory_ids: [...a.memory_ids] };
  assert.equal(canonicalEntry(a), canonicalEntry(b));
  const oid = { toHexString: () => '6737a1c2e4b0f1a2b3c4d5e6' };
  assert.equal(idOf({ _id: oid }), '6737a1c2e4b0f1a2b3c4d5e6');
});

test('without a key the chain still works, marked as plain sha256', () => {
  const rows = [row(1), row(2)];
  const seals = chainOf(rows, null);
  assert.equal(seals[0].alg, 'sha256');
  assert.equal(verifyChain({ seals, entries: mapOf(rows), key: null }).ok, true);
});

// ---- The sealer, against in-memory collections ----

class FakeCollection {
  constructor(docs = [], unique = []) {
    this.docs = docs;
    this.unique = unique;
  }
  matches(doc, filter) {
    return Object.entries(filter).every(([k, v]) => doc[k] === v);
  }
  find(filter = {}) {
    let out = this.docs.filter((d) => this.matches(d, filter));
    const cursor = {
      sort: (spec) => {
        const keys = Object.entries(spec);
        out = [...out].sort((a, b) => {
          for (const [k, dir] of keys) {
            if (a[k] < b[k]) return -dir;
            if (a[k] > b[k]) return dir;
          }
          return 0;
        });
        return cursor;
      },
      limit: (n) => {
        out = out.slice(0, n);
        return cursor;
      },
      toArray: async () => out,
    };
    return cursor;
  }
  async findOne(filter) {
    return this.docs.find((d) => this.matches(d, filter)) ?? null;
  }
  async distinct(field, filter = {}) {
    return [...new Set(this.docs.filter((d) => this.matches(d, filter)).map((d) => d[field]))];
  }
  async insertOne(doc) {
    for (const fields of [['_id'], ...this.unique]) {
      if (this.docs.some((d) => fields.every((f) => d[f] === doc[f]))) throw Object.assign(new Error('duplicate key'), { code: 11000 });
    }
    this.docs.push(doc);
  }
}

test('the sealer seals new rows in time order and is safe to run again', async () => {
  const audit = new FakeCollection([row(2), row(1), row(3, { space_id: 'stay_guest_room' })]);
  const chain = new FakeCollection([], [['space_id', 'seq']]);
  const now = at(10);
  assert.deepEqual(await sealPending({ audit, chain, key: KEY, now }), { sealed: 3, late: [], conflicts: 0 });
  assert.deepEqual(chain.docs.filter((s) => s.space_id === 'home').map((s) => [s._id, s.seq]), [['a_01', 1], ['a_02', 2]]);
  assert.deepEqual(await sealPending({ audit, chain, key: KEY, now }), { sealed: 0, late: [], conflicts: 0 });

  audit.docs.push(row(5));
  assert.equal((await sealPending({ audit, chain, key: KEY, now: at(12) })).sealed, 1);
  const reports = await verifySpaces({ audit, chain, key: KEY });
  assert.deepEqual(reports.map((r) => [r.spaceId, r.ok, r.checked]), [['home', true, 3], ['stay_guest_room', true, 1]]);
});

test('old or back-dated rows are not sealed, so they show up as unsealed', async () => {
  const audit = new FakeCollection([row(1), row(2)]);
  const chain = new FakeCollection([], [['space_id', 'seq']]);
  await sealPending({ audit, chain, key: KEY, now: at(5) });
  // A row slipped in with an earlier time than the last sealed one.
  audit.docs.push(row(0, { _id: 'a_fake', detail: 'Back-dated.' }));
  // And a row that was only noticed much later.
  audit.docs.push(row(3, { _id: 'a_old' }));
  const out = await sealPending({ audit, chain, key: KEY, now: at(3 + 120) });
  assert.deepEqual(out.late.sort(), ['a_fake', 'a_old']);
  const [report] = await verifySpaces({ audit, chain, key: KEY, spaceId: 'home' });
  assert.deepEqual(kinds(report).sort(), ['unsealed', 'unsealed']);
});

test('adoptExisting seals history once, when a chain starts', async () => {
  const audit = new FakeCollection([row(1), row(2)]);
  const chain = new FakeCollection([], [['space_id', 'seq']]);
  assert.deepEqual((await sealPending({ audit, chain, key: KEY, now: at(100_000) })).late, ['a_01', 'a_02']);
  assert.equal((await sealPending({ audit, chain, key: KEY, now: at(100_000), adoptExisting: true })).sealed, 2);
});

test('tampering after sealing is found by the space check', async () => {
  const audit = new FakeCollection([row(1), row(2), row(3)]);
  const chain = new FakeCollection([], [['space_id', 'seq']]);
  await sealPending({ audit, chain, key: KEY, now: at(5) });
  audit.docs[1].detail = 'Edited in Atlas.';
  audit.docs.splice(2, 1);
  const [report] = await verifySpaces({ audit, chain, key: KEY, spaceId: 'home' });
  assert.deepEqual(kinds(report), ['changed', 'missing']);
});
