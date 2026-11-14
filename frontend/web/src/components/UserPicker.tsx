import type { User } from '../types';

interface Props {
  legend: string;
  /** Name of the radio group. */
  name: string;
  users: User[];
  selectedId: string | null;
  onSelect(userId: string): void;
  /** Shown when there are no users to pick from. */
  emptyText: string;
}

export function UserPicker({ legend, name, users, selectedId, onSelect, emptyText }: Props) {
  return (
    <fieldset className="acting">
      <legend>{legend}</legend>
      {users.length === 0 && <p className="empty-note">{emptyText}</p>}
      <div className="choices">
        {users.map((user) => (
          <label key={user.id} className="choice">
            <input
              type="radio"
              name={name}
              value={user.id}
              checked={selectedId === user.id}
              onChange={() => onSelect(user.id)}
            />
            <span className="choice-face">
              <span className="choice-name">
                <span className="choice-mark" aria-hidden="true">
                  ✓
                </span>
                {user.name}
              </span>
              <span className="choice-role">role: {user.role}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
