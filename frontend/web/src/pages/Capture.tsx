import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  SPACE_ID,
  SPACE_PRESETS,
  errorMessage,
  getState,
  linkWithApi,
  nowIso,
  postFrame,
  postTurn,
  syncSpaceParam,
} from '../api';
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
  micProblem,
  speechProblem,
  startWavRecorder,
  type Recognition,
  type WavRecorder,
} from '../media';
import { speakAside, speakReply, stopSpeaking, unlockSpeech } from '../speech';
import type { SendMode, TurnAudio, User } from '../types';

const FRAME_INTERVAL_MS = 3_000;

type Camera = { kind: 'off' } | { kind: 'starting' } | { kind: 'live' } | { kind: 'problem'; message: string };

type Load = { state: 'loading' } | { state: 'ready' } | { state: 'failed'; message: string };

const CAMERA_LABEL: Record<Camera['kind'], string> = {
  off: 'Camera off',
  starting: 'Camera starting',
  live: 'Camera on',
  problem: 'Camera unavailable',
};

const SEND_MODES: Array<{ value: SendMode; name: string; detail: string }> = [
  { value: 'text', name: 'Text', detail: 'transcript only' },
  { value: 'audio', name: 'Audio', detail: '16 kHz WAV only' },
  { value: 'both', name: 'Both', detail: 'text + WAV' },
];

function validSendMode(raw: string): SendMode {
  return raw === 'audio' || raw === 'both' ? raw : 'text';
}

