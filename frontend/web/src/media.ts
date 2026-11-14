// Camera frames, speech recognition, and 16 kHz mono WAV capture for the capture page.

import type { TurnAudio } from './types';

const FRAME_WIDTH = 640;
const FRAME_QUALITY = 0.7;
const FRAME_MAX_BYTES = 200_000;
const TARGET_SAMPLE_RATE = 16_000;
export const MAX_RECORD_MS = 25_000;

/**
 * The video's current frame as a JPEG, base64 without the `data:` prefix.
 * About 640 px wide and under 200 KB, as the contract asks. Null when the video has no picture yet.
 */
export function grabFrame(video: HTMLVideoElement): string | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(1, FRAME_WIDTH / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const encode = (quality: number) => canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? '';
  let quality = FRAME_QUALITY;
  let b64 = encode(quality);
  while (b64.length * 0.75 > FRAME_MAX_BYTES && quality > 0.3) {
    quality -= 0.15;
    b64 = encode(quality);
  }
  return b64 || null;
}

export function cameraProblem(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return "Camera permission was denied. Allow the camera in the browser's site settings, then press Start camera.";
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is in use by another app or could not be started.';
    default:
      return `The camera could not be started${name ? ` (${name})` : ''}.`;
  }
}

export function micProblem(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (!window.isSecureContext) {
    return 'Microphone recording needs HTTPS. Open this page over https:// (or on localhost).';
  }
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone permission was denied. Allow the microphone for this site, or type instead.';
    case 'NotFoundError':
      return 'No microphone was found on this device. Type instead.';
    default:
      return `Microphone recording could not start${name ? ` (${name})` : ''}.`;
  }
}

export function cameraUnavailableReason(): string | null {
  const devices = navigator.mediaDevices as MediaDevices | undefined;
  if (typeof devices?.getUserMedia === 'function') return null;
  return window.isSecureContext
    ? 'This browser does not offer camera access.'
    : 'The camera needs HTTPS. Open this page over https:// (or on localhost).';
}

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly [index: number]: { readonly transcript: string };
}

export interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResult>;
}

export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionConstructor = new () => Recognition;

export function getRecognition(): RecognitionConstructor | null {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** A message for a SpeechRecognition error code, or null when it needs no message. */
export function speechProblem(code: string): string | null {
  switch (code) {
    case 'aborted':
      return null;
    case 'no-speech':
      return 'No speech was heard. Press Talk and try again, or type instead.';
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission was denied. Allow the microphone for this site, or type instead.';
    case 'audio-capture':
      return 'No microphone was found. Type instead.';
    case 'network':
      return 'Speech recognition could not reach its service. Type instead.';
    default:
      return `Speech recognition failed (${code}). Type instead.`;
  }
}

function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[idx] ?? 0;
    const b = samples[Math.min(idx + 1, samples.length - 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function encodeWav16kMonoBase64(samples: Float32Array, sourceRate: number): string {
  const resampled = resampleLinear(samples, sourceRate, TARGET_SAMPLE_RATE);
  const dataBytes = resampled.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < resampled.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, resampled[i] ?? 0));
    const s16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(44 + i * 2, s16, true);
  }

  const bytes = new Uint8Array(buf);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export interface WavRecorder {
  stop(): Promise<TurnAudio | null>;
  cancel(): void;
}

/**
 * Opens the microphone only for the duration of a single utterance, captures mono
 * PCM via Web Audio, resamples to 16 kHz 16-bit WAV on stop, and releases both
 * the MediaStream and AudioContext immediately.
 */
export async function startWavRecorder(onMaxDuration: () => void): Promise<WavRecorder> {
  const devices = navigator.mediaDevices as MediaDevices | undefined;
  if (typeof devices?.getUserMedia !== 'function') {
    throw new Error('Microphone capture unavailable');
  }
  const stream = await devices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  });

  const ContextClass =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!ContextClass) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('Web Audio unavailable');
  }

  const ctx = new ContextClass();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;

  const chunks: Float32Array[] = [];
  let totalSamples = 0;
  let closed = false;

  processor.onaudioprocess = (event) => {
    if (closed) return;
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);
    chunks.push(copy);
    totalSamples += copy.length;
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);
  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => undefined);
  }

  const capTimer = window.setTimeout(() => {
    if (!closed) onMaxDuration();
  }, MAX_RECORD_MS);

  const teardown = async () => {
    if (closed) return;
    closed = true;
    window.clearTimeout(capTimer);
    processor.onaudioprocess = null;
    try {
      source.disconnect();
      processor.disconnect();
      mute.disconnect();
    } catch {
      // Already disconnected.
    }
    stream.getTracks().forEach((track) => track.stop());
    await ctx.close().catch(() => undefined);
  };

  return {
    async stop() {
      const sampleRate = ctx.sampleRate || TARGET_SAMPLE_RATE;
      await teardown();
      if (totalSamples === 0) return null;
      const merged = new Float32Array(totalSamples);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      const data_b64 = encodeWav16kMonoBase64(merged, sampleRate);
      return { format: 'wav', sample_rate: TARGET_SAMPLE_RATE, channels: 1, data_b64 };
    },
    cancel() {
      void teardown();
    },
  };
}
