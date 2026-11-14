import { ACTION_LABEL, VERDICT_LABEL, formatTime, labelOf } from '../format';
import type { AuditEntry, User } from '../types';

interface Props {
  entries: AuditEntry[];
  users: User[];
  fresh: ReadonlySet<string>;
}

export function AuditLog({ entries, users, fresh }: Props) {
  if (entries.length === 0) return <p className="empty-note">Nothing logged yet.</p>;

  const actor = (id: string) => {
    const user = users.find((u) => u.id === id);
    return user ? `${user.name} (${user.role})` : id;
  };

  return (
    <ol className="audit">
      {entries.map((entry) => (
        <li key={entry.id} className={`audit-row verdict-${entry.verdict}${fresh.has(entry.id) ? ' is-fresh' : ''}`}>
          <p className="audit-head">
            <span className={`tag verdict-tag verdict-${entry.verdict}`}>{labelOf(VERDICT_LABEL, entry.verdict)}</span>
            <span className="audit-action">{labelOf(ACTION_LABEL, entry.action)}</span>
            <time className="card-time" dateTime={entry.ts}>
              {formatTime(entry.ts)}
            </time>
          </p>
          <p className="audit-detail">
            <span className="audit-actor">{actor(entry.actor_id)}.</span> {entry.detail}
          </p>
          {entry.memory_ids.length > 0 && (
            <p className="audit-memories">
              {entry.memory_ids.length === 1 ? 'Memory' : 'Memories'}:{' '}
              {entry.memory_ids.map((id, index) => (
                <span key={id}>
                  {index > 0 && ', '}
                  <a href={`#memory-${id}`}>{id}</a>
                </span>
              ))}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
