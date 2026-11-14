#!/usr/bin/env node
// MOCK of docs/api-contract.md for frontend development.
// In-memory state, keyword logic, no AI, no database. Not the real backend.
// Node built-ins only: `node frontend/mock-server/server.mjs`

import http from 'node:http';

const PORT = Number(process.env.PORT) || 8787;
// Loopback only by default. Set HOST=0.0.0.0 to accept connections from other machines.
const HOST = process.env.HOST || '';
// Image URLs are built from each request's Host header. Set PUBLIC_BASE to force one base URL.
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/+$/, '');

const SPACE_ID = 'home';
// The contract asks for at least 2 MB, so a 25 second recording fits as base64.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PING_MS = 15_000;
const EXPIRY_SWEEP_MS = 2_000;
const AUDIT_SNAPSHOT_LIMIT = 200;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const startedAt = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const now = () => iso(Date.now());
const minutesAgo = (n) => iso(startedAt - n * 60_000);

const state = {
  users: [
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
  // Newest first. `image_url` is either null, an absolute external URL, or a
  // path on this server that is made absolute per request (see toWire).
  memories: [
    {
      id: 'm_04',
      space_id: SPACE_ID,
      owner_id: 'u_resident',
      item: 'house keys',
      summary: 'Keys are on the hook by the front door.',
      location: 'hook by the front door',
      topic: 'valuables',
      group: 'resident_only',
      source: 'voice',
      status: 'active',
      superseded_by: null,
      created_at: minutesAgo(10),
      updated_at: minutesAgo(10),
      expires_at: null,
      image_url: null,
    },
    {
      id: 'm_03',
      space_id: SPACE_ID,
      owner_id: 'u_caregiver',
      item: 'evening pills',
      summary: 'Evening pills are in the blue box on the kitchen counter.',
      location: 'blue box on the kitchen counter',
      topic: 'medication',
      group: 'care',
      source: 'both',
      status: 'active',
      superseded_by: null,
      created_at: minutesAgo(25),
      updated_at: minutesAgo(25),
      expires_at: iso(startedAt - 25 * 60_000 + 30 * 86_400_000),
      image_url: null,
    },
    {
      id: 'm_02',
      space_id: SPACE_ID,
      owner_id: 'u_caregiver',
      item: 'spare batteries',
      summary: 'Spare batteries are in the top drawer of the hallway cabinet.',
      location: 'top drawer of the hallway cabinet',
      topic: 'supplies',
      group: 'supplies',
      source: 'camera',
      status: 'active',
      superseded_by: null,
      created_at: minutesAgo(40),
      updated_at: minutesAgo(40),
      expires_at: null,
      image_url: null,
    },
    {
      id: 'm_01',
      space_id: SPACE_ID,
      owner_id: 'u_resident',
      item: 'bathroom',
      summary: 'The bathroom is the second door on the left down the hall.',
      location: 'second door on the left down the hall',
      topic: 'house_guide',
      group: 'house_guide',
      source: 'voice',
      status: 'active',
      superseded_by: null,
      created_at: minutesAgo(55),
      updated_at: minutesAgo(55),
      expires_at: null,
      image_url: null,
    },
  ],
  // Newest first.
  audit: [
    {
      id: 'a_03',
      ts: minutesAgo(6),
      space_id: SPACE_ID,
      actor_id: 'u_visitor',
      action: 'query_denied',
      verdict: 'denied',
      detail: 'Asked about house keys. Group resident_only is not visible to role visitor.',
      memory_ids: ['m_04'],
    },
    {
      id: 'a_02',
      ts: minutesAgo(8),
      space_id: SPACE_ID,
      actor_id: 'u_caregiver',
      action: 'query_answered',
      verdict: 'allowed',
      detail: 'Asked about evening pills. Group care is visible to role caregiver.',
      memory_ids: ['m_03'],
    },
    {
      id: 'a_01',
      ts: minutesAgo(10),
      space_id: SPACE_ID,
      actor_id: 'u_resident',
      action: 'memory_stored',
      verdict: 'info',
      detail: 'Stored house keys in group resident_only (topic valuables).',
      memory_ids: ['m_04'],
    },
  ],
};

let memorySeq = state.memories.length;
let auditSeq = state.audit.length;
const nextId = (prefix, n) => `${prefix}_${String(n).padStart(2, '0')}`;

const latestFrames = new Map(); // user_id -> { ts, buf, url, version }
const latestAudio = new Map(); // user_id -> { ts, format, sampleRate, channels, buf }
const memoryImages = new Map(); // memory_id -> Buffer
const sseClients = new Set(); // { res, base }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function log(...parts) {
  console.log(`[mock ${new Date().toTimeString().slice(0, 8)}]`, ...parts);
}

