// Guardrail section 7: checks for PUT /api/rules.
//
// The body is a full Rules document (docs/api-contract.md). Anything the
// `spaces` validator in db/setup.js would reject is a 400 here, with a message
// that says what to fix, rather than a database error later. A few extra checks
// stop changes that would lock the owner out or share new memories by default.

import { GuardrailError, hasOwn, isObject } from './errors.js';

// Stricter than the database's ^[a-z0-9_]+$: a name must start with a letter.
// That also rules out "__proto__" and similar keys.
export const NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
// Contract clarification 10. No spaces, matching the database pattern.
export const KEEP_FOR_PATTERN = /^([0-9]{1,6})([smhdw])$/;

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
export const MAX_KEEP_FOR_MS = 365 * UNIT_MS.d;
export const MAX_ROLES = 20;
export const MAX_TOPICS = 50;
export const MAX_GROUPS_PER_ROLE = 50;

const TOP_LEVEL_KEYS = new Set(['roles', 'topics', 'default_group']);

const bad = (message) => new GuardrailError(400, message);

// "30d" -> milliseconds, or null when the value is not a valid keep-time.
export function parseKeepFor(value) {
  if (typeof value !== 'string') return null;
  const match = KEEP_FOR_PATTERN.exec(value);
  if (!match) return null;
  const ms = Number(match[1]) * UNIT_MS[match[2]];
  return ms > 0 ? ms : null;
}

function checkName(name, what) {
  if (!NAME_PATTERN.test(name)) {
    throw bad(`${what} "${name}" must be lowercase letters, numbers and "_", start with a letter, and be at most 40 characters (for example care_team)`);
  }
}

// Checks a Rules document for one space.
//   body:  the request body
//   space: the current `spaces` document ({ _id, owner_id, members, rules })
// Returns { rules, warnings }. `rules` is a clean copy safe to store as is.
// Throws GuardrailError(400) when the document must be rejected.
export function validateRules(body, space) {
  if (!isObject(body)) throw bad('Body must be a Rules document');
  for (const key of Object.keys(body)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw bad(`Unknown field "${key}". A Rules document has roles, topics and default_group`);
  }
  if (!isObject(body.roles)) throw bad('rules.roles must be an object');
  if (!isObject(body.topics)) throw bad('rules.topics must be an object');
  if (typeof body.default_group !== 'string' || !body.default_group) throw bad('rules.default_group must be a non-empty string');
  checkName(body.default_group, 'default_group');

  const roleNames = Object.keys(body.roles);
  const topicNames = Object.keys(body.topics);
  if (roleNames.length === 0) throw bad('rules.roles must list at least one role');
  if (roleNames.length > MAX_ROLES) throw bad(`At most ${MAX_ROLES} roles`);
  if (topicNames.length > MAX_TOPICS) throw bad(`At most ${MAX_TOPICS} topics`);

  const roles = {};
  for (const role of roleNames) {
    checkName(role, 'Role');
    const rule = body.roles[role];
    if (!isObject(rule) || !Array.isArray(rule.can_see)) throw bad(`rules.roles.${role}.can_see must be an array`);
    for (const key of Object.keys(rule)) {
      if (key !== 'can_see') throw bad(`Unknown field "${key}" in rules.roles.${role}`);
    }
    if (rule.can_see.length > MAX_GROUPS_PER_ROLE) throw bad(`rules.roles.${role}.can_see lists more than ${MAX_GROUPS_PER_ROLE} groups`);
    for (const group of rule.can_see) {
      if (typeof group !== 'string') throw bad(`rules.roles.${role}.can_see must contain only strings`);
      if (group !== '*') checkName(group, `Group in rules.roles.${role}.can_see`);
    }
    const unique = [...new Set(rule.can_see)];
    // "*" already covers every group, so keep it alone.
    roles[role] = { can_see: unique.includes('*') ? ['*'] : unique };
  }

  const topics = {};
  for (const topic of topicNames) {
    checkName(topic, 'Topic');
    const rule = body.topics[topic];
    if (!isObject(rule)) throw bad(`rules.topics.${topic} must be an object with group and keep_for`);
    for (const key of Object.keys(rule)) {
      if (key !== 'group' && key !== 'keep_for') throw bad(`Unknown field "${key}" in rules.topics.${topic}`);
    }
    if (typeof rule.group !== 'string' || !rule.group) throw bad(`rules.topics.${topic}.group must be a non-empty string`);
    checkName(rule.group, `Group of topic ${topic}`);
    const keepFor = rule.keep_for ?? null;
    if (keepFor !== null) {
      const ms = parseKeepFor(keepFor);
      if (ms === null) throw bad(`rules.topics.${topic}.keep_for must be null or a number followed by s, m, h, d or w, such as "30d" or "2h"`);
      if (ms > MAX_KEEP_FOR_MS) throw bad(`rules.topics.${topic}.keep_for is longer than 365 days. Use null to keep it with no end date`);
    }
    topics[topic] = { group: rule.group, keep_for: keepFor };
  }

  // Every member of the space needs a role in the rules, or they silently lose access.
  const members = Array.isArray(space?.members) ? space.members : [];
  const missing = [...new Set(members.map((m) => m.role).filter((r) => !hasOwn(roles, r)))];
  if (missing.length) throw bad(`Role ${missing.join(', ')} is used by a member of this space, so it must stay in rules.roles`);

  // The space owner must keep seeing everything, or a rule change can hide the
  // owner's household from the person the system is for.
  const owner = members.find((m) => m.id === space?.owner_id);
  if (owner && !roles[owner.role].can_see.includes('*')) {
    throw bad(`Role ${owner.role} belongs to the space owner and must keep can_see ["*"]`);
  }

  const warnings = [];
  const ownerRole = owner?.role ?? null;
  // New memories with no matching topic go to default_group. If another role can
  // see it, they are shared by default. That is allowed (the dashboard lets you
  // tick it, and the mock accepts it), but the audit entry says so plainly.
  const wide = roleNames.filter((r) => r !== ownerRole && roles[r].can_see.includes('*'));
  if (wide.length) warnings.push(`Role ${wide.join(', ')} can see everything.`);
  const sharedDefault = roleNames.filter(
    (r) => r !== ownerRole && !wide.includes(r) && roles[r].can_see.includes(body.default_group),
  );
  if (sharedDefault.length) {
    warnings.push(`Role ${sharedDefault.join(', ')} can see default_group ${body.default_group}, so new memories with no matching topic are shared with them.`);
  }
  const known = new Set([body.default_group, ...Object.values(topics).map((t) => t.group)]);
  for (const role of roleNames) {
    const unused = roles[role].can_see.filter((g) => g !== '*' && !known.has(g));
    if (unused.length) warnings.push(`Role ${role} lists group ${unused.join(', ')}, which no topic uses.`);
  }

  return { rules: { roles, topics, default_group: body.default_group }, warnings };
}

