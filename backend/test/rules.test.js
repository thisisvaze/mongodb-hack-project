import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRules, describeRulesChange, rejectedRulesAudit, parseKeepFor } from '../guardrails/index.js';
import { home } from './fixtures.js';

const rulesWith = (change) => {
  const rules = structuredClone(home().rules);
  change(rules);
  return rules;
};
const rejects = (rules, pattern) => assert.throws(() => validateRules(rules, home()), (err) => err.status === 400 && pattern.test(err.message));

test('the seed rules pass unchanged', () => {
  const { rules, warnings } = validateRules(home().rules, home());
  assert.deepEqual(rules, home().rules);
  assert.deepEqual(warnings, []);
});

test('names must be lowercase slugs that start with a letter', () => {
  rejects(rulesWith((r) => { r.roles['Care Team'] = { can_see: [] }; }), /Role "Care Team"/);
  rejects(rulesWith((r) => { r.topics.Medication = r.topics.medication; }), /Topic "Medication"/);
  rejects(rulesWith((r) => { r.topics.medication.group = 'care-team'; }), /Group of topic medication/);
  rejects(rulesWith((r) => { r.roles.visitor.can_see = ['House Guide']; }), /Group in rules.roles.visitor.can_see/);
  rejects(rulesWith((r) => { r.default_group = '_private'; }), /default_group/);
  rejects(JSON.parse('{"roles":{"__proto__":{"can_see":[]},"resident":{"can_see":["*"]}},"topics":{},"default_group":"resident_only"}'), /__proto__/);
  const ok = validateRules(rulesWith((r) => { r.roles.care_team = { can_see: ['care'] }; }), home());
  assert.deepEqual(ok.rules.roles.care_team, { can_see: ['care'] });
});

test('keep_for must be like 30d or 2h, or null', () => {
  for (const value of ['30', '30 d', '30D', '2 hours', '-1d', '0d', 30, '1y', ' 2h']) {
    rejects(rulesWith((r) => { r.topics.hazard.keep_for = value; }), /keep_for/);
  }
  rejects(rulesWith((r) => { r.topics.hazard.keep_for = '400d'; }), /longer than 365 days/);
  for (const value of ['45s', '15m', '2h', '30d', '52w', null]) {
    assert.equal(validateRules(rulesWith((r) => { r.topics.hazard.keep_for = value; }), home()).rules.topics.hazard.keep_for, value);
  }
  assert.equal(validateRules(rulesWith((r) => { delete r.topics.hazard.keep_for; }), home()).rules.topics.hazard.keep_for, null);
  assert.equal(parseKeepFor('2h'), 7_200_000);
});

test('shape errors and unknown fields are rejected', () => {
  rejects(null, /Rules document/);
  rejects([], /Rules document/);
  rejects(rulesWith((r) => { r.extra = 1; }), /Unknown field "extra"/);
  rejects(rulesWith((r) => { r.roles.visitor.can_edit = []; }), /Unknown field "can_edit"/);
  rejects(rulesWith((r) => { r.topics.hazard.colour = 'red'; }), /Unknown field "colour"/);
  rejects(rulesWith((r) => { r.roles.visitor.can_see = 'house_guide'; }), /must be an array/);
  rejects(rulesWith((r) => { r.roles.visitor.can_see = [1]; }), /only strings/);
  rejects(rulesWith((r) => { delete r.default_group; }), /default_group/);
  rejects(rulesWith((r) => { r.roles = {}; }), /at least one role/);
});

test('roles used by members cannot be removed', () => {
  rejects(rulesWith((r) => { delete r.roles.visitor; }), /Role visitor is used by a member/);
});

test('the owner keeps seeing everything', () => {
  rejects(rulesWith((r) => { r.roles.resident.can_see = ['resident_only']; }), /space owner and must keep can_see \["\*"\]/);
});

test('sharing the default group is allowed but warned about', () => {
  const ticked = validateRules(rulesWith((r) => { r.roles.caregiver.can_see.push('resident_only'); }), home());
  assert.deepEqual(ticked.warnings, ['Role caregiver can see default_group resident_only, so new memories with no matching topic are shared with them.']);
  const everything = validateRules(rulesWith((r) => { r.roles.visitor.can_see = ['*']; }), home());
  assert.deepEqual(everything.warnings, ['Role visitor can see everything.']);
  const moved = validateRules(rulesWith((r) => { r.default_group = 'house_guide'; }), home());
  assert.match(moved.warnings[0], /Role caregiver, visitor can see default_group house_guide/);
  assert.match(describeRulesChange(home().rules, ticked.rules, ticked.warnings), /Role caregiver can now see resident_only\. Warning: /);
});

test('duplicates are removed and "*" stands alone', () => {
  const { rules } = validateRules(rulesWith((r) => {
    r.roles.caregiver.can_see = ['care', 'care', 'supplies'];
    r.roles.resident.can_see = ['*', 'care'];
  }), home());
  assert.deepEqual(rules.roles.caregiver.can_see, ['care', 'supplies']);
  assert.deepEqual(rules.roles.resident.can_see, ['*']);
});

test('a group no topic uses is a warning, shown in the audit detail', () => {
  const { rules, warnings } = validateRules(rulesWith((r) => { r.roles.visitor.can_see.push('garden'); }), home());
  assert.deepEqual(warnings, ['Role visitor lists group garden, which no topic uses.']);
  const detail = describeRulesChange(home().rules, rules, warnings);
  assert.equal(detail, 'Role visitor can now see garden. Warning: Role visitor lists group garden, which no topic uses.');
});

test('the audit detail describes the change', () => {
  const next = rulesWith((r) => {
    r.topics.hazard.keep_for = '4h';
    r.topics.pets = { group: 'house_guide', keep_for: null };
    delete r.topics.documents;
  });
  const { rules } = validateRules(next, home());
  assert.equal(
    describeRulesChange(home().rules, rules),
    'Topic documents removed. Topic hazard is now kept for 4h. Topic pets added in group house_guide.',
  );
  assert.equal(describeRulesChange(home().rules, home().rules), 'Rules saved with no changes.');
});

test('a rejected change becomes a denied rule_changed audit entry', () => {
  try {
    validateRules(rulesWith((r) => { r.topics.hazard.keep_for = '2 hours'; }), home());
    assert.fail('should throw');
  } catch (err) {
    const entry = rejectedRulesAudit('home', err);
    assert.equal(entry.action, 'rule_changed');
    assert.equal(entry.verdict, 'denied');
    assert.equal(entry.actor_id, 'dashboard');
    assert.match(entry.detail, /^Rule change rejected: rules.topics.hazard.keep_for/);
  }
});