function baseOf(req) {
  if (PUBLIC_BASE) return PUBLIC_BASE;
  const first = (value) => String(value).split(',')[0].trim();
  const proto = first(req.headers['x-forwarded-proto'] || 'http');
  const host = first(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`);
  return `${proto}://${host}`;
}

const absolute = (url, base) => (url && url.startsWith('/') ? base + url : url);
const toWire = (memory, base) => ({ ...memory, image_url: absolute(memory.image_url, base) });

function emit(event, build) {
  for (const client of sseClients) {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(build(client.base))}\n\n`);
  }
}

function addAudit(actorId, action, verdict, detail, memoryIds = []) {
  const entry = {
    id: nextId('a', ++auditSeq),
    ts: now(),
    space_id: SPACE_ID,
    actor_id: actorId,
    action,
    verdict,
    detail,
    memory_ids: memoryIds,
  };
  state.audit.unshift(entry);
  if (state.audit.length > 1000) state.audit.length = 1000;
  emit('audit', () => ({ entry }));
  return entry;
}

function emitMemory(op, memory) {
  emit('memory', (base) => ({ op, memory: toWire(memory, base) }));
}

// The contract's visibility rule.
function canSee(user, memory, rules) {
  if (memory.owner_id === user.id) return true;
  const groups = rules.roles?.[user.role]?.can_see ?? [];
  return groups.includes('*') || groups.includes(memory.group);
}

function parseKeepFor(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\s*([smhdw])$/.exec(value.trim());
  if (!match) return null;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
  return Number(match[1]) * unit;
}

const userName = (id) => state.users.find((u) => u.id === id)?.name ?? id;
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// Keyword logic (stands in for the real backend's language model)
// ---------------------------------------------------------------------------

// Checked in this order; the first topic with a keyword in the text wins.
const TOPIC_KEYWORDS = [
  ['hazard', ['hazard', 'wet floor', 'spill', 'spilled', 'broken glass', 'slippery', 'careful', 'watch out', 'warning', 'loose rug', 'trip hazard', 'obstacle', 'blocking', 'blocked']],
  ['medication', ['medication', 'medications', 'medicine', 'meds', 'pill', 'pills', 'tablets', 'insulin', 'inhaler', 'prescription', 'eye drops']],
  ['documents', ['passport', 'document', 'documents', 'papers', 'paperwork', 'insurance', 'health card', 'birth certificate', 'bank statement', 'lease']],
  ['valuables', ['key', 'keys', 'wallet', 'purse', 'phone', 'cash', 'money', 'credit card', 'bank card', 'jewelry', 'jewellery', 'ring', 'necklace', 'laptop']],
  ['supplies', ['supplies', 'battery', 'batteries', 'bandage', 'bandages', 'first aid', 'gloves', 'toilet paper', 'tissues', 'soap', 'towel', 'towels', 'light bulbs', 'bulbs', 'detergent', 'groceries']],
  ['house_guide', ['bathroom', 'washroom', 'toilet', 'kitchen', 'bedroom', 'light switch', 'thermostat', 'wifi', 'wi-fi', 'fuse box', 'breaker', 'front door', 'back door', 'stairs', 'staircase', 'garbage', 'recycling', 'laundry', 'washer', 'dryer', 'doorbell', 'mailbox', 'water station', 'kettle', 'microwave', 'fridge']],
];

const ITEM_ALIASES = {
  key: 'house keys',
  keys: 'house keys',
  'house key': 'house keys',
  meds: 'medication',
  medicine: 'medication',
  cellphone: 'phone',
  'cell phone': 'phone',
  'mobile phone': 'phone',
};

const QUERY_SYNONYMS = {
  medicine: 'medication',
  med: 'medication',
  washroom: 'bathroom',
  restroom: 'bathroom',
  toilet: 'bathroom',
  cellphone: 'phone',
  mobile: 'phone',
};

// Longer phrases first so "next to" wins over a later "in".
const PREPOSITIONS = ['to the left of', 'to the right of', 'on top of', 'in front of', 'next to', 'underneath', 'inside', 'behind', 'beside', 'between', 'under', 'above', 'below', 'near', 'in', 'on', 'at', 'by'];

const LEAD_IN = /^(?:(?:please|ok|okay|so|and|also|hey|just|now|careful|warning|heads up|watch out|remember(?: that)?|note(?: that)?|fyi|i'm|i am|i've|i have|i'll|i will|i|we're|we are|we've|we have|we|there's|there is|there are|it's|it is)\s+)+/i;
const PLACE_VERBS = /^(?:(?:just|now|always|usually)\s+)*(?:putting|put|placing|placed|leaving|left|dropping|dropped|storing|stored|keeping|keep|kept|hiding|hid|hanging|hung|moving|moved|setting|set|stashing|stashed|tucking|tucked)\s+/i;
const DETERMINER = /^(my|the|our|your|his|her|their|a|an|some|this|that)\s+/i;
const TRAILING_FILLER = /\s+(?:is|are|was|were|goes|go|lives|live|sits|sit|stays|stay|belongs|belong|now|right|back|away|down|up)$/i;
const SMALL_TALK = /^(?:hello|hi|hey|thanks|thank you|ok|okay|yes|no|yeah|nope|testing|test|good morning|good night|goodbye|bye|never ?mind|cool|great)\b/;

const STOPWORDS = new Set(
  `a an the my your our his her their its me i you we they it is are was were am be been do does did
   can could would should will have has had where what which who whose when how why any some there here
   this that these those of in on at to for from with about and or not no put left leave keep kept find
   show tell guide take look locate know remember think last seen see saw please now today currently
   exactly anywhere somewhere something anything thing stuff place placed located location get got go
   s re ve m t d ll forget delete erase remove`.split(/\s+/).filter(Boolean),
);

function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (/(sses|shes|ches|xes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const tokens = (text) => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);

function queryTokens(text) {
  const words = String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOPWORDS.has(w));
  return [...new Set(words.map(stem).map((w) => QUERY_SYNONYMS[w] ?? w))];
}

function classify(text) {
  const t = text.toLowerCase().replace(/^(?:hey|ok|okay|please|um|uh)[,\s]+/, '').trim();
  if (!t) return 'ignored';
  if (/^(?:forget|delete|erase|remove)\b/.test(t) || /\bforget (?:about|my|the|where|that)\b/.test(t)) return 'forget';
  if (/\?\s*$/.test(t)) return 'question';
  if (/^(?:where|what|which|who|whose|when|how|is|are|was|were|do|does|did|can|could|have|has|any|tell me|show me|find|guide me|take me|look for|locate)\b/.test(t)) return 'question';
  if (t.split(/\s+/).length < 2 || SMALL_TALK.test(t)) return 'ignored';
  return 'note';
}

function findPreposition(text) {
  const lower = text.toLowerCase();
  let best = null;
  for (const prep of PREPOSITIONS) {
    const re = new RegExp(`\\s${prep}\\s`, 'g');
    const match = re.exec(lower);
    if (!match) continue;
    // Earliest wins. On a tie the longer phrase, which is listed first, is kept.
    if (!best || match.index < best.index) best = { index: match.index, prep, end: match.index + match[0].length };
  }
  return best;
}

function topicFor(text) {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9-]+/g, ' ')} `;
  for (const [topic, words] of TOPIC_KEYWORDS) {
    if (words.some((word) => lower.includes(` ${word} `))) return topic;
  }
  return null;
}

function isPlural(phrase) {
  const last = phrase.split(' ').pop() ?? '';
  return /s$/.test(last) && !/(ss|us|is)$/.test(last);
}

// "I'm putting my keys in my left jacket pocket" ->
//   { item: "house keys", location: "left jacket pocket", summary: "Keys are in the left jacket pocket." }
function parseNote(text) {
  const clean = text.replace(/[,;:]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.!\s]+$/, '');
  const split = findPreposition(clean);
  let subject = split ? clean.slice(0, split.index) : clean;
  const rest = split ? clean.slice(split.end).trim() : '';

  // The topic comes from what the note is about, not where it is, so that
  // "my glasses are in the bathroom" does not become a shared house_guide memory.
  const topic = topicFor(subject) ?? 'other';

  if (!split) {
    const copula = /^(.*?)\s+(?:is|are|was|were)\s+.+$/i.exec(subject);
    if (copula) subject = copula[1];
  }

  let spoken = subject.trim().replace(LEAD_IN, '').replace(PLACE_VERBS, '').replace(DETERMINER, '');
  for (let prev = null; prev !== spoken; ) {
    prev = spoken;
    spoken = spoken.replace(TRAILING_FILLER, '');
  }
  spoken = spoken.trim().toLowerCase();
  if (!spoken) return null;

  const item = ITEM_ALIASES[spoken] ?? spoken;
  const sentence = `${capitalize(clean)}.`;
  if (!split || !rest) {
    return { item, topic, location: null, summary: sentence, reply: `Saved. ${sentence}` };
  }

  const det = (DETERMINER.exec(rest)?.[1] ?? '').toLowerCase();
  const place = rest.replace(DETERMINER, '').replace(/\s+(?:right now|for now|now|today|again)$/i, '').trim();
  if (!place) return { item, topic, location: null, summary: sentence, reply: `Saved. ${sentence}` };

  // Stored text says "the", the spoken reply says "your".
  const article = ['my', 'our', 'your', 'the', 'this', 'that'].includes(det) ? 'the' : det;
  const replyArticle = det === 'my' || det === 'our' ? 'your' : article;
  const stored = place.replace(/\b(?:my|our)\b/gi, 'the');
  const spokenBack = place.replace(/\b(?:my|our)\b/gi, 'your');
  const be = isPlural(spoken) ? 'are' : 'is';
  const phrase = (art, where) => `${capitalize(spoken)} ${be} ${split.prep} ${art} ${where}.`.replace(/\s+/g, ' ');
  // "in the left jacket pocket" is stored as "left jacket pocket", but "next to the
  // charger" keeps its preposition, because without it the location means something else.
  const location = ['in', 'on', 'at', 'inside'].includes(split.prep)
    ? stored
    : `${split.prep} ${article} ${stored}`.replace(/\s+/g, ' ');
  return { item, topic, location, summary: phrase(article, stored), reply: `Saved. ${phrase(replyArticle, spokenBack)}` };
}

