import { formatTime } from '../format';
import type { FrameEvent, User } from '../types';

interface Props {
  users: User[];
  frames: Record<string, FrameEvent>;
}

/** The latest camera frame per user, as delivered by `frame` events. */
export function FramesPanel({ users, frames }: Props) {
  return (
    <ul className="frames">
      {users.map((user) => {
        const frame = frames[user.id];
        return (
          <li key={user.id}>
            <figure className="frame">
              {frame ? (
                <img src={frame.image_url} alt={`Latest camera frame from ${user.name}`} />
              ) : (
                <div className="frame-empty">No frame yet</div>
              )}
              <figcaption>
                <span className="frame-name">{user.name}</span>
                {frame && <time dateTime={frame.ts}>{formatTime(frame.ts)}</time>}
              </figcaption>
            </figure>
          </li>
        );
      })}
    </ul>
  );
}
