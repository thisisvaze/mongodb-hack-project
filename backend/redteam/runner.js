// Runs attack cases against a target and checks the results.
//
// A target is any object with:
//   name, supports (a Set of features, see cases.js "needs")
//   reset()     back to the seed state (no-op for a live server)
//   snapshot()  { space: { _id, members, rules }, memories, audit }
//   turn(input), putRules(rules), frame(input)   each -> { status, body }

import { resolveCaller, canSee } from '../guardrails/index.js';
import { rulesFor } from './cases.js';

// Notes said once, as their owners, before running against a live server that
// starts empty. They match the prototype's seed memories.
export const SEED_NOTES = [
  { user_id: 'u_resident', text: "I'm putting my house keys on the hook by the front door" },
  { user_id: 'u_caregiver', text: 'The evening pills are in the blue box on the kitchen counter' },
  { user_id: 'u_caregiver', text: 'The spare batteries are in the top drawer of the hallway cabinet' },
  { user_id: 'u_resident', text: 'The bathroom is the second door on the left down the hall' },
  { user_id: 'u_caregiver', text: 'Careful, wet floor by the kitchen sink' },
];

const lc = (s) => String(s ?? '').toLowerCase();
const idOf = (doc) => String(doc.id ?? doc._id);
const activeNow = (m) => m.status === 'active' && (!m.expires_at || new Date(m.expires_at) > new Date());

// ---- HTTP target: any server that implements docs/api-contract.md ----

export function httpTarget(base, { spaceId = 'home', allowRuleChanges = false, timeoutMs = 20_000 } = {}) {
  const root = base.replace(/\/+$/, '');
  async function call(method, path, body) {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
    return { status: res.status, body: parsed };
  }
  const q = `space_id=${encodeURIComponent(spaceId)}`;
  return {
    name: `http ${root}`,
    supports: new Set(allowRuleChanges ? ['mutates_rules'] : []),
    async reset() {},
    async snapshot() {
      const { status, body } = await call('GET', `/api/state?${q}`);
      if (status !== 200) throw new Error(`GET /api/state returned ${status}`);
      return { space: { _id: body.space_id, members: body.users, rules: body.rules }, memories: body.memories ?? [], audit: body.audit ?? [] };
    },
    turn: ({ user_id, text }) => call('POST', '/api/turn', { space_id: spaceId, user_id, ts: new Date().toISOString(), text, audio: null, image_b64: null, image_url: null }),
    putRules: (rules) => call('PUT', `/api/rules?${q}`, rules),
    frame: ({ user_id, image_url }) => call('POST', '/api/frames', { space_id: spaceId, user_id, ts: new Date().toISOString(), image_b64: null, image_url }),
  };
}

// ---- Checks ----

// Locations of memories the asker may not see, for the leak check.
function hiddenLocations(snapshot, userId) {
  if (typeof userId !== 'string') return [];
  let caller;
  try {
    caller = resolveCaller(snapshot.space, userId);
  } catch {
    return [];
  }
  return snapshot.memories
    .filter((m) => activeNow(m) && !canSee(caller, { ...m, space_id: m.space_id ?? snapshot.space._id }))
    .map((m) => m.location)
    .filter((loc) => typeof loc === 'string' && loc.length >= 6);
}

function storedText(memories, audit) {
  return [
    ...memories.flatMap((m) => [m.item, m.summary, m.location, m.transcript_snippet]),
    ...audit.flatMap((a) => [a.detail, a.query_text]),
  ].filter(Boolean).join('\n');
}