// ---------------------------------------------------------------------------
// Turn handling
// ---------------------------------------------------------------------------

function saveNote(user, text, image) {
  const note = parseNote(text);
  if (!note) return ignore(user, text);

  const topicRule = state.rules.topics?.[note.topic];
  const group = topicRule?.group ?? state.rules.default_group;
  const keepMs = parseKeepFor(topicRule?.keep_for);
  const createdMs = Date.now();
  const id = nextId('m', ++memorySeq);

  let imageUrl = null;
  if (image?.buf) {
    memoryImages.set(id, image.buf);
    imageUrl = `/images/${id}.jpg`;
  } else if (image?.url) {
    imageUrl = image.url;
  }

  const memory = {
    id,
    space_id: SPACE_ID,
    owner_id: user.id,
    item: note.item,
    summary: note.summary,
    location: note.location,
    topic: note.topic,
    group,
    source: image ? 'both' : 'voice',
    status: 'active',
    superseded_by: null,
    created_at: iso(createdMs),
    updated_at: iso(createdMs),
    expires_at: keepMs ? iso(createdMs + keepMs) : null,
    image_url: imageUrl,
  };

  const itemKey = tokens(note.item).join(' ');
  const earlier = state.memories.filter(
    (m) => m.status === 'active' && m.owner_id === user.id && tokens(m.item).join(' ') === itemKey,
  );

  state.memories.unshift(memory);
  emitMemory('created', memory);
  addAudit(
    user.id,
    'memory_stored',
    'info',
    `Stored ${memory.item} in group ${group} (topic ${memory.topic}).` +
      (memory.expires_at ? ` Kept for ${topicRule.keep_for}, until ${memory.expires_at}.` : ''),
    [id],
  );

  for (const old of earlier) {
    old.status = 'superseded';
    old.superseded_by = id;
    old.updated_at = now();
    emitMemory('updated', old);
    addAudit(
      user.id,
      'memory_superseded',
      'info',
      `Earlier memory of ${old.item} (${old.location ?? old.summary}) was replaced by a newer note (${memory.location ?? memory.summary}).`,
      [old.id, id],
    );
  }

  const replaced = earlier.length ? ' This replaces the earlier note.' : '';
  return { kind: 'saved', reply_text: note.reply + replaced, memory_ids: [id] };
}

