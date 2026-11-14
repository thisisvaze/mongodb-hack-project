/**
 * The talk flow: button press → open mic/transcription for the chosen SendMode →
 * listening cue → capture utterance (with a photo in parallel) → unsubscribe mic →
 * POST /api/turn → play the reply.
 *
 * Button turns open their subscriptions only for the listening window. In "text"
 * mode `session.mic` is never touched; in "audio" mode `session.transcription`
 * is never touched. `listenAlways` adds one session-long transcription
 * subscription so the wearer can just talk.
 */

import type {AudioChunkData, MiniappSession, TranscriptionData, VadData} from "@mentra/miniapp/background"
import {
  ApiError,
  messageOf,
  postTurn,
  timestamp,
  type SendMode,
  type TurnAudio,
  type TurnResponse,
} from "../shared/api"
import {isConfigured, SPACE_ID, type Phase, type Settings, type Status} from "../shared/channels"
import {HEARD_TONE, LISTENING_TONE} from "./tones"

const SILENCE_MS = 8_000 // give up after this long without hearing anything
const MAX_LISTEN_MS = 25_000 // hard cap on one utterance
const END_SILENCE_MS = 1_250 // VAD silence threshold to end an audio utterance
const TONE_WAIT_MS = 1_200 // longest the listening beep may delay capture
const SPOKEN_CUE_WAIT_MS = 3_000 // same for spoken fallback cue
const PHOTO_WAIT_MS = 2_500 // longest a finished utterance waits for a new photo (frames off)
const MAX_AUDIO_BYTES = 1_200_000 // ~37 s of 16 kHz mono 16-bit PCM
const ECHO_TAIL_MS = 1_500 // always-on: ignore speech this long after the glasses stop talking

const SAY = {
  notSetUp: "Not set up yet. Open SafeSpace on the phone.",
  listening: "Listening.",
  heardNothing: "I didn't hear anything.",
  noAudio: "No microphone audio arrived.",
  tooSlow: "Sorry, that took too long.",
  unreachable: "Sorry, I can't reach the server.",
  failed: "Sorry, something went wrong.",
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "")
  const n = clean.length
  const outLen = Math.floor((n * 3) / 4)
  const out = new Uint8Array(outLen)
  let p = 0
  for (let i = 0; i < n; i += 4) {
    const c0 = B64.indexOf(clean[i] ?? "A")
    const c1 = B64.indexOf(clean[i + 1] ?? "A")
    const c2 = i + 2 < n ? B64.indexOf(clean[i + 2]!) : 0
    const c3 = i + 3 < n ? B64.indexOf(clean[i + 3]!) : 0
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3
    if (p < outLen) out[p++] = (triple >> 16) & 0xff
    if (p < outLen) out[p++] = (triple >> 8) & 0xff
    if (p < outLen) out[p++] = triple & 0xff
  }
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = ""
  const len = bytes.length
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < len ? bytes[i + 1]! : 0
    const b2 = i + 2 < len ? bytes[i + 2]! : 0
    const triple = (b0 << 16) | (b1 << 8) | b2
    out += B64[(triple >> 18) & 0x3f]
    out += B64[(triple >> 12) & 0x3f]
    out += i + 1 < len ? B64[(triple >> 6) & 0x3f] : "="
    out += i + 2 < len ? B64[triple & 0x3f] : "="
  }
  return out
}

