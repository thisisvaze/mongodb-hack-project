// Camera frames and speech recognition for the capture page.

const FRAME_WIDTH = 640;
const FRAME_QUALITY = 0.7;
const FRAME_MAX_BYTES = 200_000;

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
  // Base64 is 4 characters per 3 bytes. Busy scenes can exceed the limit at 0.7.
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

export function cameraUnavailableReason(): string | null {
  // The types say mediaDevices always exists. On plain http it is undefined.
  const devices = navigator.mediaDevices as MediaDevices | undefined;
  if (typeof devices?.getUserMedia === 'function') return null;
  return window.isSecureContext
    ? 'This browser does not offer camera access.'
    : 'The camera needs HTTPS. Open this page over https:// (or on localhost).';
}

// The Web Speech API is not in TypeScript's DOM types under one name, so the
// parts used here are described locally.
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
