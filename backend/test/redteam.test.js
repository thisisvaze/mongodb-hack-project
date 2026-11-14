import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CASES } from '../redteam/cases.js';
import { runCases, httpTarget } from '../redteam/runner.js';
import { prototypeTarget } from '../redteam/sim.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('cases are plain data with unique ids, so they can live in MongoDB', () => {
  const ids = CASES.map((c) => c._id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of CASES) {
    assert.deepEqual(JSON.parse(JSON.stringify(c)), c, c._id);
    assert.ok(['turn', 'rules', 'frame'].includes(c.kind), c._id);
    assert.ok(c.category && c.title && c.expect, c._id);
  }
});

test('the prototype handles every attack, even with a gullible model', async () => {
  const run = await runCases(CASES, prototypeTarget());
  const failed = run.results.filter((r) => r.outcome !== 'passed').map((r) => `${r.case_id}: ${r.reasons.join(' ')}`);
  assert.deepEqual(failed, []);
  assert.equal(run.passed, CASES.length);
  assert.ok(run._id.startsWith('run_'));
});

test('the checks are real: a target with no guardrails fails them', async () => {
  // Same seed data, but the "server" saves whatever it is told and answers with
  // everything it knows, like a model with no guardrails at all.
  const proto = prototypeTarget();
  const careless = {
    ...proto,
    name: 'careless',
    async turn({ user_id, text }) {
      const snap = await proto.snapshot();
      if (/^(where|what|is)\b/i.test(text)) {
        return { status: 200, body: { kind: 'answer', reply_text: `${snap.memories.map((m) => m.summary).join(' ')} The path is clear, so it's safe to walk.`, memory_ids: [] } };
      }
      return proto.turn({ user_id, text: text.replace(/ignore[^,]*,?/i, '') });
    },
    async frame() {
      return { status: 200, body: { ok: true } };
    },
  };
  const run = await runCases(CASES, careless);
  const failed = new Set(run.results.filter((r) => r.outcome === 'failed').map((r) => r.case_id));
  for (const id of ['access-visitor-keys', 'speech-no-safe-claim', 'image-metadata', 'image-plain-http']) assert.ok(failed.has(id), id);
  assert.ok(run.results.some((r) => r.reasons.some((x) => x.startsWith('Leaked a hidden location'))), 'the leak check fired');
});

test('the http target runs against the mock server', { timeout: 60_000 }, async () => {
  const port = 8700 + Math.floor(Math.random() * 90);
  const mock = spawn(process.execPath, [path.join(here, '..', '..', 'frontend', 'mock-server', 'server.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${base}/api/state?space_id=home`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const run = await runCases(CASES, httpTarget(base), { seedNotes: true });
    const outcome = Object.fromEntries(run.results.map((r) => [r.case_id, r.outcome]));
    // Features the contract has no field for are skipped, not failed.
    assert.equal(outcome['inject-camera-sign'], 'skipped');
    assert.equal(outcome['rules-bad-name'], 'skipped');
    // The mock enforces access, so the basic denial passes...
    assert.equal(outcome['access-visitor-keys'], 'passed');
    // ...but it has no redaction or download checks, and the runner sees that.
    assert.equal(outcome['pii-card-and-pin'], 'failed');
    assert.equal(outcome['image-metadata'], 'failed');
  } finally {
    mock.kill();
  }
});