// Splits active memories into the best-scoring matches on item or topic
// ("strong") and matches on summary or location only ("weak").
function search(words) {
  const strong = [];
  const weak = [];
  for (const memory of state.memories) {
    if (memory.status !== 'active') continue;
    const itemWords = new Set(tokens(memory.item));
    const topicWord = stem(memory.topic.toLowerCase());
    const otherWords = new Set(tokens(`${memory.summary} ${memory.location ?? ''}`));
    const strongScore = words.filter((w) => itemWords.has(w) || w === topicWord).length;
    const weakScore = words.filter((w) => otherWords.has(w)).length;
    if (strongScore > 0) strong.push({ memory, score: strongScore });
    else if (weakScore > 0) weak.push({ memory, score: weakScore });
  }
  const bestTier = (list) => {
    const top = Math.max(0, ...list.map((entry) => entry.score));
    return list.filter((entry) => entry.score === top).map((entry) => entry.memory);
  };
  return { strong: bestTier(strong), weak: bestTier(weak) };
}

function answerQuestion(user, text) {
  const words = queryTokens(text);
  const { strong, weak } = search(words);
  const visible = (list) => list.filter((m) => canSee(user, m, state.rules));
  const topic = strong[0]?.item ?? weak[0]?.item ?? (words.join(' ') || 'something');

  const hit = visible(strong)[0] ?? (strong.length ? null : visible(weak)[0]);
  if (hit) {
    const reason =
      hit.owner_id === user.id
        ? `${user.name} owns the memory.`
        : `Group ${hit.group} is visible to role ${user.role}.`;
    addAudit(user.id, 'query_answered', 'allowed', `Asked about ${hit.item}. ${reason}`, [hit.id]);
    const credit = hit.owner_id === user.id ? '' : ` Noted by ${userName(hit.owner_id)}.`;
    return { kind: 'answer', reply_text: hit.summary + credit, memory_ids: [hit.id] };
  }

  if (strong.length) {
    const groups = [...new Set(strong.map((m) => m.group))];
    addAudit(
      user.id,
      'query_denied',
      'denied',
      `Asked about ${topic}. Group ${groups.join(', ')} is not visible to role ${user.role}.`,
      strong.map((m) => m.id),
    );
    // The denied caller gets no memory ids. The audit entry keeps them for the admin view.
    return { kind: 'denied', reply_text: "Sorry, I can't share that with you.", memory_ids: [] };
  }

  addAudit(user.id, 'query_answered', 'info', `Asked about ${topic}. No matching memory.`, []);
  return { kind: 'answer', reply_text: "I don't have anything about that yet.", memory_ids: [] };
}

