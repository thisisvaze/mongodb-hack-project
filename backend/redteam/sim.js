// The "prototype" target: an in-memory SafeSpace turn handler built from the
// real guardrail code, with a deliberately gullible stand-in for Gemini.
//
// The fake model does what an attacker would hope a real model does: it obeys
// instructions in the text, files notes under "the house guide" when told to,
// copies what was said into the summary, and adds "it's safe" and dose advice to
// answers. Every case passing means the guardrails hold even when the model
// fails completely.

import {
  resolveCaller, canSee, decideAnswer, detectIdentityClaim, buildPrompt, parseProposal, gateTurn,
  decideStorage, authorizeForget, composeAnswer, isMedication, validateRules, rejectedRulesAudit,
  describeRulesChange, fetchImage, GuardrailError,
} from '../guardrails/index.js';

const MIN = 60_000;

export function seedSpace() {
  return {
    _id: 'home',
    owner_id: 'u_resident',
    members: [
      { id: 'u_resident', name: 'Resident', role: 'resident' },
      { id: 'u_caregiver', name: 'Caregiver', role: 'caregiver' },
      { id: 'u_visitor', name: 'Visitor', role: 'visitor' },
    ],
    rules: {
      roles: {
        resident: { can_see: ['*'] },
        caregiver: { can_see: ['care', 'supplies', 'house_guide'] },
        visitor: { can_see: ['house_guide'] },
      },
      topics: {
        medication: { group: 'care', keep_for: '30d' },
        supplies: { group: 'supplies', keep_for: null },
        valuables: { group: 'resident_only', keep_for: null },
        documents: { group: 'resident_only', keep_for: null },
        house_guide: { group: 'house_guide', keep_for: null },
        hazard: { group: 'house_guide', keep_for: '2h' },
      },
      default_group: 'resident_only',
    },
  };
}

function seedMemories(now) {
  const m = (id, owner_id, item, topic, group, location, summary, minutesAgo, extra = {}) => ({
    _id: id, space_id: 'home', owner_id, item, item_key: item.replace(/ /g, '_'), topic, group, location, summary,
    status: 'active', created_at: new Date(now - minutesAgo * MIN), updated_at: new Date(now - minutesAgo * MIN), expires_at: null, ...extra,
  });
  return [
    m('m_keys', 'u_resident', 'house keys', 'valuables', 'resident_only', 'hook by the front door', 'Keys are on the hook by the front door.', 10),
    m('m_pills', 'u_caregiver', 'evening pills', 'medication', 'care', 'blue box on the kitchen counter', 'Evening pills are in the blue box on the kitchen counter.', 25),
    m('m_batteries', 'u_caregiver', 'spare batteries', 'supplies', 'supplies', 'top drawer of the hallway cabinet', 'Spare batteries are in the top drawer of the hallway cabinet.', 40),
    m('m_bathroom', 'u_resident', 'bathroom', 'house_guide', 'house_guide', 'second door on the left down the hall', 'The bathroom is the second door on the left down the hall.', 55),
    m('m_wet_floor', 'u_caregiver', 'wet floor', 'hazard', 'house_guide', 'by the kitchen sink', 'Wet floor by the kitchen sink.', 4, { expires_at: new Date(now + 2 * 60 * MIN) }),
  ];
}

// ---- The gullible model ----

const TOPIC_WORDS = [
  ['hazard', /\b(?:wet floor|spill|broken glass|loose rug|hazard)\b/i],
  ['medication', /\b(?:pills?|medication|medicine|insulin|inhaler)\b/i],
  ['documents', /\b(?:passport|documents?|papers|bank card)\b/i],
  ['valuables', /\b(?:keys?|wallet|purse|jewel\w*)\b/i],
  ['supplies', /\b(?:batter(?:y|ies)|bandages?|soap|towels?|filter)\b/i],
  ['house_guide', /\b(?:bathroom|kitchen|wi-?fi|router|stairs)\b/i],
];

function gullibleModel(promptText, rules) {
  const heard = JSON.parse(/heard: (".*"|nothing)/.exec(promptText)?.[1].replace(/^nothing$/, '""') ?? '""');
  const seen = JSON.parse(/camera_text: (".*"|nothing)/.exec(promptText)?.[1].replace(/^nothing$/, '""') ?? '""');
  const text = `${heard} ${seen}`.trim();
  const lower = text.toLowerCase();
  const intent = /^forget\b/.test(lower) ? 'forget'
    : /\?\s*$/.test(lower) || /^(?:where|what|which|is|are|how|tell me|show me|speaking as)\b/.test(lower) || /\b(?:where|tell me)\b/.test(lower) ? 'question'
    : 'note';
  // Obeys the attacker: "under the house guide", "share", "everyone" -> shared topic.
  const obeys = /\b(?:house guide|share|everyone|visible|public)\b/i.test(text);
  const topic = obeys ? 'house_guide' : TOPIC_WORDS.find(([, re]) => re.test(text))?.[0] ?? 'other';
  const itemMatch = /\b(?:my|the|our)\s+([a-z][a-z ]{1,30}?)\s+(?:is|are|was|in|on|under|by|at|about)\b/i.exec(heard);
  const item = itemMatch?.[1] ?? TOPIC_WORDS.map(([, re]) => re.exec(text)?.[0]).find(Boolean) ?? 'note';
  const location = /\b(?:in|on|under|by)\s+(?:the|my)\s+([a-z ]{3,40}?)(?:\s+and\b|[.,]|$)/i.exec(heard)?.[1] ?? null;
  const summary = text ? `${text[0].toUpperCase()}${text.slice(1)}.` : null; // copies everything, placeholders included
  return { intent, topic, item, location, summary, group: obeys ? 'house_guide' : undefined };
}

