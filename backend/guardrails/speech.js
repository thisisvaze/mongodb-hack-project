// Guardrail 6: what gets spoken. For a blind user the spoken reply is the whole
// interface, so these rules are applied in code to every answer, whatever
// Gemini wrote:
//   - hazards in the space are said first
//   - never claim something is safe or clear; the system cannot know that
//   - say how old a memory is and who noted it
//   - say "I'm not sure" when the match is weak
//   - medication: read back only what was recorded, never dose advice
//   - stop guidance when the camera feed drops

export const SURE_SCORE = 0.85; // below this (but above the search's minScore) the answer is hedged
export const STALE_MS = 24 * 3_600_000; // a thing noted longer ago than this may have moved
export const MAX_REPLY_CHARS = 400;
export const MAX_HAZARDS_SPOKEN = 2;
export const CAMERA_LOST_MS = 3_000;

export const LABEL_REMINDER = 'Please check the label before taking anything.';
export const CANNOT_CONFIRM = "I can't confirm that. Please check with your cane or ask someone nearby.";
export const CAMERA_LOST = "I've lost the camera, so I'm stopping guidance. Please pause and check around you.";

// Topics that are part of the building and do not move on their own.
const FIXED_TOPICS = new Set(['house_guide']);

// ---------------------------------------------------------------------------
// Never say it is safe
// ---------------------------------------------------------------------------

const UNSAFE_CLAIMS = [
  /\b(?:it'?s|it is|that'?s|that is|you'?re|you are|everything(?:'s| is)|all is|you'?ll be|you will be)\s+(?:completely |totally |perfectly |now |all |quite )?(?:safe|clear|fine to (?:walk|go|cross|move))\b/i,
  /\bsafe to (?:walk|go|cross|move|proceed|step|continue|use|touch|climb)\b/i,
  /\b(?:the |your )?(?:path|way|route|floor|hall|hallway|corridor|stairs?|steps|road|street|crossing)\s+(?:is|are|looks|seems|should be)\s+(?:now |completely |totally )?(?:clear|safe|free|open|dry|fine)\b/i,
  /\b(?:all clear|no (?:obstacles|hazards|danger|risk)|nothing (?:is )?in (?:the|your) way|you can walk freely|nothing to worry about|no need to worry)\b/i,
  /\b(?:don'?t|do not|no need to) (?:worry|use your cane|be careful|check)\b/i,
];

const sentences = (text) => String(text ?? '').match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];

// Drops every sentence that claims safety. Returns { text, removed }.
export function removeUnsafeClaims(text) {
  const kept = [];
  const removed = [];
  for (const s of sentences(text)) (UNSAFE_CLAIMS.some((re) => re.test(s)) ? removed : kept).push(s);
  return { text: kept.join(' '), removed };
}

