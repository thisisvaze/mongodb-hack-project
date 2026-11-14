import { useState } from 'react';
import { SOURCE_LABEL, STATUS_LABEL, formatDateTime, formatTime, labelOf } from '../format';
import type { Memory, Rules, User } from '../types';
import { canSee, formatGroup } from '../visibility';

interface Props {
  memories: Memory[];
  users: User[];
  rules: Rules | null;
  actingUser: User | null;
  fresh: ReadonlySet<string>;
}

export function MemoryList({ memories, users, rules, actingUser, fresh }: Props) {
  const [showHistory, setShowHistory] = useState(false);

  if (memories.length === 0) return <p className="empty-note">No memories stored in this space yet.</p>;

  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const nameOf = (id: string) => users.find((user) => user.id === id)?.name ?? id;

  // Keep freshly updated items visible inline so live updates/wipes show immediately.
  const main = memories.filter((memory) => memory.status === 'active' || fresh.has(memory.id));
  const archived = memories.filter((memory) => memory.status !== 'active' && !fresh.has(memory.id));

  return (
    <div className="memory-stack">
      {main.length === 0 && <p className="empty-note">No active memories in this space.</p>}
      {main.length > 0 && (
        <ul className="cards">
          {main.map((memory) => (
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
      )}

      {archived.length > 0 && (
        <div className="history-block">
          <button
            type="button"
            className="history-toggle"
            onClick={() => setShowHistory((open) => !open)}
            aria-expanded={showHistory}
          >
            {showHistory ? 'Hide' : 'Show'} {archived.length} retired / wiped
          </button>
          {showHistory && (
            <ul className="cards archived-cards">
              {archived.map((memory) => (
                <li key={memory.id}>
                  <MemoryCard
                    memory={memory}
                    ownerName={nameOf(memory.owner_id)}
                    replacement={memory.superseded_by ? byId.get(memory.superseded_by) : undefined}
                    rules={rules}
                    actingUser={actingUser}
                    fresh={false}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
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
  const isOwner = actingUser?.id === memory.owner_id;
  const isPrivateGroup = memory.group === rules?.default_group || memory.group.endsWith('_only');

  return (
    <article
      id={`memory-${memory.id}`}
      className={`card memory status-${memory.status}${fresh ? ' is-fresh' : ''}`}
      aria-labelledby={`memory-${memory.id}-item`}
    >
      <header className="card-head">
        {inactive ? (
          <span className={`tag status-tag status-${memory.status}`}>{labelOf(STATUS_LABEL, memory.status)}</span>
        ) : visible === false ? (
          <span className="tag see-no">Locked</span>
        ) : isPrivateGroup ? (
          <span className="tag see-private">{isOwner ? 'Private · Yours' : 'Private'}</span>
        ) : (
          <span className="tag see-yes">Shared · {formatGroup(memory.group)}</span>
        )}
        <span className="meta-pill">{labelOf(SOURCE_LABEL, memory.source)}</span>
        {!isOwner && <span className="meta-note">by {ownerName}</span>}
        {memory.expires_at && !inactive && (
          <span className="meta-note">
            wipes <time dateTime={memory.expires_at}>{formatDateTime(memory.expires_at)}</time>
          </span>
        )}
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
            <>{replacement ? `Moved → ${replacement.summary}` : 'Replaced by a newer sighting.'}</>
          )}
          {memory.status === 'forgotten' && <>Wiped at {formatTime(memory.updated_at)}.</>}
          {memory.status === 'expired' && <>Auto-expired at {formatTime(memory.updated_at)}.</>}
        </p>
      )}
    </article>
  );
}