function normalizeAudioFormat(raw: string | undefined): string {
  if (!raw || !raw.trim()) return "unknown"
  const lower = raw.trim().toLowerCase()
  if (lower === "pcm" || lower === "pcm16" || lower === "pcm_s16le" || lower === "s16le" || lower === "linear16") {
    return "pcm_s16le"
  }
  return lower
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface CapturedUtterance {
  text: string | null
  audio: TurnAudio | null
  hadSpeech: boolean
}

export function createTurns(
  session: MiniappSession,
  deps: {
    settings: () => Settings
    capture: () => Promise<string | null>
    push: (patch: Partial<Status>) => void
  },
) {
  let phase: Phase = "idle"
  let current = 0
  let cancelListening: (() => void) | null = null
  let toneWorks = true

  function setPhase(next: Phase): void {
    phase = next
    deps.push({phase: next})
  }

  async function say(text: string): Promise<void> {
    try {
      await session.speaker.speak(text)
    } catch (err) {
      console.warn("speak failed:", messageOf(err))
    }
  }

  async function cue(): Promise<void> {
    if (toneWorks) {
      const tone = session.speaker.play({audioUrl: LISTENING_TONE}).then(
        () => true,
        (err: unknown) => {
          console.warn("tone failed, using speech for the cue:", messageOf(err))
          toneWorks = false
          return false
        },
      )
      if (await Promise.race([tone, sleep(TONE_WAIT_MS).then(() => true)])) return
    }
    await Promise.race([say(SAY.listening), sleep(SPOKEN_CUE_WAIT_MS)])
  }

  /**
   * Opens only the subscriptions `mode` requires, plays the cue once they are
   * registered so the mic is warm before the wearer speaks, ignores events
   * during the cue itself, and always unsubscribes on exit.
   */
  async function captureUtterance(mode: SendMode, isCurrent: () => boolean): Promise<CapturedUtterance> {
    const wantText = mode === "text" || mode === "both"
    const wantAudio = mode === "audio" || mode === "both"

    const unsubs: Array<() => void> = []
    const chunks: Uint8Array[] = []
    let byteLength = 0
    let chunkFormat: string | undefined
    let sampleRate: number | undefined

    let accepting = false
    let interim = ""
    let finalText: string | null = null
    let spoke = false

    let silenceTimer: ReturnType<typeof setTimeout> | undefined
    let vadEndTimer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    let resolveWindow: ((out: CapturedUtterance) => void) | null = null
    let settled = false

    const cleanup = () => {
      clearTimeout(silenceTimer)
      clearTimeout(vadEndTimer)
      clearTimeout(hardTimer)
      while (unsubs.length > 0) {
        const off = unsubs.pop()
        try {
          off?.()
        } catch {
          /* ignore */
        }
      }
      if (cancelListening === abortWindow) cancelListening = null
    }

    const buildAudio = (): TurnAudio | null => {
      if (!wantAudio || chunks.length === 0 || byteLength === 0) return null
      const merged = new Uint8Array(byteLength)
      let offset = 0
      for (const c of chunks) {
        merged.set(c, offset)
        offset += c.length
      }
      return {
        format: normalizeAudioFormat(chunkFormat),
        sample_rate: typeof sampleRate === "number" && sampleRate > 0 ? sampleRate : null,
        channels: 1,
        data_b64: bytesToBase64(merged),
      }
    }

    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      const pickedText = wantText ? (finalText ?? (interim.trim() || null)) : null
      const audio = buildAudio()
      resolveWindow?.({
        text: pickedText,
        audio,
        hadSpeech: Boolean(pickedText) || spoke,
      })
    }

    const abortWindow = () => {
      if (settled) return
      settled = true
      cleanup()
      resolveWindow?.({text: null, audio: null, hadSpeech: false})
    }
    cancelListening = abortWindow

    const armSilenceTimer = () => {
      clearTimeout(silenceTimer)
      silenceTimer = setTimeout(finish, SILENCE_MS)
    }

    if (wantText) {
      unsubs.push(
        session.transcription.on((data: TranscriptionData) => {
          if (!accepting || settled) return
          const t = data.text.trim()
          if (!t) return
          spoke = true
          if (data.isFinal) {
            finalText = t
            deps.push({heard: t})
            finish()
          } else {
            interim = t
            deps.push({heard: t})
            armSilenceTimer()
          }
        }),
      )
    }

    if (wantAudio) {
      unsubs.push(
        session.mic.onAudioChunk((chunk: AudioChunkData) => {
          if (!accepting || settled || !chunk.data) return
          if (chunk.format && !chunkFormat) chunkFormat = chunk.format
          if (chunk.sampleRate && !sampleRate) sampleRate = chunk.sampleRate
          if (byteLength >= MAX_AUDIO_BYTES) return
          const bytes = base64ToBytes(chunk.data)
          if (bytes.length === 0) return
          const room = MAX_AUDIO_BYTES - byteLength
          const slice = bytes.length > room ? bytes.subarray(0, room) : bytes
          chunks.push(slice)
          byteLength += slice.length
          if (byteLength >= MAX_AUDIO_BYTES) finish()
        }),
      )

      unsubs.push(
        session.mic.onVoiceActivity((vad: VadData) => {
          if (!accepting || settled) return
          if (vad.status) {
            spoke = true
            clearTimeout(vadEndTimer)
            clearTimeout(silenceTimer)
            if (!wantText) deps.push({heard: "(recording audio…)"})
          } else if (spoke && mode === "audio") {
            clearTimeout(vadEndTimer)
            const alreadySilent = Math.max(0, vad.silentForMs ?? 0)
            const waitMs = Math.max(0, END_SILENCE_MS - alreadySilent)
            vadEndTimer = setTimeout(finish, waitMs)
          }
        }),
      )
    }

    // Play the listening cue ONLY after subscriptions are open so the mic is hot,
    // while `accepting` is still false so the cue itself isn't recorded.
    await cue()
    if (!isCurrent() || settled) {
      cleanup()
      return {text: null, audio: null, hadSpeech: false}
    }

    return new Promise<CapturedUtterance>((resolve) => {
      resolveWindow = resolve
      accepting = true
      armSilenceTimer()
      hardTimer = setTimeout(finish, MAX_LISTEN_MS)
    })
  }

  async function playReply(reply: TurnResponse, isCurrent: () => boolean): Promise<void> {
    if (reply.audio_url) {
      try {
        await session.speaker.play({audioUrl: reply.audio_url})
        return
      } catch (err) {
        if (!isCurrent()) return
        console.warn("reply audio failed, speaking the text:", messageOf(err))
      }
    }
    if (reply.reply_text) await say(reply.reply_text)
  }

  async function run(typed: string | null): Promise<void> {
    const id = ++current
    const isCurrent = () => id === current
    const speakThenIdle = async (speech: () => Promise<void>) => {
      setPhase("speaking")
      await speech()
      if (isCurrent()) setPhase("idle")
    }

    const settings = deps.settings()
    if (!isConfigured(settings)) {
      await speakThenIdle(() => say(SAY.notSetUp))
      return
    }

    deps.push({heard: null, audioSent: null, inputUsed: null, reply: null, error: null})
    const photo = deps.capture()

    let text: string | null = typed
    let audio: TurnAudio | null = null

    if (typed === null) {
      setPhase("listening")
      const mode = settings.sendMode
      const captured = await captureUtterance(mode, isCurrent)
      if (!isCurrent()) return

      text = captured.text
      audio = captured.audio

      if (mode === "text" && !text) {
        await speakThenIdle(() => say(SAY.heardNothing))
        return
      }
      if (mode === "audio") {
        if (!captured.hadSpeech) {
          await speakThenIdle(() => say(SAY.heardNothing))
          return
        }
        if (!audio) {
          await speakThenIdle(() => say(SAY.noAudio))
          return
        }
      }
      if (mode === "both" && !text && !audio) {
        await speakThenIdle(() => say(SAY.heardNothing))
        return
      }

      if (toneWorks) session.speaker.play({audioUrl: HEARD_TONE}).catch(() => {})
    }

    setPhase("sending")
    const audioSummary = audio
      ? {format: audio.format, kb: Math.max(1, Math.round((audio.data_b64.length * 0.75) / 1024))}
      : null
    deps.push({
      heard: text ?? (audioSummary ? `(audio only, ${audioSummary.kb} KB ${audioSummary.format})` : null),
      audioSent: audioSummary,
    })

    const imageUrl = await Promise.race([photo, sleep(PHOTO_WAIT_MS).then(() => null)])

    let reply: TurnResponse
    try {
      reply = await postTurn(settings.apiBase, {
        space_id: SPACE_ID,
        user_id: settings.user!.id,
        ts: timestamp(),
        text,
        audio,
        image_b64: null,
        image_url: imageUrl,
      })
    } catch (err) {
      deps.push({error: messageOf(err)})
      const apiError = err instanceof ApiError ? err : null
      const line = apiError?.timedOut ? SAY.tooSlow : apiError?.status ? SAY.failed : SAY.unreachable
      await speakThenIdle(() => say(line))
      return
    }

    deps.push({
      heard: reply.heard_text ?? text ?? (audioSummary ? `(audio clip, ${audioSummary.kb} KB)` : null),
      inputUsed: reply.input_used ?? null,
      reply: {kind: reply.kind, text: reply.reply_text ?? ""},
    })
    await speakThenIdle(() => playReply(reply, isCurrent))
  }

  /** Stops a reply that is playing; refuses while a turn is listening or sending. */
  function begin(typed: string | null): boolean {
    if (phase === "listening" || phase === "sending") return false
    if (phase === "speaking") session.speaker.stop()
    run(typed).catch((err: unknown) => {
      console.error("turn failed unexpectedly:", messageOf(err))
      cancelListening?.()
      setPhase("idle")
    })
    return true
  }

  /**
   * Always-on listening: every final transcript becomes a turn, no button needed.
   * Skips anything heard while a turn runs or the glasses are talking (their own voice).
   * ponytail: one transcription subscription for the whole session costs battery, and it is
   * text only (the Audio/Both payload applies to button turns). Add an on/off switch if that bites.
   */
  function listenAlways(): void {
    let quietUntil = 0
    session.speaker.onStateChange(() => {
      if (!session.speaker.isPlaying) quietUntil = Date.now() + ECHO_TAIL_MS
    })
    session.transcription.on((data: TranscriptionData) => {
      const t = data.text.trim()
      if (!t || phase !== "idle" || session.speaker.isPlaying || Date.now() < quietUntil) return
      if (!isConfigured(deps.settings())) return
      if (!data.isFinal) {
        deps.push({heard: t})
        return
      }
      console.log(`heard: ${t}`)
      begin(t)
    })
  }

  return {
    listenAlways,
    press: () => void begin(null),
    sendText: (text: string) => begin(text),
    busy: () => phase !== "idle",
  }
}