// Plain-language summary for the rule_changed audit entry's `detail`.
export function describeRulesChange(before, after, warnings = []) {
  const parts = [];
  const name = (groups) => groups.map((g) => (g === '*' ? 'everything' : g)).join(', ');
  const beforeRoles = before?.roles ?? {};
  const beforeTopics = before?.topics ?? {};
  for (const role of new Set([...Object.keys(beforeRoles), ...Object.keys(after.roles)])) {
    if (!hasOwn(after.roles, role)) {
      parts.push(`Role ${role} removed.`);
      continue;
    }
    const was = hasOwn(beforeRoles, role) ? beforeRoles[role].can_see ?? [] : [];
    const is = after.roles[role].can_see;
    const gained = is.filter((g) => !was.includes(g));
    const lost = was.filter((g) => !is.includes(g));
    if (!hasOwn(beforeRoles, role)) parts.push(`Role ${role} added.`);
    if (gained.length) parts.push(`Role ${role} can now see ${name(gained)}.`);
    if (lost.length) parts.push(`Role ${role} can no longer see ${name(lost)}.`);
  }
  for (const topic of new Set([...Object.keys(beforeTopics), ...Object.keys(after.topics)])) {
    const was = hasOwn(beforeTopics, topic) ? beforeTopics[topic] : null;
    const is = hasOwn(after.topics, topic) ? after.topics[topic] : null;
    if (!is) parts.push(`Topic ${topic} removed.`);
    else if (!was) parts.push(`Topic ${topic} added in group ${is.group}.`);
    else {
      if (was.group !== is.group) parts.push(`Topic ${topic} moved from group ${was.group} to ${is.group}.`);
      if ((was.keep_for ?? null) !== is.keep_for) parts.push(`Topic ${topic} is now kept for ${is.keep_for ?? 'ever'}.`);
    }
  }
  if (before?.default_group !== after.default_group) parts.push(`Default group is now ${after.default_group}.`);
  const text = parts.length ? parts.join(' ') : 'Rules saved with no changes.';
  return warnings.length ? `${text} Warning: ${warnings.join(' ')}` : text;
}

// The audit entry for a rejected rule change. The contract has no "rule_rejected"
// action, so it is rule_changed with verdict "denied".
export function rejectedRulesAudit(spaceId, error) {
  return {
    space_id: spaceId,
    actor_id: 'dashboard',
    action: 'rule_changed',
    verdict: 'denied',
    detail: `Rule change rejected: ${error.message}.`,
    memory_ids: [],
  };
}
