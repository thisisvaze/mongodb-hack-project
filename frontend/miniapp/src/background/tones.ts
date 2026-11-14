/**
 * Short beeps, built once as WAV data: URLs so a cue needs no network and
 * cannot be picked up by speech-to-text the way a spoken "listening" would.
 */

const SAMPLE_RATE = 16_000

function tone(hz: number, ms: number): string {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000)
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  // 16-bit mono PCM WAV header.
  ascii(0, "RIFF")
  view.setUint32(4, 36 + samples * 2, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, samples * 2, true)

  const ramp = SAMPLE_RATE / 100 // 10 ms fade in and out, so the beep does not click
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / ramp, (samples - i) / ramp)
    const value = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * 0.5 * fade
    view.setInt16(44 + i * 2, Math.round(value * 32767), true)
  }

  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return `data:audio/wav;base64,${btoa(binary)}`
}

/** "Go ahead, I am listening." */
export const LISTENING_TONE = tone(880, 160)
/** "Got it, working on it." Lower and shorter, so the two are easy to tell apart. */
export const HEARD_TONE = tone(520, 100)