export function Capture() {
  const [spaceId, setSpaceId] = useState(SPACE_ID);
  const [users, setUsers] = useState<User[]>([]);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [userId, setUserId] = usePersistentState('safespace.captureUser', '');
  const [rawSendMode, setRawSendMode] = usePersistentState('safespace.sendMode', 'text');
  const sendMode = validSendMode(rawSendMode);
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
  const recorderRef = useRef<WavRecorder | null>(null);
  const stopCaptureRef = useRef<(() => void) | null>(null);
  const busyRef = useRef(false);

  const RecognitionClass = useMemo(getRecognition, []);
  const user = users.find((candidate) => candidate.id === userId) ?? users[0] ?? null;
  const frameUserId = user?.id;

  const latest = useRef({ user, muted, spaceId });
  latest.current = { user, muted, spaceId };

  const loadUsers = useCallback(async () => {
    setLoad({ state: 'loading' });
    try {
      const state = await getState(spaceId);
      setUsers(state.users);
      setLoad({ state: 'ready' });
    } catch (err) {
      setLoad({ state: 'failed', message: errorMessage(err) });
    }
  }, [spaceId]);

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
      recorderRef.current?.cancel();
      stopSpeaking();
    };
  }, [startCamera, releaseCamera]);

  const sendTurn = useCallback(async (said: string | null, audio: TurnAudio | null): Promise<boolean> => {
    const speaker = latest.current.user;
    const clean = said?.trim() || null;
    if ((!clean && !audio) || !speaker || busyRef.current) return false;
    busyRef.current = true;
    setPending(true);
    const image = streamRef.current && videoRef.current ? grabFrame(videoRef.current) : null;
    const turn = {
      userName: speaker.name,
      text: clean,
      sentAudio: audio !== null,
      sentImage: image !== null,
    };
    try {
      const response = await postTurn({
        space_id: latest.current.spaceId,
        user_id: speaker.id,
        ts: nowIso(),
        text: clean,
        audio,
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

  const startAudioOnlyTalk = async (fallbackNote?: string) => {
    setHeard('');
    setTalkProblem(fallbackNote ?? null);
    let finished = false;

    const finishRecording = async () => {
      if (finished) return;
      finished = true;
      stopCaptureRef.current = null;
      const rec = recorderRef.current;
      recorderRef.current = null;
      setListening(false);
      if (!rec) return;
      const wav = await rec.stop();
      if (!wav) {
        setTalkProblem('No audio was captured. Press Talk and try again, or type instead.');
        return;
      }
      await sendTurn(null, wav);
    };

    try {
      const rec = await startWavRecorder(() => {
        void finishRecording();
      });
      recorderRef.current = rec;
      stopCaptureRef.current = () => {
        void finishRecording();
      };
      setListening(true);
    } catch (err) {
      setListening(false);
      setTalkProblem(micProblem(err));
    }
  };

  const talk = () => {
    if (listening) {
      stopCaptureRef.current?.();
      return;
    }
    if (!user || pending) return;
    stopSpeaking();
    if (!muted) unlockSpeech();

    // Mode 1: Audio only — never touch SpeechRecognition.
    if (sendMode === 'audio') {
      void startAudioOnlyTalk();
      return;
    }

    // Mode 2: Both, when SpeechRecognition does not exist in this browser -> fall back to Audio.
    if (sendMode === 'both' && !RecognitionClass) {
      void startAudioOnlyTalk('Speech recognition is unavailable here; recording raw audio instead.');
      return;
    }

    // Mode 3: Text (or Both with SpeechRecognition). In Text mode NO audio stream or AudioContext is created.
    if (!RecognitionClass) return;

    const runWithOptionalRecorder = async () => {
      let rec: WavRecorder | null = null;
      let recorderWarning: string | null = null;
      if (sendMode === 'both') {
        try {
          rec = await startWavRecorder(() => {
            recognitionRef.current?.stop();
          });
          recorderRef.current = rec;
        } catch (err) {
          recorderWarning = `${micProblem(err)} Sending text transcript only.`;
        }
      }

      const recognition = new RecognitionClass();
      recognition.lang = 'en-US';
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      let finalText = '';
      let lastHeard = '';
      let settled = false;

      const finishBothOrText = async (said: string) => {
        if (settled) return;
        settled = true;
        stopCaptureRef.current = null;
        recorderRef.current = null;
        const wav = rec ? await rec.stop() : null;
        const clean = said.trim();
        if (!clean && !wav) return;
        await sendTurn(clean || null, wav);
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
        void finishBothOrText(finalText.trim() || lastHeard);
      };

      recognitionRef.current = recognition;
      stopCaptureRef.current = () => {
        recognition.stop();
      };
      setHeard('');
      setTalkProblem(recorderWarning);
      setListening(true);
      try {
        recognition.start();
      } catch (err) {
        recognitionRef.current = null;
        stopCaptureRef.current = null;
        recorderRef.current = null;
        rec?.cancel();
        setListening(false);
        setTalkProblem(`Speech recognition could not start. ${errorMessage(err)}`);
      }
    };

    void runWithOptionalRecorder();
  };

  const submitText = async (event: FormEvent) => {
    event.preventDefault();
    const said = text.trim();
    if (!said || pending) return;
    if (!muted) unlockSpeech();
    setText('');
    // Typed turns always send text only, regardless of the Send setting.
    const sent = await sendTurn(said, null);
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
        const sent = await postFrame({ space_id: spaceId, user_id: frameUserId, ts: nowIso(), image_b64: image, image_url: null });
        // Live guidance: the backend recognised this view from an earlier walk-through.
        if (sent.say && !latest.current.muted) speakAside(sent.say);
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
  }, [autoFrames, camera.kind, frameUserId, spaceId]);

  const cameraBusy = camera.kind === 'live' || camera.kind === 'starting';
  const canTalk = sendMode === 'text' ? Boolean(RecognitionClass) : true;
  const talkLabel = listening
    ? sendMode === 'audio'
      ? 'Recording audio. Tap to stop'
      : 'Listening. Tap to stop'
    : pending
      ? 'Sending…'
      : 'Talk';

  const switchSpace = (nextSpace: string) => {
    syncSpaceParam(nextSpace);
    setSpaceId(nextSpace);
    setResult(null);
  };

  return (
    <div className="capture">
      <header className="capture-top">
        <h1>
          <img className="brand-logo" src="/safespace-logo.svg" alt="SafeSpace" /> <span className="capture-sub">Capture</span>
        </h1>
        <a className="button small quiet link-button" href={linkWithApi('/', spaceId)}>
          Dashboard
        </a>
      </header>

      {SPACE_PRESETS.length > 1 && (
        <nav className="space-tabs" aria-label="Indoor spaces">
          {SPACE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`space-tab${preset.id === spaceId ? ' is-active' : ''}`}
              aria-pressed={preset.id === spaceId}
              onClick={() => switchSpace(preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </nav>
      )}

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

        <fieldset className="acting">
          <legend>Send when talking: {SEND_MODES.find((m) => m.value === sendMode)?.name}</legend>
          <div className="choices">
            {SEND_MODES.map((option) => (
              <label key={option.value} className="choice">
                <input
                  type="radio"
                  name="send-mode"
                  value={option.value}
                  checked={sendMode === option.value}
                  disabled={listening || pending}
                  onChange={() => setRawSendMode(option.value)}
                />
                <span className="choice-face">
                  <span className="choice-name">
                    <span className="choice-mark" aria-hidden="true">
                      ✓
                    </span>
                    {option.name}
                  </span>
                  <span className="choice-role">{option.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <button
          type="button"
          className={`talk-button${listening ? ' listening' : ''}`}
          aria-pressed={listening}
          onClick={talk}
          disabled={!canTalk || !user || (pending && !listening)}
        >
          {talkLabel}
        </button>
        {sendMode === 'text' && !RecognitionClass && (
          <p className="fine-print">
            Speech recognition is not available in this browser. Switch Send to Audio, or type below.
          </p>
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
