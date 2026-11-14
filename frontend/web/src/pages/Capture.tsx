import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { SPACE_ID, errorMessage, getState, linkWithApi, nowIso, postFrame, postTurn } from '../api';
import { ApiBaseControl } from '../components/ApiBaseControl';
import { ReplyPanel, type TurnResult } from '../components/ReplyPanel';
import { UserPicker } from '../components/UserPicker';
import { formatTime } from '../format';
import { useMute, usePersistentState } from '../hooks';
import {
  cameraProblem,
  cameraUnavailableReason,
  getRecognition,
  grabFrame,
  speechProblem,
  type Recognition,
} from '../media';
import { speakReply, stopSpeaking, unlockSpeech } from '../speech';
import type { User } from '../types';

const FRAME_INTERVAL_MS = 3_000;

type Camera = { kind: 'off' } | { kind: 'starting' } | { kind: 'live' } | { kind: 'problem'; message: string };

type Load = { state: 'loading' } | { state: 'ready' } | { state: 'failed'; message: string };

const CAMERA_LABEL: Record<Camera['kind'], string> = {
  off: 'Camera off',
  starting: 'Camera starting',
  live: 'Camera on',
  problem: 'Camera unavailable',
};

export function Capture() {
  const [users, setUsers] = useState<User[]>([]);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [userId, setUserId] = usePersistentState('homeMemory.captureUser', '');
  const [muted, setMuted] = useMute();
  const [camera, setCamera] = useState<Camera>({ kind: 'off' });
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState('');
  const [talkProblem, setTalkProblem] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TurnResult | null>(null);
  const [autoFrames, setAutoFrames] = useState(false);
  const [frameStatus, setFrameStatus] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraRun = useRef(0);
  const recognitionRef = useRef<Recognition | null>(null);
  const busyRef = useRef(false);

  const RecognitionClass = useMemo(getRecognition, []);
  const user = users.find((candidate) => candidate.id === userId) ?? users[0] ?? null;
  const frameUserId = user?.id;

  // Speech and camera callbacks outlive a render, so they read the latest values from here.
  const latest = useRef({ user, muted });
  latest.current = { user, muted };

  const loadUsers = useCallback(async () => {
    setLoad({ state: 'loading' });
    try {
      const state = await getState(SPACE_ID);
      setUsers(state.users);
      setLoad({ state: 'ready' });
    } catch (err) {
      setLoad({ state: 'failed', message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const releaseCamera = useCallback(() => {
    cameraRun.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(async () => {
    releaseCamera();
    const run = cameraRun.current;
    const unavailable = cameraUnavailableReason();
    if (unavailable) {
      setCamera({ kind: 'problem', message: unavailable });
      return;
    }
    setCamera({ kind: 'starting' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      // The page moved on (stopped, restarted or closed) while the browser was asking.
      if (run !== cameraRun.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (run === cameraRun.current) setCamera({ kind: 'problem', message: 'The camera stopped.' });
      });
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      if (run === cameraRun.current) setCamera({ kind: 'live' });
    } catch (err) {
      if (run === cameraRun.current) setCamera({ kind: 'problem', message: cameraProblem(err) });
    }
  }, [releaseCamera]);

  const stopCamera = useCallback(() => {
    releaseCamera();
    setCamera({ kind: 'off' });
  }, [releaseCamera]);

  useEffect(() => {
    void startCamera();
    return () => {
      releaseCamera();
      recognitionRef.current?.abort();
      stopSpeaking();
    };
  }, [startCamera, releaseCamera]);

  const sendTurn = useCallback(async (said: string): Promise<boolean> => {
    const speaker = latest.current.user;
    const clean = said.trim();
    if (!clean || !speaker || busyRef.current) return false;
    busyRef.current = true;
    setPending(true);
    // Taken now, at the end of the utterance. Null when there is no camera picture.
    const image = streamRef.current && videoRef.current ? grabFrame(videoRef.current) : null;
    const turn = { userName: speaker.name, text: clean, sentImage: image !== null };
    try {
      const response = await postTurn({
        space_id: SPACE_ID,
        user_id: speaker.id,
        ts: nowIso(),
        text: clean,
        image_b64: image,
        image_url: null,
      });
      setResult({ ...turn, response });
      if (!latest.current.muted) speakReply(response.reply_text, response.audio_url);
      return true;
    } catch (err) {
      setResult({ ...turn, error: errorMessage(err) });
      return false;
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  }, []);

  const talk = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    if (!RecognitionClass) return;
    // Stop any reply still playing so the microphone does not pick it up.
    stopSpeaking();
    if (!muted) unlockSpeech();

    const recognition = new RecognitionClass();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let finalText = '';
    let lastHeard = '';
    let sent = false;
    const sendOnce = (said: string) => {
      if (sent || !said.trim()) return;
      sent = true;
      void sendTurn(said);
    };

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i];
        if (piece.isFinal) finalText += piece[0].transcript;
        else interim += piece[0].transcript;
      }
      lastHeard = `${finalText} ${interim}`.trim();
      setHeard(lastHeard);
      if (finalText.trim() && !interim) {
        sendOnce(finalText);
        recognition.stop();
      }
    };
    recognition.onerror = (event) => {
      const problem = speechProblem(event.error);
      if (problem) setTalkProblem(problem);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      // Stopped by hand before the browser marked the words final: send what was heard.
      sendOnce(lastHeard);
    };

    recognitionRef.current = recognition;
    setHeard('');
    setTalkProblem(null);
    setListening(true);
    try {
      recognition.start();
    } catch (err) {
      recognitionRef.current = null;
      setListening(false);
      setTalkProblem(`Speech recognition could not start. ${errorMessage(err)}`);
    }
  };

  const submitText = async (event: FormEvent) => {
    event.preventDefault();
    const said = text.trim();
    if (!said || pending) return;
    if (!muted) unlockSpeech();
    setText('');
    const sent = await sendTurn(said);
    if (!sent) setText(said);
  };

  useEffect(() => {
    if (!autoFrames) {
      setFrameStatus('');
      return;
    }
    if (camera.kind !== 'live' || !frameUserId) {
      setFrameStatus('Waiting for the camera.');
      return;
    }
    let stopped = false;
    let busy = false;
    let count = 0;
    const sendFrame = async () => {
      if (busy || document.hidden) return;
      const image = videoRef.current ? grabFrame(videoRef.current) : null;
      if (!image) return;
      busy = true;
      try {
        await postFrame({ space_id: SPACE_ID, user_id: frameUserId, ts: nowIso(), image_b64: image, image_url: null });
        count += 1;
        if (!stopped) setFrameStatus(`${count} sent. Last at ${formatTime(new Date().toISOString())}.`);
      } catch (err) {
        if (!stopped) setFrameStatus(`Frame not sent. ${errorMessage(err)}`);
      } finally {
        busy = false;
      }
    };
    setFrameStatus('Sending frames.');
    void sendFrame();
    const timer = window.setInterval(sendFrame, FRAME_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [autoFrames, camera.kind, frameUserId]);

  const cameraBusy = camera.kind === 'live' || camera.kind === 'starting';
  const talkLabel = listening ? 'Listening. Tap to stop' : pending ? 'Sending…' : 'Talk';

  return (
    <div className="capture">
      <header className="capture-top">
        <h1>
          Home memory <span className="capture-sub">Capture</span>
        </h1>
        <a className="plain-link" href={linkWithApi('/')}>
          Dashboard
        </a>
      </header>

      {load.state === 'failed' && (
        <p className="banner" role="alert">
          <span className="tag kind-error">Error</span>
          <span>Could not load the users. {load.message}</span>
          <button type="button" className="button small" onClick={loadUsers}>
            Retry
          </button>
        </p>
      )}

      <UserPicker
        legend="Speaking as"
        name="capture-user"
        users={users}
        selectedId={user?.id ?? null}
        onSelect={setUserId}
        emptyText={load.state === 'loading' ? 'Loading users…' : 'No users loaded.'}
      />

      <section className="camera" aria-labelledby="camera-heading">
        <h2 id="camera-heading" className="visually-hidden">
          Camera
        </h2>
        <div className={`camera-view ${camera.kind === 'live' ? 'live' : 'idle'}`}>
          <video ref={videoRef} playsInline muted autoPlay aria-label="Camera preview" />
          {camera.kind !== 'live' && (
            <p className="camera-note" aria-hidden="true">
              {CAMERA_LABEL[camera.kind]}
            </p>
          )}
        </div>
        <div className="camera-controls">
          <span className={`tag camera-${camera.kind}`} role="status">
            {CAMERA_LABEL[camera.kind]}
          </span>
          <button type="button" className="button small quiet" onClick={cameraBusy ? stopCamera : startCamera}>
            {cameraBusy ? 'Stop camera' : 'Start camera'}
          </button>
        </div>
        {camera.kind === 'problem' && (
          <p className="problem" role="alert">
            {camera.message} You can still talk or type. Turns are sent without a picture.
          </p>
        )}
      </section>

      <section className="talk" aria-labelledby="talk-heading">
        <h2 id="talk-heading" className="visually-hidden">
          Talk or type
        </h2>
        <button
          type="button"
          className={`talk-button${listening ? ' listening' : ''}`}
          aria-pressed={listening}
          onClick={talk}
          disabled={!RecognitionClass || !user || (pending && !listening)}
        >
          {talkLabel}
        </button>
        {!RecognitionClass && (
          <p className="fine-print">Speech recognition is not available in this browser. Type below instead.</p>
        )}
        {heard && (
          <p className="heard" aria-live="polite">
            Heard: “{heard}”
          </p>
        )}
        {talkProblem && (
          <p className="problem" role="alert">
            {talkProblem}
          </p>
        )}

        <form className="ask" onSubmit={submitText}>
          <label htmlFor="capture-input" className="ask-label">
            Or type a note or question
          </label>
          <div className="ask-row">
            <input
              id="capture-input"
              className="input"
              type="text"
              autoComplete="off"
              enterKeyHint="send"
              placeholder="Where are my keys?"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <button type="submit" className="button" disabled={!user || pending || !text.trim()}>
              Send
            </button>
          </div>
        </form>
      </section>

      <ReplyPanel result={result} pending={pending} hint="The reply appears here and is read aloud." />

      <section className="capture-options" aria-labelledby="options-heading">
        <h2 id="options-heading" className="visually-hidden">
          Options
        </h2>
        <label className="toggle">
          <input type="checkbox" checked={autoFrames} onChange={(event) => setAutoFrames(event.target.checked)} />
          <span>Send a camera frame every {FRAME_INTERVAL_MS / 1000} seconds</span>
        </label>
        {frameStatus && (
          <p className="fine-print" role="status">
            {frameStatus}
          </p>
        )}
        <label className="toggle">
          <input type="checkbox" checked={muted} onChange={(event) => setMuted(event.target.checked)} />
          <span>Mute voice</span>
        </label>
      </section>

      <footer className="capture-foot">
        <ApiBaseControl />
      </footer>
    </div>
  );
}