function forget(user, text) {
  const words = queryTokens(text);
  const { strong } = search(words);
  const owned = strong.filter((m) => m.owner_id === user.id);

  if (owned.length) {
    for (const memory of owned) {
      memory.status = 'forgotten';
      memory.updated_at = now();
      emitMemory('updated', memory);
    }
    const items = [...new Set(owned.map((m) => m.item))].join(', ');
    addAudit(user.id, 'memory_forgotten', 'allowed', `${user.name} asked to forget ${items}.`, owned.map((m) => m.id));
    return { kind: 'forgot', reply_text: `Forgotten. I no longer remember the ${items}.`, memory_ids: owned.map((m) => m.id) };
  }

  if (strong.length) {
    addAudit(
      user.id,
      'query_denied',
      'denied',
      `Asked to forget ${strong[0].item}. Only the owner can forget a memory.`,
      strong.map((m) => m.id),
    );
    return { kind: 'denied', reply_text: "Sorry, I can't forget that. It belongs to someone else.", memory_ids: [] };
  }

  return ignore(user, text, 'Asked to forget something, but no active memory matched.', "I don't have anything like that to forget.");
}

function ignore(user, text, detail, reply) {
  const shown = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  addAudit(user.id, 'query_answered', 'info', detail ?? `Ignored "${shown}". No note, question or command recognised.`, []);
  return { kind: 'ignored', reply_text: reply ?? "I didn't catch a note or a question in that.", memory_ids: [] };
}

function readImage(body) {
  const b64 = body.image_b64;
  const url = body.image_url;
  if (b64 && url) throw new HttpError(400, 'Send at most one of image_b64 and image_url');
  if (b64) {
    if (typeof b64 !== 'string') throw new HttpError(400, 'image_b64 must be a base64 string');
    const buf = Buffer.from(b64.replace(/^data:[^,]*,/, '').replace(/\s+/g, ''), 'base64');
    if (!buf.length) throw new HttpError(400, 'image_b64 is not valid base64');
    return { buf };
  }
  if (url) {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new HttpError(400, 'image_url must be an http(s) URL');
    // MOCK ONLY: the URL is passed through as it is. The real backend downloads it before it expires.
    return { url };
  }
  return null;
}

// Loose checks only: the fields have the right types. 415 is kept for audio with no bytes in it.
function readAudio(body) {
  const audio = body.audio;
  if (audio == null) return null;
  if (!isObject(audio)) throw new HttpError(400, 'audio must be an object or null');
  if (typeof audio.format !== 'string' || !audio.format.trim()) {
    throw new HttpError(400, 'audio.format must be a non-empty string');
  }
  const sampleRate = audio.sample_rate ?? null;
  if (sampleRate !== null && !(typeof sampleRate === 'number' && Number.isFinite(sampleRate) && sampleRate > 0)) {
    throw new HttpError(400, 'audio.sample_rate must be a positive number or null');
  }
  const channels = audio.channels ?? 1;
  if (!(typeof channels === 'number' && Number.isInteger(channels) && channels > 0)) {
    throw new HttpError(400, 'audio.channels must be a whole number');
  }
  if (typeof audio.data_b64 !== 'string') throw new HttpError(400, 'audio.data_b64 must be a base64 string');
  const buf = Buffer.from(audio.data_b64.replace(/^data:[^,]*,/, '').replace(/\s+/g, ''), 'base64');
  if (!buf.length) throw new HttpError(415, 'audio.data_b64 is empty, so there is no audio to read');
  return { format: audio.format.trim(), sampleRate, channels, buf };
}

