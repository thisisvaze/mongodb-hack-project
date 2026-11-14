import { ACTION_LABEL, VERDICT_LABEL, formatTime, labelOf } from '../format';
import type { AuditEntry, User } from '../types';

interface Props {
  entries: AuditEntry[];
  users: User[];
  fresh: ReadonlySet<string>;
}

export function AuditLog({ entries, users, fresh }: Props) {
  if (entries.length === 0) return <p className="empty-note">No events yet.</p>;

  const actor = (id: string) => users.find((u) => u.id === id)?.name ?? id;

  return (
    <ol className="audit">
      {entries.map((entry) => (
        <li key={entry.id} className={`audit-row verdict-${entry.verdict}${fresh.has(entry.id) ? ' is-fresh' : ''}`}>
          <p className="audit-head">
            <span className={`tag verdict-tag verdict-${entry.verdict}`}>{labelOf(VERDICT_LABEL, entry.verdict)}</span>
            <span className="audit-action">{labelOf(ACTION_LABEL, entry.action)}</span>
            <span className="audit-actor">{actor(entry.actor_id)}</span>
            <time className="card-time" dateTime={entry.ts}>
              {formatTime(entry.ts)}
            </time>
          </p>
          <p className="audit-detail">{entry.detail}</p>
        </li>
      ))}
    </ol>
  );
}
