import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeAnswer, removeUnsafeClaims, ageText, guidanceCheck, isMedication, resolveCaller,
  LABEL_REMINDER, CANNOT_CONFIRM, CAMERA_LOST,
} from '../guardrails/index.js';
import { home } from './fixtures.js';

const NOW = new Date('2026-11-14T17:00:00Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60_000);
const names = { u_resident: 'Resident', u_caregiver: 'Caregiver', u_visitor: 'Visitor' };
const caller = (id) => resolveCaller(home(), id);
const memory = (over) => ({ _id: 'm_x', space_id: 'home', status: 'active', owner_id: 'u_resident', topic: 'valuables', item: 'house keys', summary: 'Keys are on the hook by the front door.', updated_at: ago(10), ...over });
const hazard = (over) => memory({ _id: 'h_1', topic: 'hazard', item: 'wet floor', summary: 'Wet floor in the hallway.', expires_at: new Date(NOW.getTime() + 3_600_000), updated_at: ago(5), ...over });

// ---- Never say it is safe ----

test('sentences claiming safety are removed', () => {
  const unsafe = [
    "It's safe to walk now.",
    'The path is clear.',
    'The floor is dry.',
    'All clear!',
    'There is nothing in your way.',
    "Don't worry about it.",
    'You can walk freely.',
    "You're completely safe here.",
    'The stairs are clear.',
  ];
  for (const s of unsafe) assert.equal(removeUnsafeClaims(`Keys are on the hook. ${s}`).text, 'Keys are on the hook.', s);
  for (const s of ['The safe is in the closet.', 'The clear box is on the shelf.', 'Keep the door open.', 'The safety pins are in the drawer.']) {
    assert.equal(removeUnsafeClaims(s).text, s, s);
  }
});

test("Gemini's safety claims never reach the user", () => {
  const out = composeAnswer({ caller: caller('u_resident'), hit: memory(), draft: 'Keys are on the hook by the front door. The path there is clear, so it is safe to walk.', names, now: NOW });
  assert.equal(out.reply_text, 'Keys are on the hook by the front door. You noted this 10 minutes ago.');
  assert.match(out.notes.join(' '), /Removed 1 sentence claiming something was safe or clear/);
});

test('an answer made only of a safety claim becomes "I can\'t confirm"', () => {
  const out = composeAnswer({ caller: caller('u_visitor'), hit: memory({ topic: 'house_guide', item: 'hallway', owner_id: 'u_resident' }), draft: 'The hallway is clear.', names, now: NOW });
  assert.ok(out.reply_text.includes(CANNOT_CONFIRM), out.reply_text);
  assert.ok(!/clear\./.test(out.reply_text.replace(CANNOT_CONFIRM, '')));
});

// ---- Hazards first ----

test('active hazards are said first, newest first, at most two', () => {
  const hazards = [hazard({ _id: 'h_1', summary: 'Wet floor in the hallway.', updated_at: ago(5) }), hazard({ _id: 'h_2', summary: 'Box on the stairs', updated_at: ago(1) }), hazard({ _id: 'h_3', summary: 'Rug is loose', updated_at: ago(30) })];
  const out = composeAnswer({ caller: caller('u_resident'), hit: memory(), hazards, names, now: NOW });
  assert.equal(out.reply_text, 'Careful: Box on the stairs, reported 1 minute ago. Careful: Wet floor in the hallway, reported 5 minutes ago. Keys are on the hook by the front door. You noted this 10 minutes ago.');
  assert.match(out.notes[0], /Said 2 hazards first/);
});

test('expired or inactive hazards are not said', () => {
  const hazards = [hazard({ expires_at: ago(1) }), hazard({ _id: 'h_2', status: 'expired' })];
  const out = composeAnswer({ caller: caller('u_resident'), hit: memory(), hazards, names, now: NOW });
  assert.ok(!out.reply_text.startsWith('Careful'));
});

test('a hazard that is itself the answer is not repeated', () => {
  const h = hazard();
  const out = composeAnswer({ caller: caller('u_resident'), hit: h, hazards: [h], names, now: NOW });
  assert.equal(out.reply_text, 'Wet floor in the hallway. You noted this 5 minutes ago.');
});

// ---- Age, who, and "I'm not sure" ----

test('every answer says who noted it and when', () => {
  assert.equal(composeAnswer({ caller: caller('u_caregiver'), hit: memory({ owner_id: 'u_caregiver', topic: 'supplies', item: 'batteries', summary: 'Batteries are in the top drawer.', updated_at: ago(180) }), names, now: NOW }).reply_text,
    'Batteries are in the top drawer. You noted this 3 hours ago.');
  assert.equal(composeAnswer({ caller: caller('u_visitor'), hit: memory({ topic: 'house_guide', item: 'bathroom', summary: 'The bathroom is the second door on the left.', updated_at: ago(60 * 24 * 5) }), names, now: NOW }).reply_text,
    'The bathroom is the second door on the left. Noted by Resident 5 days ago.');
});

test('old notes about things that move say they may have moved', () => {
  const out = composeAnswer({ caller: caller('u_resident'), hit: memory({ updated_at: ago(60 * 30) }), names, now: NOW });
  assert.equal(out.reply_text, 'Keys are on the hook by the front door. You noted this yesterday. It may have moved since.');
});

test('a weak match is hedged', () => {
  const out = composeAnswer({ caller: caller('u_resident'), hit: memory(), score: 0.72, names, now: NOW });
  assert.equal(out.reply_text, "I'm not sure, but the closest note says: Keys are on the hook by the front door. You noted this 10 minutes ago.");
  assert.match(out.notes.join(' '), /0\.72 is below 0\.85/);
});

test('ageText reads naturally', () => {
  assert.deepEqual([ageText(ago(0.2), NOW), ageText(ago(1), NOW), ageText(ago(45), NOW), ageText(ago(61), NOW), ageText(ago(60 * 30), NOW), ageText(ago(60 * 24 * 3), NOW)],
    ['just now', '1 minute ago', '45 minutes ago', '1 hour ago', 'yesterday', '3 days ago']);
});

// ---- Medication ----

const pills = memory({ owner_id: 'u_caregiver', topic: 'medication', item: 'evening pills', summary: 'Evening pills are in the blue box on the kitchen counter.', updated_at: ago(60 * 24 * 2) });

test('medication is read as recorded, with who, when and a label reminder', () => {
  const out = composeAnswer({ caller: caller('u_resident'), hit: pills, draft: 'Your evening pills are in the blue box. You should take two now with water.', names, now: NOW });
  assert.equal(out.reply_text, `A note from Caregiver, 2 days ago, says: Evening pills are in the blue box on the kitchen counter. ${LABEL_REMINDER}`);
  assert.ok(!/take two/.test(out.reply_text));
  assert.match(out.notes.join(' '), /no dose advice/);
});

test('medication is recognised by topic or by words', () => {
  assert.ok(isMedication(pills));
  assert.ok(isMedication(memory({ topic: 'other', item: 'inhaler', summary: 'Inhaler is in the coat.' })));
  assert.ok(!isMedication(memory()));
});

test('dose advice in a non-medication answer falls back to the stored note', () => {
  const out = composeAnswer({ caller: caller('u_resident'), hit: memory({ topic: 'other', item: 'water bottle', summary: 'The water bottle is on the desk.' }), draft: 'The water bottle is on the desk. Take 2 tablets with it.', names, now: NOW });
  assert.equal(out.reply_text, 'The water bottle is on the desk. You noted this 10 minutes ago.');
});

// ---- Camera feed ----

test('guidance stops when the camera feed is stale or missing', () => {
  assert.deepEqual(guidanceCheck({ lastFrameAt: new Date(NOW.getTime() - 1000), now: NOW }), { ok: true });
  const stale = guidanceCheck({ lastFrameAt: new Date(NOW.getTime() - 8000), now: NOW });
  assert.equal(stale.ok, false);
  assert.equal(stale.say, CAMERA_LOST);
  assert.match(stale.note, /8 s old/);
  assert.equal(guidanceCheck({ lastFrameAt: null, now: NOW }).ok, false);
});

test('replies are capped in length', () => {
  const out = composeAnswer({ caller: caller('u_resident'), hit: memory({ summary: 'Keys are on the hook. '.repeat(40) }), names, now: NOW });
  assert.ok(out.reply_text.length <= 400);
});