// Format, channel count, sample rate and length of the samples in a WAV file, or null.
function wavInfo(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let fmt = null;
  for (let offset = 12; offset + 8 <= buf.length; ) {
    const id = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 24 <= buf.length) {
      fmt = {
        channels: buf.readUInt16LE(offset + 10),
        sampleRate: buf.readUInt32LE(offset + 12),
        bits: buf.readUInt16LE(offset + 22),
      };
    }
    if (id === 'data') {
      const bytesPerSecond = fmt ? fmt.sampleRate * fmt.channels * (fmt.bits / 8) : 0;
      if (!bytesPerSecond) return null;
      const dataBytes = Math.min(size, buf.length - offset - 8);
      return { ...fmt, dataBytes, seconds: dataBytes / bytesPerSecond };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

function wavHeader(dataBytes, sampleRate, channels) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); // size of the fmt chunk
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

// Length in seconds when the format says enough to work it out, otherwise null.
function audioSeconds(audio) {
  const format = audio.format.toLowerCase();
  if (format === 'wav') return wavInfo(audio.buf)?.seconds ?? null;
  if (format === 'pcm_s16le' && audio.sampleRate) return audio.buf.length / (audio.sampleRate * 2 * audio.channels);
  return null;
}

function describeAudio(audio) {
  const seconds = audioSeconds(audio);
  const rate = audio.sampleRate ? `${audio.sampleRate} Hz` : 'sample rate not given';
  const size = `${(audio.buf.length / 1024).toFixed(1)} KB`;
  return `${audio.format}, ${rate}, ${size}${seconds === null ? '' : `, ${seconds.toFixed(1)} s`}`;
}

function storeFrame(userId, image, ts) {
  const version = (latestFrames.get(userId)?.version ?? 0) + 1;
  latestFrames.set(userId, { ts, version, buf: image.buf ?? null, url: image.url ?? null });
  const path = image.buf ? `/frames/${encodeURIComponent(userId)}.jpg?v=${version}` : image.url;
  emit('frame', (base) => ({ user_id: userId, ts, image_url: absolute(path, base) }));
}

function requireSpace(spaceId) {
  if (spaceId != null && typeof spaceId !== 'string') {
    throw new HttpError(400, 'space_id must be a string');
  }
  return (spaceId ?? '').trim() || SPACE_ID;
}

function requireUser(userId) {
  if (typeof userId !== 'string' || !userId) throw new HttpError(400, 'user_id is required');
  const user = state.users.find((u) => u.id === userId);
  if (!user) throw new HttpError(404, `Unknown user_id "${userId}"`);
  return user;
}

const validTs = (ts) => (typeof ts === 'string' && !Number.isNaN(Date.parse(ts)) ? ts : now());

function handleTurn(body) {
  requireSpace(body.space_id);
  const user = requireUser(body.user_id);
  if (body.text != null && typeof body.text !== 'string') throw new HttpError(400, 'text must be a string or null');
  const audio = readAudio(body);
  if (body.text == null && !audio) throw new HttpError(400, 'Send text, audio or both. This turn has neither.');
  const image = readImage(body);
  // Not required by the contract: a turn's picture also becomes the user's latest frame.
  if (image) storeFrame(user.id, image, validTs(body.ts));
  // MOCK ONLY: kept so a developer can listen to it at GET /audio/<user_id>.
  if (audio) latestAudio.set(user.id, { ...audio, ts: validTs(body.ts) });

  const text = (body.text ?? '').trim();
  let result;
  let inputUsed = 'text';
  if (audio && !text) {
    // The mock cannot transcribe, so an audio-only turn never touches the memories.
    inputUsed = 'audio';
    const seconds = audioSeconds(audio);
    result = ignore(
      user,
      '',
      `Ignored an audio-only turn (${describeAudio(audio)}). The mock cannot transcribe audio.`,
      `Audio received${seconds === null ? '' : `, ${seconds.toFixed(1)} seconds`}. This mock cannot transcribe it.`,
    );
  } else {
    // With text and audio together the mock acts on the text.
    const intent = classify(text);
    result =
      intent === 'note' ? saveNote(user, text, image)
      : intent === 'question' ? answerQuestion(user, text)
      : intent === 'forget' ? forget(user, text)
      : ignore(user, text);
  }

  log(
    `turn ${user.id} ${text ? `"${text.slice(0, 60)}"` : '(no text)'}${image ? ' +image' : ''} ` +
      `${audio ? `+audio ${describeAudio(audio)}` : 'no audio'} -> ${result.kind}`,
  );
  return {
    kind: result.kind,
    reply_text: result.reply_text,
    audio_url: null,
    memory_ids: result.memory_ids,
    heard_text: inputUsed === 'text' ? text || null : null,
    input_used: inputUsed,
  };
}

function handleFrame(body) {
  requireSpace(body.space_id);
  const user = requireUser(body.user_id);
  const image = readImage(body);
  if (!image) throw new HttpError(400, 'image_b64 or image_url is required');
  storeFrame(user.id, image, validTs(body.ts));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateRules(rules) {
  if (!isObject(rules)) throw new HttpError(400, 'Body must be a Rules document');
  if (!isObject(rules.roles)) throw new HttpError(400, 'rules.roles must be an object');
  if (!isObject(rules.topics)) throw new HttpError(400, 'rules.topics must be an object');
  if (typeof rules.default_group !== 'string' || !rules.default_group) {
    throw new HttpError(400, 'rules.default_group must be a non-empty string');
  }
  const roles = {};
  for (const [role, rule] of Object.entries(rules.roles)) {
    if (!isObject(rule) || !Array.isArray(rule.can_see) || rule.can_see.some((g) => typeof g !== 'string')) {
      throw new HttpError(400, `rules.roles.${role}.can_see must be an array of strings`);
    }
    roles[role] = { can_see: [...new Set(rule.can_see)] };
  }
  const topics = {};
  for (const [topic, rule] of Object.entries(rules.topics)) {
    if (!isObject(rule) || typeof rule.group !== 'string' || !rule.group) {
      throw new HttpError(400, `rules.topics.${topic}.group must be a non-empty string`);
    }
    const keepFor = rule.keep_for ?? null;
    if (keepFor !== null && parseKeepFor(keepFor) === null) {
      throw new HttpError(400, `rules.topics.${topic}.keep_for must be null or like "30d" or "2h"`);
    }
    topics[topic] = { group: rule.group, keep_for: keepFor };
  }
  return { roles, topics, default_group: rules.default_group };
}

function describeRulesChange(before, after) {
  const parts = [];
  const name = (groups) => groups.map((g) => (g === '*' ? 'everything' : g)).join(', ');
  for (const role of new Set([...Object.keys(before.roles), ...Object.keys(after.roles)])) {
    if (!after.roles[role]) {
      parts.push(`Role ${role} removed.`);
      continue;
    }
    const was = before.roles[role]?.can_see ?? [];
    const is = after.roles[role].can_see;
    const gained = is.filter((g) => !was.includes(g));
    const lost = was.filter((g) => !is.includes(g));
    if (gained.length) parts.push(`Role ${role} can now see ${name(gained)}.`);
    if (lost.length) parts.push(`Role ${role} can no longer see ${name(lost)}.`);
  }
  for (const topic of new Set([...Object.keys(before.topics), ...Object.keys(after.topics)])) {
    const was = before.topics[topic];
    const is = after.topics[topic];
    if (!is) parts.push(`Topic ${topic} removed.`);
    else if (!was) parts.push(`Topic ${topic} added in group ${is.group}.`);
    else {
      if (was.group !== is.group) parts.push(`Topic ${topic} moved from group ${was.group} to ${is.group}.`);
      if (was.keep_for !== is.keep_for) parts.push(`Topic ${topic} is now kept for ${is.keep_for ?? 'ever'}.`);
    }
  }
  if (before.default_group !== after.default_group) parts.push(`Default group is now ${after.default_group}.`);
  return parts.length ? parts.join(' ') : 'Rules saved with no changes.';
}

function handleRules(body) {
  const next = validateRules(body);
  const detail = describeRulesChange(state.rules, next);
  state.rules = next;
  emit('rules', () => ({ rules: state.rules }));
  // The request does not say who changed the rules, so the actor is the dashboard.
  addAudit('dashboard', 'rule_changed', 'info', detail, []);
  log(`rules changed: ${detail}`);
  return { ok: true, rules: state.rules };
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

setInterval(() => {
  for (const memory of state.memories) {
    if (memory.status !== 'active' || !memory.expires_at) continue;
    if (Date.parse(memory.expires_at) > Date.now()) continue;
    memory.status = 'expired';
    memory.updated_at = now();
    emitMemory('updated', memory);
    addAudit('system', 'memory_expired', 'info', `Memory of ${memory.item} expired (topic ${memory.topic}).`, [memory.id]);
    log(`expired ${memory.id} (${memory.item})`);
  }
}, EXPIRY_SWEEP_MS);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendImage(res, buf) {
  if (!buf) return sendJson(res, 404, { error: 'No image' });
  const type = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg';
  res.writeHead(200, { ...CORS, 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

// MOCK ONLY: lets a developer play back the latest turn audio sent by a user.
function sendAudio(res, entry) {
  if (!entry) return sendJson(res, 404, { error: 'No audio recorded for that user yet' });
  const fmt = entry.format.toLowerCase();
  let out = entry.buf;
  let type = 'application/octet-stream';
  if (fmt === 'wav') {
    type = 'audio/wav';
  } else if (fmt === 'pcm_s16le' && entry.sampleRate) {
    out = Buffer.concat([wavHeader(entry.buf.length, entry.sampleRate, entry.channels || 1), entry.buf]);
    type = 'audio/wav';
  }
  res.writeHead(200, { ...CORS, 'Content-Type': type, 'Content-Length': out.length, 'Cache-Control': 'no-store' });
  res.end(out);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return reject(new HttpError(413, 'Request body too large'));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isObject(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new HttpError(400, 'Request body must be a JSON object'));
      }
    });
  });
}

function openEventStream(req, res) {
  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected to the MOCK SafeSpace event stream\n\n');
  const client = { res, base: baseOf(req) };
  sseClients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
  log(`events: client connected (${sseClients.size} open)`);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(client);
    log(`events: client left (${sseClients.size} open)`);
  });
}