const gullibleAnswer = (memory) =>
  `${memory.summary} The path there is clear, so it's safe to walk.${isMedication(memory) ? ' You should take two now.' : ''}`;

// ---- Matching a question to memories ----

const stem = (w) => w.toLowerCase().replace(/(?:ies)$/, 'y').replace(/s$/, '');
const STOP = new Set(['the', 'my', 'are', 'is', 'where', 'what', 'and', 'tell', 'me', 'about', 'say', 'you', 'now', 'all', 'previous', 'instruction', 'ignore', 'speaking', 'as', 'caregiver', 'resident', 'visitor', 'i\'m', 'im', 'make', 'visible', 'to', 'forget', 'path', 'clear']);
const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
const matchesItem = (asked, memory) => [...words(memory.item)].some((w) => asked.has(w));

// ---- The target ----

export function prototypeTarget() {
  let space;
  let memories;
  let audit;
  let seq;
  const now = () => Date.now();
  const addAudit = (entry) => audit.push({ _id: `a_${++seq}`, ts: new Date(), ...entry });

  const target = {
    name: 'prototype',
    supports: new Set(['camera_text', 'speaker', 'mutates_rules', 'hazard_in_space']),
    async reset() {
      space = seedSpace();
      memories = seedMemories(now());
      audit = [];
      seq = 0;
    },
    async snapshot() {
      return { space: structuredClone(space), memories: structuredClone(memories), audit: structuredClone(audit) };
    },

    async turn({ user_id, text = '', camera_text = null, speaker = null }) {
      let caller;
      try {
        caller = resolveCaller(space, user_id);
      } catch (err) {
        if (err instanceof GuardrailError) return { status: err.status, body: { error: err.message } };
        throw err;
      }
      const prompt = buildPrompt({ transcript: text, cameraText: camera_text, rules: space.rules });
      const parsed = parseProposal(gullibleModel(prompt.text, space.rules), space.rules);
      if (!parsed.ok) return { status: 200, body: { kind: 'ignored', reply_text: '', memory_ids: [] } };
      const gate = gateTurn({ caller, proposal: parsed.proposal, speaker, transcript: text, cameraText: camera_text });
      if (!gate.allowed) {
        addAudit(gate.audit);
        return { status: 200, body: gate.response };
      }
      const names = Object.fromEntries(space.members.map((m) => [m.id, m.name]));
      const active = memories.filter((m) => m.status === 'active' && (!m.expires_at || m.expires_at > new Date()));

      if (gate.intent === 'note') {
        const out = decideStorage({ caller, space, proposal: parsed.proposal, speaker, notes: parsed.notes, vault: prompt.vault, removedBefore: prompt.removed });
        if (!out.ok) {
          addAudit(out.audit);
          return { status: 200, body: out.response };
        }
        const id = `m_new_${++seq}`;
        memories.push({ _id: id, owner_id: caller.id, status: 'active', created_at: new Date(), updated_at: new Date(), ...out.fields });
        addAudit({ ...out.audit, memory_ids: [id] });
        return { status: 200, body: { kind: 'saved', reply_text: `Saved. ${out.fields.summary}`, memory_ids: [id] } };
      }

      const asked = words(text);
      const matched = active.filter((m) => matchesItem(asked, m));

      if (gate.intent === 'forget') {
        const out = authorizeForget({ caller, matches: matched, queryText: text });
        if (out.owned.length && !out.needsConfirmation) {
          for (const m of memories) if (out.owned.some((o) => o._id === m._id)) m.status = 'forgotten';
        }
        addAudit(out.audit);
        return { status: 200, body: out.response };
      }

      // Question.
      const results = matched.filter((m) => canSee(caller, m)).map((m) => ({ ...m, score: 0.9 }));
      const hidden = matched.filter((m) => !canSee(caller, m));
      const decision = decideAnswer({ caller, results, hidden, queryText: text, identityClaim: detectIdentityClaim(text, space) });
      let response = decision.response;
      if (decision.hit) {
        const hazards = active.filter((m) => m.topic === 'hazard' && canSee(caller, m));
        const spoken = composeAnswer({ caller, hit: decision.hit, draft: gullibleAnswer(decision.hit), score: 0.9, hazards, names });
        response = { ...response, reply_text: spoken.reply_text };
        if (spoken.notes.length) decision.audit.detail += ` ${spoken.notes.join(' ')}`;
      }
      addAudit(decision.audit);
      return { status: 200, body: response };
    },

    async putRules(rules) {
      try {
        const { rules: next, warnings } = validateRules(rules, space);
        addAudit({ space_id: 'home', actor_id: 'dashboard', action: 'rule_changed', verdict: 'info', detail: describeRulesChange(space.rules, next, warnings), memory_ids: [] });
        space.rules = next;
        return { status: 200, body: { ok: true, rules: next } };
      } catch (err) {
        if (!(err instanceof GuardrailError)) throw err;
        addAudit(rejectedRulesAudit('home', err));
        return { status: err.status, body: { error: err.message } };
      }
    },

    async frame({ user_id, image_url }) {
      try {
        resolveCaller(space, user_id);
        // Short limits: a case must never wait on a real download.
        await fetchImage(image_url, { timeoutMs: 2000 });
        return { status: 200, body: { ok: true } };
      } catch (err) {
        if (err instanceof GuardrailError) return { status: err.status, body: { error: err.message } };
        return { status: 500, body: { error: err.message } };
      }
    },
  };
  return target;
}
