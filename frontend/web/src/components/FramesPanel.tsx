import { formatTime } from '../format';
import type { FrameEvent, User } from '../types';

interface Props {
  users: User[];
  frames: Record<string, FrameEvent>;
}

/** The latest camera frame per user, shown only when frames have arrived. */
export function FramesPanel({ users, frames }: Props) {
  const active = Object.entries(frames);
  if (active.length === 0) return null;
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? id;

  return (
    <ul className="frames">
      {active.map(([userId, frame]) => (
        <li key={userId}>
          <figure className="frame">
            <img src={frame.image_url} alt={`Latest camera frame from ${nameOf(userId)}`} />
            <figcaption>
              <span className="frame-name">{nameOf(userId)}</span>
              <time dateTime={frame.ts}>{formatTime(frame.ts)}</time>
            </figcaption>
          </figure>
        </li>
      ))}
    </ul>
  );
}