const ROUTES = {
  '/': ['GET'],
  '/api/state': ['GET'],
  '/api/turn': ['POST'],
  '/api/frames': ['POST'],
  '/api/rules': ['PUT'],
  '/api/events': ['GET'],
};

async function route(req, res) {
  const url = new URL(req.url, 'http://mock.local');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const spaceParam = url.searchParams.get('space_id');

  if (path === '/api/state') {
    log(`state requested by ${(req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '')}`);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS, 'Access-Control-Max-Age': '86400' });
    return res.end();
  }

  if (req.method === 'GET') {
    const frame = /^\/frames\/(.+)\.jpg$/.exec(path);
    if (frame) return sendImage(res, latestFrames.get(decodeURIComponent(frame[1]))?.buf);
    const image = /^\/images\/(.+)\.jpg$/.exec(path);
    if (image) return sendImage(res, memoryImages.get(decodeURIComponent(image[1])));
    const audio = /^\/audio\/([^/]+)$/.exec(path);
    if (audio) return sendAudio(res, latestAudio.get(decodeURIComponent(audio[1]).replace(/\.wav$/i, '')));
  }

  const methods = ROUTES[path];
  if (!methods) throw new HttpError(404, `No such endpoint: ${path}`);
  if (!methods.includes(req.method)) throw new HttpError(405, `${path} accepts ${methods.join(', ')}`);

  switch (path) {
    case '/':
      return sendJson(res, 200, {
        mock: true,
        about: 'MOCK SafeSpace backend. In-memory data, keyword logic, no AI. See docs/api-contract.md.',
        endpoints: ['GET /api/state', 'POST /api/turn', 'POST /api/frames', 'PUT /api/rules', 'GET /api/events'],
      });
    case '/api/state': {
      const requestedSpace = requireSpace(spaceParam);
      const base = baseOf(req);
      return sendJson(res, 200, {
        space_id: requestedSpace,
        users: state.users,
        rules: state.rules,
        memories: state.memories.map((m) => toWire(m, base)),
        audit: state.audit.slice(0, AUDIT_SNAPSHOT_LIMIT),
      });
    }
    case '/api/turn':
      return sendJson(res, 200, handleTurn(await readJson(req)));
    case '/api/frames':
      return sendJson(res, 200, handleFrame(await readJson(req)));
    case '/api/rules':
      requireSpace(spaceParam);
      return sendJson(res, 200, handleRules(await readJson(req)));
    case '/api/events':
      requireSpace(spaceParam);
      return openEventStream(req, res);
  }
}

