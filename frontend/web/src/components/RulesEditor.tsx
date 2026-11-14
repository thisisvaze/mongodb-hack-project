import { useState } from 'react';
import { SPACE_ID, errorMessage, putRules } from '../api';
import { formatTime } from '../format';
import type { Rules, User } from '../types';

interface Props {
  rules: Rules;
  users: User[];
  onSaved(rules: Rules): void;
}

type Message = { tone: 'good' | 'bad' | 'quiet'; text: string };

/** Order-independent fingerprint, so a backend that reorders JSON keys does not look like a change. */
function rulesKey(rules: Rules): string {
  const roles = Object.keys(rules.roles)
    .sort()
    .map((role) => `${role}=${[...rules.roles[role].can_see].sort().join(',')}`);
  const topics = Object.keys(rules.topics)
    .sort()
    .map((topic) => `${topic}=${rules.topics[topic].group}/${rules.topics[topic].keep_for ?? ''}`);
  return [roles.join(';'), topics.join(';'), rules.default_group].join('|');
}

// Roles follow the order of the users list, groups are alphabetical with the
// default group last. Neither depends on the key order of the Rules JSON.
function orderedRoles(rules: Rules, users: User[]): string[] {
  const names = Object.keys(rules.roles);
  const fromUsers = [...new Set(users.map((user) => user.role))].filter((role) => names.includes(role));
  return [...fromUsers, ...names.filter((role) => !fromUsers.includes(role)).sort()];
}

function orderedGroups(...documents: Rules[]): string[] {
  const groups = new Set<string>();
  for (const rules of documents) {
    Object.values(rules.topics).forEach((topic) => groups.add(topic.group));
    Object.values(rules.roles).forEach((role) => role.can_see.forEach((group) => group !== '*' && groups.add(group)));
  }
  const fallback = documents[0].default_group;
  groups.delete(fallback);
  return [...[...groups].sort(), fallback];
}

function topicsIn(rules: Rules, group: string): string {
  const names = Object.keys(rules.topics)
    .filter((topic) => rules.topics[topic].group === group)
    .sort()
    .map((topic) => (rules.topics[topic].keep_for ? `${topic} (kept ${rules.topics[topic].keep_for})` : topic));
  if (group === rules.default_group) names.push('anything else');
  return names.length ? names.join(', ') : 'no topics';
}

export function RulesEditor({ rules, users, onSaved }: Props) {
  const serverKey = rulesKey(rules);
  const [syncedKey, setSyncedKey] = useState(serverKey);
  const [draft, setDraft] = useState(rules);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  // New rules from the server (a `rules` event or a save) replace the draft.
  if (syncedKey !== serverKey) {
    const draftKey = rulesKey(draft);
    setSyncedKey(serverKey);
    setDraft(rules);
    if (draftKey !== serverKey) {
      const lostEdits = draftKey !== syncedKey;
      setMessage({
        tone: 'quiet',
        text: lostEdits
          ? 'Rules changed on the backend. Your unsaved edits were replaced.'
          : `Updated from the backend at ${formatTime(new Date().toISOString())}.`,
      });
    }
  }

  const roles = orderedRoles(draft, users);
  const groups = orderedGroups(rules, draft);
  const dirty = rulesKey(draft) !== serverKey;
  const status: Message =
    message?.tone === 'bad'
      ? message
      : dirty
        ? { tone: 'quiet', text: 'Unsaved changes.' }
        : (message ?? { tone: 'quiet', text: 'No unsaved changes.' });

  const toggle = (role: string, group: string, on: boolean) => {
    const current = draft.roles[role]?.can_see ?? [];
    const next = on ? [...current, group] : current.filter((g) => g !== group);
    setDraft({
      ...draft,
      roles: { ...draft.roles, [role]: { ...draft.roles[role], can_see: groups.filter((g) => next.includes(g)) } },
    });
    setMessage(null);
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await putRules(SPACE_ID, draft);
      onSaved(response.rules);
      setMessage({ tone: 'good', text: `Saved at ${formatTime(new Date().toISOString())}.` });
    } catch (err) {
      setMessage({ tone: 'bad', text: `Not saved. ${errorMessage(err)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rules">
      <table className="matrix">
        <caption className="visually-hidden">Which role can see which group of memories</caption>
        <thead>
          <tr>
            <th scope="col">Group</th>
            {roles.map((role) => (
              <th scope="col" key={role}>
                {role}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group, row) => (
            <tr key={group}>
              <th scope="row">
                <span className="matrix-group">{group}</span>
                <span className="matrix-topics">{topicsIn(draft, group)}</span>
              </th>
              {roles.map((role) => {
                const sees = draft.roles[role]?.can_see ?? [];
                if (sees.includes('*')) {
                  // One cell for the whole column: a "*" role is not edited group by group.
                  return row === 0 ? (
                    <td key={role} rowSpan={groups.length} className="matrix-all">
                      Everything
                    </td>
                  ) : null;
                }
                const id = `rule-${role}-${group}`;
                const checked = sees.includes(group);
                return (
                  <td key={role}>
                    <label className="check" htmlFor={id}>
                      <input
                        id={id}
                        type="checkbox"
                        checked={checked}
                        disabled={saving}
                        onChange={(event) => toggle(role, group, event.target.checked)}
                      />
                      <span className="visually-hidden">
                        {role} can see {group}
                      </span>
                      <span className={`check-word ${checked ? 'on' : 'off'}`} aria-hidden="true">
                        {checked ? 'Sees' : 'Hidden'}
                      </span>
                    </label>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="rules-actions">
        <button type="button" className="button" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save rules'}
        </button>
        <button type="button" className="button quiet" onClick={() => setDraft(rules)} disabled={!dirty || saving}>
          Discard
        </button>
        <p className={`rules-message ${status.tone}`} role="status">
          {status.text}
        </p>
      </div>
      <p className="fine-print">Owners always see their own memories.</p>
    </div>
  );
}
