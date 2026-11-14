// Speaking replies: the backend's MP3 when there is one, otherwise the browser's own voice.

let currentAudio: HTMLAudioElement | null = null;

const synth = (): SpeechSynthesis | null => ('speechSynthesis' in window ? window.speechSynthesis : null);

export function stopSpeaking(): void {
  currentAudio?.pause();
  currentAudio = null;
  const speech = synth();
  if (speech && (speech.speaking || speech.pending)) speech.cancel();
}

function speakWithBrowser(text: string): void {
  const speech = synth();
  if (!speech || !text.trim()) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  speech.speak(utterance);
}

export function speakReply(text: string, audioUrl: string | null): void {
  stopSpeaking();
  if (!audioUrl) {
    speakWithBrowser(text);
    return;
  }
  const audio = new Audio(audioUrl);
  currentAudio = audio;
  // A failed download and a blocked play() can both fire. Fall back only once.
  const fallBack = () => {
    if (currentAudio !== audio) return;
    currentAudio = null;
    speakWithBrowser(text);
  };
  audio.addEventListener('error', fallBack, { once: true });
  audio.play().catch(fallBack);
}

/** Speaks a short aside, such as live guidance, unless something is already being said. */
export function speakAside(text: string): void {
  const speech = synth();
  if (!speech || !text.trim() || currentAudio || speech.speaking || speech.pending) return;
  speakWithBrowser(text);
}

/**
 * Mobile Safari only lets speech start from a tap. Speaking an empty utterance
 * inside the tap lets the real reply be spoken after the network call returns.
 */
export function unlockSpeech(): void {
  const speech = synth();
  if (!speech || speech.speaking || speech.pending) return;
  speech.speak(new SpeechSynthesisUtterance(''));
}
