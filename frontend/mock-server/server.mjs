#!/usr/bin/env node
// MOCK of docs/api-contract.md for frontend development.
// Multi-space indoor memory (Hotel Room 412, Shared Home, Office Floor 3).
// Node built-ins only: `node frontend/mock-server/server.mjs`

import http from 'node:http';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '';
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/+$/, '');

const DEFAULT_SPACE_ID = 'hotel';
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
// Indoor spaces: users and rules only; memories and the log start empty
// ---------------------------------------------------------------------------

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const now = () => iso(Date.now());

const spaces = {
  hotel: {
    space_id: 'hotel',
    users: [
      { id: 'u_guest', name: 'Blind Guest', role: 'guest' },
      { id: 'u_staff', name: 'Housekeeping', role: 'staff' },
      { id: 'u_next_guest', name: 'Next Guest', role: 'next_guest' },
    ],
    rules: {
      roles: {
        guest: { can_see: ['*'] },
        staff: { can_see: ['room_guide', 'supplies'] },
        next_guest: { can_see: ['room_guide'] },
      },
      topics: {
        valuables: { group: 'guest_only', keep_for: '18h' },
        documents: { group: 'guest_only', keep_for: '18h' },
        medication: { group: 'guest_only', keep_for: '18h' },
        supplies: { group: 'supplies', keep_for: '24h' },
        hazard: { group: 'room_guide', keep_for: '4h' },
        house_guide: { group: 'room_guide', keep_for: null },
      },
      default_group: 'guest_only',
    },
    memories: [],
    audit: [],
    latest_turn: null,
  },

  home: {
    space_id: 'home',
    users: [
      { id: 'u_resident', name: 'Blind Resident', role: 'resident' },
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
    memories: [],
    audit: [],
    latest_turn: null,
  },

  office: {
    space_id: 'office',
    users: [
      { id: 'u_member', name: 'Blind Employee', role: 'member' },
      { id: 'u_coworker', name: 'Coworker', role: 'coworker' },
      { id: 'u_office_visitor', name: 'Visitor', role: 'visitor' },
    ],
    rules: {
      roles: {
        member: { can_see: ['*'] },
        coworker: { can_see: ['team', 'wayfinding'] },
        visitor: { can_see: ['wayfinding'] },
      },
      topics: {
        valuables: { group: 'member_only', keep_for: null },
        documents: { group: 'member_only', keep_for: null },
        supplies: { group: 'team', keep_for: null },
        hazard: { group: 'wayfinding', keep_for: '4h' },
        house_guide: { group: 'wayfinding', keep_for: null },
      },
      default_group: 'member_only',
    },
    memories: [],
    audit: [],
    latest_turn: null,
  },
};

let memorySeq = 0;
let auditSeq = 0;
const nextId = (prefix, n) => `${prefix}_${String(n).padStart(2, '0')}`;

const latestFrames = new Map(); // `${space_id}:${user_id}` -> { spaceId, userId, ts, buf, url, version }
const latestAudio = new Map(); // user_id -> { ts, format, sampleRate, channels, buf }
const memoryImages = new Map(); // memory_id -> Buffer
const sseClients = new Set(); // { res, base, spaceId }

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

function getSpace(spaceId) {
  const id = (spaceId ?? '').trim() || DEFAULT_SPACE_ID;
  const space = spaces[id];
  if (!space) {
    throw new HttpError(404, `Unknown space_id "${id}". Available spaces: ${Object.keys(spaces).join(', ')}.`);
  }
  return space;
}

function emit(spaceId, event, build) {
  for (const client of sseClients) {
    if (client.spaceId !== spaceId) continue;
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(build(client.base))}\n\n`);
  }
}

function addAudit(space, actorId, action, verdict, detail, memoryIds = []) {
  const entry = {
    id: nextId('a', ++auditSeq),
    ts: now(),
    space_id: space.space_id,
    actor_id: actorId,
    action,
    verdict,
    detail,
    memory_ids: memoryIds,
  };
  space.audit.unshift(entry);
  if (space.audit.length > 1000) space.audit.length = 1000;
  emit(space.space_id, 'audit', () => ({ entry }));
  return entry;
}

function emitMemory(space, op, memory) {
  emit(space.space_id, 'memory', (base) => ({ op, memory: toWire(memory, base) }));
}

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

const userName = (space, id) => space.users.find((u) => u.id === id)?.name ?? id;
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// Keyword logic (stands in for the real backend's language model)
// ---------------------------------------------------------------------------

const TOPIC_KEYWORDS = [
  ['hazard', ['hazard', 'wet floor', 'spill', 'spilled', 'broken glass', 'slippery', 'careful', 'watch out', 'warning', 'loose rug', 'trip hazard', 'obstacle', 'blocking', 'blocked', 'cable ramp', 'cable']],
  ['medication', ['medication', 'medications', 'medicine', 'meds', 'pill', 'pills', 'tablets', 'insulin', 'inhaler', 'prescription', 'eye drops']],
  ['documents', ['passport', 'boarding pass', 'document', 'documents', 'papers', 'paperwork', 'insurance', 'health card', 'birth certificate', 'bank statement', 'lease']],
  ['valuables', ['key', 'keys', 'wallet', 'purse', 'phone', 'cash', 'money', 'credit card', 'bank card', 'jewelry', 'jewellery', 'ring', 'necklace', 'laptop', 'cane', 'badge', 'lanyard']],
  ['supplies', ['supplies', 'battery', 'batteries', 'bandage', 'bandages', 'first aid', 'gloves', 'toilet paper', 'tissues', 'soap', 'towel', 'towels', 'light bulbs', 'bulbs', 'detergent', 'groceries', 'mug', 'mugs']],
  ['house_guide', ['bathroom', 'washroom', 'restroom', 'toilet', 'shower', 'shampoo', 'conditioner', 'kitchen', 'bedroom', 'light switch', 'outlet', 'thermostat', 'wifi', 'wi-fi', 'fuse box', 'breaker', 'front door', 'back door', 'stairs', 'staircase', 'elevator', 'garbage', 'recycling', 'laundry', 'washer', 'dryer', 'doorbell', 'mailbox', 'water station', 'kettle', 'microwave', 'fridge']],
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
   guest previous person someone user
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
  if (/^(?:check ?out|end stay|wipe my stay|wipe room)\b/.test(t)) return 'checkout';
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

function parseNote(text) {
  const clean = text.replace(/[,;:]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.!\s]+$/, '');
  const split = findPreposition(clean);
  let subject = split ? clean.slice(0, split.index) : clean;
  const rest = split ? clean.slice(split.end).trim() : '';

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

  const article = ['my', 'our', 'your', 'the', 'this', 'that'].includes(det) ? 'the' : det;
  const replyArticle = det === 'my' || det === 'our' ? 'your' : article;
  const stored = place.replace(/\b(?:my|our)\b/gi, 'the');
  const spokenBack = place.replace(/\b(?:my|our)\b/gi, 'your');
  const be = isPlural(spoken) ? 'are' : 'is';
  const phrase = (art, where) => `${capitalize(spoken)} ${be} ${split.prep} ${art} ${where}.`.replace(/\s+/g, ' ');
  const location = ['in', 'on', 'at', 'inside'].includes(split.prep)
    ? stored
    : `${split.prep} ${article} ${stored}`.replace(/\s+/g, ' ');
  return { item, topic, location, summary: phrase(article, stored), reply: `Saved. ${phrase(replyArticle, spokenBack)}` };
}

// ---------------------------------------------------------------------------
// Turn handling
// ---------------------------------------------------------------------------

function saveNote(space, user, text, image) {
  const note = parseNote(text);
  if (!note) return ignore(space, user, text);

  const topicRule = space.rules.topics?.[note.topic];
  const group = topicRule?.group ?? space.rules.default_group;
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
    space_id: space.space_id,
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
  const earlier = space.memories.filter(
    (m) => m.status === 'active' && m.owner_id === user.id && tokens(m.item).join(' ') === itemKey,
  );

  space.memories.unshift(memory);
  emitMemory(space, 'created', memory);
  addAudit(
    space,
    user.id,
    'memory_stored',
    'info',
    `Saved ${memory.item} in ${group}.` + (memory.expires_at ? ` Wipes after ${topicRule.keep_for}.` : ''),
    [id],
  );

  for (const old of earlier) {
    old.status = 'superseded';
    old.superseded_by = id;
    old.updated_at = now();
    emitMemory(space, 'updated', old);
    addAudit(
      space,
      user.id,
      'memory_superseded',
      'info',
      `Updated ${old.item} from "${old.location ?? old.summary}" to "${memory.location ?? memory.summary}".`,
      [old.id, id],
    );
  }

  const replaced = earlier.length ? ' Updated your earlier spot.' : '';
  return { kind: 'saved', reply_text: note.reply + replaced, memory_ids: [id] };
}

function search(space, words) {
  const strong = [];
  const weak = [];
  for (const memory of space.memories) {
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

function answerQuestion(space, user, text) {
  const words = queryTokens(text);
  const { strong, weak } = search(space, words);
  const visible = (list) => list.filter((m) => canSee(user, m, space.rules));
  const topic = strong[0]?.item ?? weak[0]?.item ?? (words.join(' ') || 'that item');

  const hit = visible(strong)[0] ?? (strong.length ? null : visible(weak)[0]);
  if (hit) {
    const reason = hit.owner_id === user.id ? `${user.name} owns it.` : `Shared via ${hit.group}.`;
    addAudit(space, user.id, 'query_answered', 'allowed', `Asked about ${hit.item}. ${reason}`, [hit.id]);
    const credit = hit.owner_id === user.id ? '' : ` Noted by ${userName(space, hit.owner_id)}.`;
    return { kind: 'answer', reply_text: hit.summary + credit, memory_ids: [hit.id] };
  }

  if (strong.length) {
    const groups = [...new Set(strong.map((m) => m.group))];
    addAudit(
      space,
      user.id,
      'query_denied',
      'denied',
      `Asked about ${topic}. Group ${groups.join(', ')} is blocked for role ${user.role}.`,
      strong.map((m) => m.id),
    );
    return { kind: 'denied', reply_text: "Sorry, that memory is private and can't be shared with your role.", memory_ids: [] };
  }

  addAudit(space, user.id, 'query_answered', 'info', `Asked about ${topic}. No active memory in this space.`, []);
  return { kind: 'answer', reply_text: "Nothing is saved about that in this space.", memory_ids: [] };
}

function checkoutStay(space, user) {
  const owned = space.memories.filter((m) => m.status === 'active' && m.owner_id === user.id);
  if (!owned.length) {
    return ignore(space, user, 'check out', 'Checked out, no active personal memories left to wipe.', 'Checked out. You had no active personal memories in this space.');
  }
  const ids = owned.map((m) => m.id);
  const items = [...new Set(owned.map((m) => m.item))].join(', ');
  for (const memory of owned) {
    memory.status = 'expired';
    memory.updated_at = now();
    emitMemory(space, 'updated', memory);
  }
  addAudit(
    space,
    user.id,
    'memory_expired',
    'allowed',
    `Checked out: wiped ${owned.length} personal ${owned.length === 1 ? 'memory' : 'memories'} (${items}). Shared room orientation kept.`,
    ids,
  );
  return {
    kind: 'forgot',
    reply_text: `Checked out. Wiped your private notes (${items}); shared room orientation stays for the next guest.`,
    memory_ids: ids,
  };
}

function forget(space, user, text) {
  const words = queryTokens(text);
  const { strong } = search(space, words);
  const owned = strong.filter((m) => m.owner_id === user.id);

  if (owned.length) {
    for (const memory of owned) {
      memory.status = 'forgotten';
      memory.updated_at = now();
      emitMemory(space, 'updated', memory);
    }
    const items = [...new Set(owned.map((m) => m.item))].join(', ');
    addAudit(space, user.id, 'memory_forgotten', 'allowed', `Wiped ${items}.`, owned.map((m) => m.id));
    return { kind: 'forgot', reply_text: `Wiped. I no longer remember your ${items}.`, memory_ids: owned.map((m) => m.id) };
  }

  if (strong.length) {
    addAudit(
      space,
      user.id,
      'query_denied',
      'denied',
      `Tried to wipe ${strong[0].item}. Only the owner can wipe a memory.`,
      strong.map((m) => m.id),
    );
    return { kind: 'denied', reply_text: "Sorry, only the owner can wipe that memory.", memory_ids: [] };
  }

  return ignore(space, user, text, 'Tried to wipe an item, but no active memory matched.', "Nothing active matched that to wipe.");
}

function ignore(space, user, text, detail, reply) {
  const shown = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  addAudit(space, user.id, 'query_answered', 'info', detail ?? `Ignored "${shown}".`, []);
  return { kind: 'ignored', reply_text: reply ?? "I didn't catch a note or question in that.", memory_ids: [] };
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
    return { url };
  }
  return null;
}

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
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

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

function storeFrame(space, userId, image, ts) {
  const key = `${space.space_id}:${userId}`;
  const version = (latestFrames.get(key)?.version ?? 0) + 1;
  const path = image.buf ? `/frames/${encodeURIComponent(key)}.jpg?v=${version}` : image.url;
  latestFrames.set(key, { spaceId: space.space_id, userId, ts, version, buf: image.buf ?? null, path });
  emit(space.space_id, 'frame', (base) => ({ user_id: userId, ts, image_url: absolute(path, base) }));
  return path;
}

function requireUser(space, userId) {
  if (typeof userId !== 'string' || !userId) throw new HttpError(400, 'user_id is required');
  const user = space.users.find((u) => u.id === userId);
  if (!user) throw new HttpError(404, `Unknown user_id "${userId}" in space "${space.space_id}"`);
  return user;
}

const validTs = (ts) => (typeof ts === 'string' && !Number.isNaN(Date.parse(ts)) ? ts : now());

function handleTurn(body) {
  const space = getSpace(body.space_id);
  const user = requireUser(space, body.user_id);
  if (body.text != null && typeof body.text !== 'string') throw new HttpError(400, 'text must be a string or null');
  const audio = readAudio(body);
  if (body.text == null && !audio) throw new HttpError(400, 'Send text, audio or both. This turn has neither.');
  const image = readImage(body);
  const ts = validTs(body.ts);
  const framePath = image ? storeFrame(space, user.id, image, ts) : null;
  if (audio) latestAudio.set(user.id, { ...audio, ts });

  const text = (body.text ?? '').trim();
  let result;
  let inputUsed = 'text';
  if (audio && !text) {
    inputUsed = 'audio';
    const seconds = audioSeconds(audio);
    result = ignore(
      space,
      user,
      '',
      `Ignored an audio-only turn (${describeAudio(audio)}). The mock cannot transcribe audio.`,
      `Audio received${seconds === null ? '' : `, ${seconds.toFixed(1)} seconds`}. This mock cannot transcribe it.`,
    );
  } else {
    const intent = classify(text);
    result =
      intent === 'note' ? saveNote(space, user, text, image)
      : intent === 'question' ? answerQuestion(space, user, text)
      : intent === 'checkout' ? checkoutStay(space, user)
      : intent === 'forget' ? forget(space, user, text)
      : ignore(space, user, text);
  }

  const heardText = inputUsed === 'text' ? text || null : null;
  const turnRecord = {
    user_id: user.id,
    ts,
    transcript: heardText,
    kind: result.kind,
    reply_text: result.reply_text,
    image_url: framePath,
  };
  space.latest_turn = turnRecord;
  emit(space.space_id, 'turn', (base) => ({ ...turnRecord, image_url: absolute(turnRecord.image_url, base) }));

  log(
    `turn [${space.space_id}] ${user.id} ${text ? `"${text.slice(0, 60)}"` : '(no text)'}${image ? ' +image' : ''} ` +
      `${audio ? `+audio ${describeAudio(audio)}` : 'no audio'} -> ${result.kind}`,
  );
  return {
    kind: result.kind,
    reply_text: result.reply_text,
    audio_url: null,
    memory_ids: result.memory_ids,
    heard_text: heardText,
    input_used: inputUsed,
  };
}

function handleFrame(body) {
  const space = getSpace(body.space_id);
  const user = requireUser(space, body.user_id);
  const image = readImage(body);
  if (!image) throw new HttpError(400, 'image_b64 or image_url is required');
  storeFrame(space, user.id, image, validTs(body.ts));
  return { ok: true, say: null };
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

function handleRules(space, body) {
  const next = validateRules(body);
  const detail = describeRulesChange(space.rules, next);
  space.rules = next;
  emit(space.space_id, 'rules', () => ({ rules: space.rules }));
  addAudit(space, 'dashboard', 'rule_changed', 'info', detail, []);
  log(`rules [${space.space_id}] changed: ${detail}`);
  return { ok: true, rules: space.rules };
}

// ---------------------------------------------------------------------------
// Expiry sweep across all spaces
// ---------------------------------------------------------------------------

setInterval(() => {
  for (const space of Object.values(spaces)) {
    for (const memory of space.memories) {
      if (memory.status !== 'active' || !memory.expires_at) continue;
      if (Date.parse(memory.expires_at) > Date.now()) continue;
      memory.status = 'expired';
      memory.updated_at = now();
      emitMemory(space, 'updated', memory);
      addAudit(space, 'system', 'memory_expired', 'info', `Memory of ${memory.item} expired.`, [memory.id]);
      log(`expired [${space.space_id}] ${memory.id} (${memory.item})`);
    }
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

function openEventStream(req, res, spaceId) {
  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`: connected to MOCK event stream for ${spaceId}\n\n`);
  const client = { res, base: baseOf(req), spaceId };
  sseClients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
  log(`events [${spaceId}]: client connected (${sseClients.size} open)`);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(client);
    log(`events [${spaceId}]: client left (${sseClients.size} open)`);
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
    log(`state [${spaceParam ?? DEFAULT_SPACE_ID}] requested by ${(req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '')}`);
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
        about: 'MOCK SafeSpace backend (hotel, home, office). In-memory data, keyword logic, no AI. See docs/api-contract.md.',
        spaces: Object.keys(spaces),
        endpoints: ['GET /api/state', 'POST /api/turn', 'POST /api/frames', 'PUT /api/rules', 'GET /api/events'],
      });
    case '/api/state': {
      const space = getSpace(spaceParam);
      const base = baseOf(req);
      const frames = [...latestFrames.values()]
        .filter((f) => f.spaceId === space.space_id)
        .map((f) => ({ user_id: f.userId, ts: f.ts, image_url: absolute(f.path, base) }));
      return sendJson(res, 200, {
        space_id: space.space_id,
        users: space.users,
        rules: space.rules,
        memories: space.memories.map((m) => toWire(m, base)),
        audit: space.audit.slice(0, AUDIT_SNAPSHOT_LIMIT),
        frames,
        latest_turn: space.latest_turn
          ? { ...space.latest_turn, image_url: absolute(space.latest_turn.image_url, base) }
          : null,
      });
    }
    case '/api/turn':
      return sendJson(res, 200, handleTurn(await readJson(req)));
    case '/api/frames':
      return sendJson(res, 200, handleFrame(await readJson(req)));
    case '/api/rules': {
      const space = getSpace(spaceParam);
      return sendJson(res, 200, handleRules(space, await readJson(req)));
    }
    case '/api/events': {
      const space = getSpace(spaceParam);
      return openEventStream(req, res, space.space_id);
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : 'Unexpected mock server error';
    if (status === 500) console.error(err);
    sendJson(res, status, { error: message });
  }
});

const onListen = () => {
  const shown = HOST || 'localhost';
  log(`MOCK SafeSpace backend listening on http://${shown}:${PORT} (spaces: ${Object.keys(spaces).join(', ')})`);
};

if (HOST) server.listen(PORT, HOST, onListen);
else server.listen(PORT, onListen);