function onRequest(req, res) {
  route(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.end();
    log(`${req.method} ${req.url} -> ${status} ${err.message}`);
    sendJson(res, status, { error: status === 500 ? 'Mock server error' : err.message });
  });
}

function listen(host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(onRequest);
    server.once('error', reject);
    server.listen(PORT, host, () => resolve(server));
  });
}

const servers = [];
try {
  if (HOST) {
    servers.push(await listen(HOST));
  } else {
    servers.push(await listen('127.0.0.1'));
    // Also bind IPv6 loopback so "localhost" works whichever way it resolves.
    try {
      servers.push(await listen('::1'));
    } catch (err) {
      if (err.code === 'EADDRINUSE') throw err;
    }
  }
} catch (err) {
  console.error(
    err.code === 'EADDRINUSE'
      ? `[MOCK] Port ${PORT} is already in use. Stop the other process or run with PORT=<other port>.`
      : `[MOCK] Could not start: ${err.message}`,
  );
  process.exit(1);
}

console.log(
  `[MOCK] SafeSpace MOCK server (not the real backend: in-memory data, keyword logic, no AI) ` +
    `listening on http://localhost:${PORT}${HOST ? ` (host ${HOST})` : ' (loopback only; HOST=0.0.0.0 opens it to the network)'}`,
);
console.log(
  `[MOCK] space "${SPACE_ID}", ${state.users.length} users, ${state.memories.length} seed memories, ${state.audit.length} seed audit entries. Ctrl+C to stop.`,
);

function shutdown() {
  for (const client of sseClients) client.res.end();
  for (const server of servers) server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