// ---------------------------------------------------------------------------
// Age and attribution
// ---------------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function ageText(when, now = new Date()) {
  const ms = Math.max(0, now.getTime() - new Date(when).getTime());
  if (!Number.isFinite(ms)) return 'at an unknown time';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${plural(Math.floor(ms / 60_000), 'minute')} ago`;
  if (ms < 86_400_000) return `${plural(Math.floor(ms / 3_600_000), 'hour')} ago`;
  if (ms < 2 * 86_400_000) return 'yesterday';
  return `${plural(Math.floor(ms / 86_400_000), 'day')} ago`;
}

const notedAt = (m) => m.updated_at ?? m.created_at;

// ---------------------------------------------------------------------------
// Medication
// ---------------------------------------------------------------------------

const MEDICINE = /\b(?:medication|medications|medicine|meds|pills?|tablets?|capsules?|insulin|inhaler|prescription|dose|doses|dosage|mg|ml|eye drops)\b/i;
// Advice about taking something, as opposed to where it is.
const DOSE_ADVICE = /\b(?:you should|you can|you may|it'?s (?:ok|okay|fine|safe) to|go ahead and|remember to|time to)\s+take\b|\btake\s+(?:\d+|one|two|three|four|a|an|half|another)\b|\b\d+(?:\.\d+)?\s?(?:mg|ml|mcg|units?)\b|\b(?:double|skip|extra)\s+(?:dose|pill|tablet)\b/i;

export const isMedication = (m) => m?.topic === 'medication' || MEDICINE.test(`${m?.item ?? ''} ${m?.summary ?? ''}`);

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

// Builds the spoken reply for an answered question.
//   caller:  from resolveCaller
//   hit:     the memory the answer is based on (decideAnswer's `hit`)
//   draft:   Gemini's wording, or null to use the stored summary
//   score:   the vector-search score of `hit`
//   hazards: active hazard memories in the space that the caller may see
//   names:   { user_id: display name } for "Noted by ..."
// Returns { reply_text, notes } where notes explain each rule applied, for the
// audit entry's detail.
export function composeAnswer({ caller, hit, draft = null, score = 1, hazards = [], names = {}, now = new Date(), sureScore = SURE_SCORE }) {
  const notes = [];
  const parts = [];
  let unsafeRemoved = 0;
  // Never claim safety, whoever wrote the words. Applied to each piece before
  // credits are added, so a removed claim cannot leave a credit on its own.
  const safe = (s) => {
    const { text, removed } = removeUnsafeClaims(s);
    unsafeRemoved += removed.length;
    return text.trim();
  };

  // 1. Hazards first.
  const live = hazards
    .filter((h) => h && h.status === 'active' && h.topic === 'hazard' && (!h.expires_at || new Date(h.expires_at) > now) && h._id !== hit?._id)
    .sort((a, b) => new Date(notedAt(b)) - new Date(notedAt(a)))
    .slice(0, MAX_HAZARDS_SPOKEN);
  for (const h of live) {
    const said = safe(h.summary);
    if (said) parts.push(`Careful: ${said.replace(/[.!\s]+$/, '')}, reported ${ageText(notedAt(h), now)}.`);
  }
  if (live.length) notes.push(`Said ${plural(live.length, 'hazard')} first.`);

  if (hit) {
    const age = ageText(notedAt(hit), now);
    const mine = hit.owner_id === caller.id;
    const who = mine ? 'you' : names[hit.owner_id] ?? 'someone else';

    if (isMedication(hit)) {
      // 2. Medication: the stored words only, with who and when, and a reminder.
      const source = mine ? `Your note from ${age} says` : `A note from ${who}, ${age}, says`;
      const said = safe(hit.summary);
      parts.push(said ? `${source}: ${said} ${LABEL_REMINDER}` : CANNOT_CONFIRM);
      notes.push('Medication: read the note as recorded, with no dose advice.');
    } else {
      let text = (draft ?? '').trim() || hit.summary.trim();
      if (draft && DOSE_ADVICE.test(draft) && !DOSE_ADVICE.test(hit.summary)) {
        text = hit.summary.trim();
        notes.push("Gemini's wording gave dose advice, so the stored note was used instead.");
      }
      text = safe(text);
      if (!text) {
        // Nothing left once the safety claims were removed: no credit, no hedge.
        parts.push(CANNOT_CONFIRM);
      } else {
        // 3. Weak match: say so.
        if (score < sureScore) {
          text = `I'm not sure, but the closest note says: ${text}`;
          notes.push(`Match score ${score.toFixed(2)} is below ${sureScore}, so the answer was hedged.`);
        }
        // 4. Who noted it and when, and whether it may have moved.
        const credit = mine ? `You noted this ${age}.` : `Noted by ${who} ${age}.`;
        const stale = !FIXED_TOPICS.has(hit.topic) && now - new Date(notedAt(hit)) > STALE_MS ? ' It may have moved since.' : '';
        parts.push(`${text} ${credit}${stale}`);
      }
    }
  }

  if (unsafeRemoved) notes.push(`Removed ${plural(unsafeRemoved, 'sentence')} claiming something was safe or clear.`);
  let reply = parts.join(' ').trim() || CANNOT_CONFIRM;
  if (reply.length > MAX_REPLY_CHARS) reply = `${reply.slice(0, MAX_REPLY_CHARS - 3).replace(/\s+\S*$/, '')}...`;
  return { reply_text: reply, notes };
}

// ---------------------------------------------------------------------------
// Live guidance
// ---------------------------------------------------------------------------

// Call before every guidance step. When the newest frame is too old, guidance
// stops and the user is told, instead of directions going on from a stale view.
export function guidanceCheck({ lastFrameAt, now = new Date(), maxAgeMs = CAMERA_LOST_MS }) {
  const age = lastFrameAt ? now.getTime() - new Date(lastFrameAt).getTime() : Infinity;
  if (!(age <= maxAgeMs)) {
    return { ok: false, say: CAMERA_LOST, note: `Stopped guidance: newest frame is ${Number.isFinite(age) ? `${Math.round(age / 1000)} s` : 'missing'} old.` };
  }
  return { ok: true };
}
