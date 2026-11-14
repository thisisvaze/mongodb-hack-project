import { SOURCE_LABEL, STATUS_LABEL, formatDateTime, formatTime, labelOf } from '../format';
import type { Memory, Rules, User } from '../types';
import { canSee, visibilityReason } from '../visibility';

interface Props {
  memories: Memory[];
  users: User[];
  rules: Rules | null;
  actingUser: User | null;
  fresh: ReadonlySet<string>;
}

export function MemoryList({ memories, users, rules, actingUser, fresh }: Props) {
  if (memories.length === 0) return <p className="empty-note">No memories yet.</p>;

  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const nameOf = (id: string) => users.find((user) => user.id === id)?.name ?? id;

  return (
    <ul className="cards">
      {memories.map((memory) => (
        <li key={memory.id}>
          <MemoryCard
            memory={memory}
            ownerName={nameOf(memory.owner_id)}
            replacement={memory.superseded_by ? byId.get(memory.superseded_by) : undefined}
            rules={rules}
            actingUser={actingUser}
            fresh={fresh.has(memory.id)}
          />
        </li>
      ))}
    </ul>
  );
}

interface CardProps {
  memory: Memory;
  ownerName: string;
  replacement: Memory | undefined;
  rules: Rules | null;
  actingUser: User | null;
  fresh: boolean;
}

function MemoryCard({ memory, ownerName, replacement, rules, actingUser, fresh }: CardProps) {
  const inactive = memory.status !== 'active';
  const visible = actingUser && rules ? canSee(actingUser, memory, rules) : null;

  return (
    <article
      id={`memory-${memory.id}`}
      className={`card memory status-${memory.status}${fresh ? ' is-fresh' : ''}`}
      aria-labelledby={`memory-${memory.id}-item`}
    >
      <header className="card-head">
        <span className={`tag status-tag status-${memory.status}`}>{labelOf(STATUS_LABEL, memory.status)}</span>
        <span className="card-id">{memory.id}</span>
        <time className="card-time" dateTime={memory.created_at}>
          {formatTime(memory.created_at)}
        </time>
      </header>

      <div className="memory-body">
        <div className="memory-text">
          <h3 id={`memory-${memory.id}-item`} className="memory-item">
            {memory.item}
          </h3>
          <p className="memory-summary">{memory.summary}</p>
        </div>
        {memory.image_url && <img className="memory-image" src={memory.image_url} alt={`Camera frame for ${memory.item}`} />}
      </div>

      {inactive && (
        <p className="memory-fate">
          {memory.status === 'superseded' && (
            <>
              Superseded.{' '}
              {replacement ? (
                <>
                  Replaced by <a href={`#memory-${replacement.id}`}>{replacement.id}</a>: “{replacement.summary}”
                </>
              ) : memory.superseded_by ? (
                <>Replaced by {memory.superseded_by}.</>
              ) : (
                <>The replacement is not known.</>
              )}
            </>
          )}
          {memory.status === 'forgotten' && <>Forgotten at {formatTime(memory.updated_at)}. No longer used for answers.</>}
          {memory.status === 'expired' && <>Expired at {formatTime(memory.updated_at)}. No longer used for answers.</>}
        </p>
      )}

      <dl className="facts">
        <div className="wide">
          <dt>Location</dt>
          <dd>{memory.location || 'Not given'}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{ownerName}</dd>
        </div>
        <div>
          <dt>Topic</dt>
          <dd>{memory.topic}</dd>
        </div>
        <div>
          <dt>Group</dt>
          <dd>{memory.group}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{labelOf(SOURCE_LABEL, memory.source)}</dd>
        </div>
        {memory.expires_at && (
          <div>
            <dt>{memory.status === 'expired' ? 'Expired' : 'Expires'}</dt>
            <dd>
              <time dateTime={memory.expires_at}>{formatDateTime(memory.expires_at)}</time>
            </dd>
          </div>
        )}
      </dl>

      {actingUser && rules && visible !== null && (
        <p className="visibility">
          <span className={`tag ${visible ? 'see-yes' : 'see-no'}`}>
            {visible ? `Visible to ${actingUser.name}` : `Hidden from ${actingUser.name}`}
          </span>
          <span className="visibility-reason">{visibilityReason(actingUser, memory, rules)}</span>
        </p>
      )}
    </article>
  );
}
