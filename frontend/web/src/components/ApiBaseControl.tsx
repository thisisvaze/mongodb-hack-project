import { useState, type FormEvent } from 'react';
import { API_BASE, DEFAULT_API_BASE, changeApiBase } from '../api';

/** Shows which backend the page talks to and lets it be switched without a rebuild. */
export function ApiBaseControl() {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(API_BASE);
  const [problem, setProblem] = useState<string | null>(null);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const next = value.trim();
    if (!/^https?:\/\/\S+$/.test(next)) {
      setProblem('Enter a full URL that starts with http:// or https://');
      return;
    }
    changeApiBase(next);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="button small quiet"
        title={`Backend: ${API_BASE}`}
        onClick={() => setEditing(true)}
      >
        Server
      </button>
    );
  }

  return (
    <form className="api-base editing" onSubmit={save}>
      <label className="api-base-label" htmlFor="api-base-input">
        Backend URL
      </label>
      <input
        id="api-base-input"
        className="input small"
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-describedby={problem ? 'api-base-problem' : undefined}
      />
      <button type="submit" className="button small">
        Use and reload
      </button>
      <button type="button" className="button small quiet" onClick={() => changeApiBase(null)}>
        Reset to {DEFAULT_API_BASE}
      </button>
      <button type="button" className="button small quiet" onClick={() => setEditing(false)}>
        Cancel
      </button>
      {problem && (
        <p id="api-base-problem" className="problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