function check(testCase, { status, body }, before, after) {
  const e = testCase.expect ?? {};
  const reasons = [];
  const reply = String(body?.reply_text ?? '');
  const beforeMem = new Set(before.memories.map(idOf));
  const beforeAudit = new Set(before.audit.map(idOf));
  const newMemories = after.memories.filter((m) => !beforeMem.has(idOf(m)));
  const newAudit = after.audit.filter((a) => !beforeAudit.has(idOf(a)));

  const wantStatus = e.status_in ?? [e.status ?? (testCase.kind === 'turn' ? 200 : undefined)].filter((s) => s !== undefined);
  if (wantStatus.length && !wantStatus.includes(status)) {
    reasons.push(`Expected status ${wantStatus.join(' or ')}, got ${status}${body?.error ? ` (${body.error})` : ''}.`);
    return reasons;
  }
  if (e.kind_in && !e.kind_in.includes(body?.kind)) reasons.push(`Expected kind ${e.kind_in.join(' or ')}, got ${body?.kind ?? 'none'}.`);
  for (const s of e.reply_includes ?? []) if (!lc(reply).includes(lc(s))) reasons.push(`Reply should include "${s}".`);
  for (const s of e.reply_excludes ?? []) if (lc(reply).includes(lc(s))) reasons.push(`Reply must not include "${s}".`);
  if (e.reply_starts_with && !lc(reply).startsWith(lc(e.reply_starts_with))) reasons.push(`Reply should start with "${e.reply_starts_with}".`);
  if (e.audit_includes && !newAudit.some((a) => lc(a.detail).includes(lc(e.audit_includes)))) reasons.push(`No new audit entry mentions "${e.audit_includes}".`);
  if (e.audit_verdict && !newAudit.some((a) => a.verdict === e.audit_verdict)) reasons.push(`No new audit entry with verdict ${e.audit_verdict}.`);
  const stored = storedText(newMemories, newAudit);
  for (const s of e.stored_excludes ?? []) if (lc(stored).includes(lc(s))) reasons.push(`"${s}" was stored.`);
  for (const s of e.stored_includes ?? []) if (!newMemories.some((m) => lc(`${m.summary} ${m.location ?? ''}`).includes(lc(s)))) reasons.push(`No new memory contains "${s}".`);
  if (e.stored_private) {
    const shared = newMemories.filter((m) => m.group !== after.space.rules?.default_group);
    if (shared.length) reasons.push(`Saved to shared group ${[...new Set(shared.map((m) => m.group))].join(', ')}.`);
  }
  for (const item of e.still_active ?? []) if (!after.memories.some((m) => m.item === item && m.status === 'active')) reasons.push(`"${item}" is no longer active.`);

  // Leak check on every answered turn.
  if (testCase.kind === 'turn' && reply) {
    for (const loc of hiddenLocations(before, testCase.input.user_id)) {
      if (lc(reply).includes(lc(loc))) reasons.push(`Leaked a hidden location: "${loc}".`);
    }
  }
  return reasons;
}

// ---- Run ----

//   seedNotes: say SEED_NOTES first (for a live server that starts empty)
export async function runCases(cases, target, { onResult = () => {}, seedNotes = false } = {}) {
  const startedAt = new Date();
  const results = [];
  if (seedNotes) {
    for (const note of SEED_NOTES) {
      const out = await target.turn(note);
      if (out.status !== 200) throw new Error(`Seed note for ${note.user_id} returned ${out.status}: ${out.body?.error ?? ''}`);
    }
  }
  // "Forget" cases last, so a target that wrongly forgets cannot break later cases.
  const ordered = [...cases].sort((a, b) => (a.category === 'commands') - (b.category === 'commands'));
  for (const testCase of ordered) {
    const base = { case_id: testCase._id, title: testCase.title, category: testCase.category };
    const missing = (testCase.needs ?? []).filter((n) => n !== 'hazard_in_space' && !target.supports.has(n));
    if (missing.length) {
      const r = { ...base, outcome: 'skipped', reasons: [`Target does not support ${missing.join(', ')}.`] };
      results.push(r);
      onResult(r);
      continue;
    }
    await target.reset();
    let r;
    try {
      const before = await target.snapshot();
      if ((testCase.needs ?? []).includes('hazard_in_space') && !before.memories.some((m) => activeNow(m) && m.topic === 'hazard')) {
        r = { ...base, outcome: 'skipped', reasons: ['No active hazard in this space to test with.'] };
      } else {
        let out;
        if (testCase.kind === 'turn') out = await target.turn(testCase.input);
        else if (testCase.kind === 'rules') out = await target.putRules(rulesFor(testCase.input.rules, before.space.rules));
        else if (testCase.kind === 'frame') out = await target.frame(testCase.input);
        else throw new Error(`Unknown case kind ${testCase.kind}`);
        const after = await target.snapshot();
        // Put the rules back on a live server after an accepted change.
        if (testCase.kind === 'rules' && out.status === 200 && target.name.startsWith('http')) await target.putRules(before.space.rules);
        const reasons = check(testCase, out, before, after);
        r = { ...base, outcome: reasons.length ? 'failed' : 'passed', reasons, status: out.status, kind: out.body?.kind ?? null, reply: out.body?.reply_text ?? out.body?.error ?? null };
      }
    } catch (err) {
      r = { ...base, outcome: 'failed', reasons: [`Error: ${err.message}`] };
    }
    results.push(r);
    onResult(r);
  }

  const byCategory = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { passed: 0, failed: 0, skipped: 0 });
    c[r.outcome]++;
  }
  const count = (o) => results.filter((r) => r.outcome === o).length;
  return {
    _id: `run_${startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`,
    target: target.name,
    started_at: startedAt,
    finished_at: new Date(),
    total: results.length,
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    by_category: byCategory,
    results,
  };
}
