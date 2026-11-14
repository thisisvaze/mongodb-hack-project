import { useRef, useState, type FormEvent } from 'react';
import { SPACE_ID, errorMessage, linkWithApi, nowIso, postTurn, type StreamStatus } from '../api';
import { ApiBaseControl } from '../components/ApiBaseControl';
import { AuditLog } from '../components/AuditLog';
import { FramesPanel } from '../components/FramesPanel';
import { MemoryList } from '../components/MemoryList';
import { ReplyPanel, type TurnResult } from '../components/ReplyPanel';
import { RulesEditor } from '../components/RulesEditor';
import { UserPicker } from '../components/UserPicker';
import { useMute, usePersistentState, useSpace } from '../hooks';
import { speakReply, unlockSpeech } from '../speech';

const STREAM_LABEL: Record<StreamStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  retrying: 'Disconnected, retrying',
};

export function Dashboard() {
  const { data, status, loadError, fresh, reload, applyRules } = useSpace(SPACE_ID);
  const [actingId, setActingId] = usePersistentState('homeMemory.actingUser', '');
  const [muted, setMuted] = useMute();
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TurnResult | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const actingUser = data.users.find((user) => user.id === actingId) ?? data.users[0] ?? null;
  const activeCount = data.memories.filter((memory) => memory.status === 'active').length;
  // Shown in place of the lists until the first snapshot arrives.
  const waiting = data.loaded ? null : loadError ? 'Not loaded.' : 'Loading…';

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const said = text.trim();
    if (!said || !actingUser || pending) return;
    if (!muted) unlockSpeech();
    setPending(true);
    setText('');
    const turn = { userName: actingUser.name, text: said, sentImage: false };
    try {
      const response = await postTurn({
        space_id: SPACE_ID,
        user_id: actingUser.id,
        ts: nowIso(),
        text: said,
        image_b64: null,
        image_url: null,
      });
      setResult({ ...turn, response });
      if (!mutedRef.current) speakReply(response.reply_text, response.audio_url);
    } catch (err) {
      setResult({ ...turn, error: errorMessage(err) });
      setText(said);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="dash">
      <header className="topbar">
        <h1>Home memory</h1>
        <dl className="topbar-facts">
          <div>
            <dt>Space</dt>
            <dd>{SPACE_ID}</dd>
          </div>
          <div>
            <dt>Event stream</dt>
            <dd>
              <span className={`tag stream-${status}`} role="status">
                {STREAM_LABEL[status]}
              </span>
            </dd>
          </div>
        </dl>
        <div className="topbar-tools">
          <ApiBaseControl />
          <a className="plain-link" href={linkWithApi('/capture')}>
            Capture page
          </a>
        </div>
      </header>

      {loadError && (
        <p className="banner" role="alert">
          <span className="tag kind-error">Error</span>
          <span>Could not load the home's state. {loadError}</span>
          <button type="button" className="button small" onClick={reload}>
            Retry
          </button>
        </p>
      )}

      <section className="turn" aria-labelledby="turn-heading">
        <h2 id="turn-heading" className="visually-hidden">
          Say something as a user
        </h2>

        <UserPicker
          legend="Acting as"
          name="acting-user"
          users={data.users}
          selectedId={actingUser?.id ?? null}
          onSelect={setActingId}
          emptyText={waiting ?? 'No users.'}
        />

        <form className="ask" onSubmit={send}>
          <label htmlFor="ask-input" className="ask-label">
            Note or question{actingUser ? ` from ${actingUser.name}` : ''}
          </label>
          <div className="ask-row">
            <input
              id="ask-input"
              className="input"
              type="text"
              autoComplete="off"
              placeholder="I'm putting my keys in my left jacket pocket"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <button type="submit" className="button" disabled={!actingUser || pending || !text.trim()}>
              {pending ? 'Sending…' : 'Send'}
            </button>
            <label className="toggle">
              <input type="checkbox" checked={muted} onChange={(event) => setMuted(event.target.checked)} />
              <span>Mute voice</span>
            </label>
          </div>
        </form>

        <ReplyPanel result={result} pending={pending} hint="The reply appears here and is read aloud." />
      </section>

      <main className="columns">
        <section className="panel" aria-labelledby="memories-heading">
          <div className="panel-head">
            <h2 id="memories-heading">Memories</h2>
            <p className="panel-count">
              {activeCount} active of {data.memories.length}
            </p>
          </div>
          <p className="fine-print">
            Admin view: every memory, newest first. Visible or Hidden is worked out in this page from the rules. The
            backend enforces it.
          </p>
          <div className="panel-scroll" tabIndex={0} role="group" aria-label="Memory list">
            {waiting ? (
              <p className="empty-note">{waiting}</p>
            ) : (
              <MemoryList
                memories={data.memories}
                users={data.users}
                rules={data.rules}
                actingUser={actingUser}
                fresh={fresh}
              />
            )}
          </div>
        </section>

        <div className="panel-stack">
          <section className="panel" aria-labelledby="rules-heading">
            <div className="panel-head">
              <h2 id="rules-heading">Rules</h2>
              <p className="panel-count">Who can see which group</p>
            </div>
            {data.rules ? (
              <RulesEditor rules={data.rules} users={data.users} onSaved={applyRules} />
            ) : (
              <p className="empty-note">{waiting ?? 'No rules.'}</p>
            )}
          </section>

          <section className="panel" aria-labelledby="frames-heading">
            <div className="panel-head">
              <h2 id="frames-heading">Cameras</h2>
              <p className="panel-count">Latest frame per user</p>
            </div>
            {waiting ? <p className="empty-note">{waiting}</p> : <FramesPanel users={data.users} frames={data.frames} />}
          </section>
        </div>

        <section className="panel" aria-labelledby="audit-heading">
          <div className="panel-head">
            <h2 id="audit-heading">Audit log</h2>
            <p className="panel-count">{data.audit.length} entries, newest first</p>
          </div>
          <div className="panel-scroll" tabIndex={0} role="group" aria-label="Audit entries">
            {waiting ? (
              <p className="empty-note">{waiting}</p>
            ) : (
              <AuditLog entries={data.audit} users={data.users} fresh={fresh} />
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
