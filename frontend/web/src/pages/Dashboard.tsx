import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  SPACE_ID,
  SPACE_PRESETS,
  errorMessage,
  linkWithApi,
  nowIso,
  postTurn,
  syncSpaceParam,
  type StreamStatus,
} from '../api';
import { ApiBaseControl } from '../components/ApiBaseControl';
import { AuditLog } from '../components/AuditLog';
import { MemoryList } from '../components/MemoryList';
import { RulesEditor } from '../components/RulesEditor';
import { UserPicker } from '../components/UserPicker';
import { KIND_LABEL, formatTime, labelOf } from '../format';
import { useMute, usePersistentState, useSpace } from '../hooks';
import { cameraProblem, grabFrame } from '../media';
import { speakReply, unlockSpeech } from '../speech';

const STREAM_LABEL: Record<StreamStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  retrying: 'Reconnecting',
};

export function Dashboard() {
  const [spaceId, setSpaceId] = useState(SPACE_ID);
  const { data, status, loadError, fresh, reload, applyRules, recordLocalTurn } = useSpace(spaceId);
  const [actingId, setActingId] = usePersistentState(`safespace.user.${spaceId}`, '');
  const [muted, setMuted] = useMute();
  const [showRules, setShowRules] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [camLive, setCamLive] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const stopCam = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamLive(false);
  }, []);

  const toggleCam = async () => {
    if (camLive) {
      stopCam();
      return;
    }
    setCamError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setCamLive(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch (err) {
      setCamError(cameraProblem(err));
    }
  };

  useEffect(() => stopCam, [stopCam]);

  const spaces = SPACE_PRESETS.some((preset) => preset.id === spaceId)
    ? SPACE_PRESETS
    : [...SPACE_PRESETS, { id: spaceId, label: spaceId, context: 'Custom indoor space' }];
  const activePreset = spaces.find((preset) => preset.id === spaceId) ?? spaces[0];

  const actingUser = data.users.find((user) => user.id === actingId) ?? data.users[0] ?? null;
  const activeCount = data.memories.filter((memory) => memory.status === 'active').length;
  const waiting = data.loaded ? null : loadError ? 'Offline' : 'Loading…';
  const nameOf = (id: string) => data.users.find((user) => user.id === id)?.name ?? id;

  const selectSpace = (nextSpace: string) => {
    if (nextSpace === spaceId) return;
    syncSpaceParam(nextSpace);
    setSpaceId(nextSpace);
    setTurnError(null);
    setText('');
  };

  const runTurn = async (rawText: string) => {
    const said = rawText.trim();
    if (!said || !actingUser || pending) return;
    if (!muted) unlockSpeech();
    setPending(true);
    setTurnError(null);
    setText('');
    const sentAt = nowIso();
    const imageB64 = camLive && videoRef.current ? grabFrame(videoRef.current) : null;
    try {
      const response = await postTurn({
        space_id: spaceId,
        user_id: actingUser.id,
        ts: sentAt,
        text: said,
        audio: null,
        image_b64: imageB64,
        image_url: null,
      });
      recordLocalTurn({
        user_id: actingUser.id,
        ts: sentAt,
        transcript: response.heard_text ?? said,
        kind: response.kind,
        reply_text: response.reply_text,
        image_url: imageB64 ? `data:image/jpeg;base64,${imageB64}` : null,
      });
      if (!mutedRef.current) speakReply(response.reply_text, response.audio_url);
    } catch (err) {
      setTurnError(errorMessage(err));
      setText(said);
    } finally {
      setPending(false);
    }
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    void runTurn(text);
  };

  const liveTurn = data.latestTurn;
  const liveFrame = data.latestFrame;
  const turnTone = turnError || liveTurn?.kind === 'denied' ? 'bad' : liveTurn ? 'good' : 'idle';

  return (
    <div className="dash">
      <header className="topbar">
        <div className="brand">
          <h1><img className="brand-logo" src="/safespace-logo.svg" alt="SafeSpace" /></h1>
          <span className="brand-sub">Blind indoor memory</span>
        </div>

        {spaces.length > 1 && (
          <nav className="space-tabs" aria-label="Indoor spaces">
            {spaces.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`space-tab${preset.id === spaceId ? ' is-active' : ''}`}
                aria-pressed={preset.id === spaceId}
                onClick={() => selectSpace(preset.id)}
              >
                {preset.label}
              </button>
            ))}
          </nav>
        )}

        <div className="topbar-tools">
          <span className={`status-dot stream-${status}`} role="status">
            {STREAM_LABEL[status]}
          </span>
          <button
            type="button"
            className={`button small quiet${showRules ? ' is-open' : ''}`}
            aria-expanded={showRules}
            onClick={() => setShowRules((open) => !open)}
          >
            Access rules
          </button>
          <a className="button small quiet link-button" href={linkWithApi('/capture', spaceId)}>
            Phone / cam
          </a>
          <ApiBaseControl />
        </div>
      </header>

      {loadError && (
        <p className="banner" role="alert">
          <span className="tag kind-error">Error</span>
          <span>{loadError}</span>
          {spaceId !== 'home' && (
            <button type="button" className="button small" onClick={() => selectSpace('home')}>
              Switch to Shared Home
            </button>
          )}
          <button type="button" className="button small quiet" onClick={reload}>
            Retry
          </button>
        </p>
      )}

      <section className="turn-bar" aria-label="Live input and controls">
        <div className="turn-meta">
          <UserPicker
            legend="Caller"
            name="acting-user"
            users={data.users}
            selectedId={actingUser?.id ?? null}
            onSelect={setActingId}
            emptyText={waiting ?? 'No users'}
          />
          <p className="space-context">{activePreset.context}</p>
        </div>

        <form className="ask" onSubmit={send}>
          <label htmlFor="ask-input" className="visually-hidden">
            Note or question{actingUser ? ` as ${actingUser.name}` : ''}
          </label>
          <div className="ask-row">
            <input
              id="ask-input"
              className="input"
              type="text"
              autoComplete="off"
              placeholder={
                actingUser
                  ? `Speak or type as ${actingUser.name} in ${activePreset.label}…`
                  : 'Speak or type a note or question…'
              }
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <button type="submit" className="button" disabled={!actingUser || pending || !text.trim()}>
              {pending ? 'Sending…' : 'Send'}
            </button>
            <button
              type="button"
              className="button quiet voice-toggle"
              aria-pressed={!muted}
              onClick={() => setMuted(!muted)}
            >
              {muted ? 'Muted' : 'Voice on'}
            </button>
          </div>

        </form>

        <div className="live-feed" aria-live="polite">
          <figure className="live-photo">
            <video
              ref={videoRef}
              className={`live-video${camLive ? ' is-live' : ''}`}
              playsInline
              muted
              autoPlay
              aria-label="Live webcam preview"
            />
            {camLive ? (
              <figcaption>
                <span>Live cam</span>
                <button type="button" className="mini-link" onClick={() => void toggleCam()}>
                  Stop
                </button>
              </figcaption>
            ) : liveFrame ? (
              <>
                <img src={liveFrame.image_url} alt={`Latest frame from ${nameOf(liveFrame.user_id)}`} />
                <figcaption>
                  <span>
                    {nameOf(liveFrame.user_id)} · <time dateTime={liveFrame.ts}>{formatTime(liveFrame.ts)}</time>
                  </span>
                  <button type="button" className="mini-link" onClick={() => void toggleCam()}>
                    Live cam
                  </button>
                </figcaption>
              </>
            ) : (
              <div className="live-photo-empty">
                <span className="live-label">Latest image</span>
                <span>{camError ?? 'No glasses photo yet'}</span>
                <button type="button" className="button small quiet" onClick={() => void toggleCam()}>
                  Use laptop cam
                </button>
              </div>
            )}
          </figure>

          <div className={`live-transcript tone-${turnTone}`}>
            <div className="live-head">
              <span className="live-label">Latest transcript &amp; reply</span>
              {liveTurn && (
                <span className="live-meta">
                  {nameOf(liveTurn.user_id)} · <time dateTime={liveTurn.ts}>{formatTime(liveTurn.ts)}</time>
                </span>
              )}
            </div>

            {turnError ? (
              <p className="reply-line">
                <span className="tag kind-error">Error</span>
                <span className="reply-text">{turnError}</span>
              </p>
            ) : liveTurn ? (
              <>
                <p className="transcript-quote">
                  {liveTurn.transcript ? `“${liveTurn.transcript}”` : '(raw audio clip received)'}
                </p>
                <p className="reply-line">
                  <span className={`tag kind-${liveTurn.kind}`}>{labelOf(KIND_LABEL, liveTurn.kind)}</span>
                  <span className="reply-text">{liveTurn.reply_text}</span>
                </p>
              </>
            ) : (
              <p className="empty-note">Waiting for speech from Mentra glasses, phone capture, or input above.</p>
            )}
          </div>
        </div>
      </section>

      {showRules && (
        <section className="drawer" aria-labelledby="rules-heading">
          <div className="panel-head">
            <h2 id="rules-heading">Access rules · {activePreset.label}</h2>
            <button type="button" className="button small quiet" onClick={() => setShowRules(false)}>
              Close
            </button>
          </div>
          {data.rules ? (
            <RulesEditor spaceId={spaceId} rules={data.rules} users={data.users} onSaved={applyRules} />
          ) : (
            <p className="empty-note">{waiting ?? 'No rules loaded.'}</p>
          )}
        </section>
      )}

      <main className="workspace">
        <section className="panel" aria-labelledby="memories-heading">
          <div className="panel-head">
            <h2 id="memories-heading">Space memories</h2>
            <span className="panel-count">{activeCount} active</span>
          </div>
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

        <section className="panel" aria-labelledby="audit-heading">
          <div className="panel-head">
            <h2 id="audit-heading">Governance log</h2>
            <span className="panel-count">{data.audit.length}</span>
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
