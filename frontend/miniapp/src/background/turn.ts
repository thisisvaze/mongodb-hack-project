/**
 * The talk flow: button press → cue → listen (with a photo in parallel) →
 * POST /api/turn → play the reply.
 *
 *   idle ──press──► listening ──final text──► sending ──reply──► speaking ──► idle
 *                       │ nothing heard                │ error        │ press
 *                       └──────► speaking ◄────────────┘              └──► listening
 *
 * Presses are ignored while listening or sending.
 */

import type {MiniappSession, TranscriptionData} from "@mentra/miniapp/background"
import {ApiError, messageOf, postTurn, timestamp, type TurnResponse} from "../shared/api"
import {isConfigured, type Phase, type Settings, type Status} from "../shared/channels"
import {HEARD_TONE, LISTENING_TONE} from "./tones"

const SILENCE_MS = 8_000 // give up after this long without hearing anything
const MAX_LISTEN_MS = 25_000 // stop even if speech never settles (a TV, a conversation)
const TONE_WAIT_MS = 1_200 // the longest the listening beep may delay listening
const SPOKEN_CUE_WAIT_MS = 3_000 // the same for the spoken cue used when the beep cannot play
const PHOTO_WAIT_MS = 2_500 // the longest a finished utterance waits for its photo
// Speech already under way when the listening window opens (a reply the press
// just cut off, someone else talking) settles a moment later and would be taken
// for the wearer's words. If an interim result arrived this recently, results
// are skipped for the first STALE_MS of the window.
const RECENT_SPEECH_MS = 1_500
const STALE_MS = 1_200

const SAY = {
  notSetUp: "Not set up yet. Open Home Memory on the phone.",
  listening: "Listening.",
  heardNothing: "I didn't hear anything.",
  tooSlow: "Sorry, that took too long.",
  unreachable: "Sorry, I can't reach the server.",
  failed: "Sorry, something went wrong.",
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createTurns(
  session: MiniappSession,
  deps: {
    settings: () => Settings
    capture: () => Promise<string | null>
    push: (patch: Partial<Status>) => void
  },
) {
  let phase: Phase = "idle"
  // Bumped when a turn starts. A press can only start one from idle or speaking,
  // so an older turn that is still awaiting its speech sees the bump and stops.
  let current = 0
  // The open listening window, if any. Transcripts outside it are dropped.
  let heard: ((data: TranscriptionData) => void) | null = null
  // When the last interim result arrived, in or out of the window; 0 once its utterance settled.
  let lastInterimAt = 0
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

  /**
   * Plays the "listening" cue and resolves when the listening window may open.
   * The window opens after the cue so the cue is never transcribed as the
   * wearer's words; the waits are capped so a stuck cue cannot block the turn.
   */
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

  /** Resolves with the next settled utterance, or null after SILENCE_MS of nothing. */
  function listen(): Promise<string | null> {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const skipUntil = startedAt - lastInterimAt < RECENT_SPEECH_MS ? startedAt + STALE_MS : 0
      let interim = ""
      let timer: ReturnType<typeof setTimeout> | undefined

      const finish = (text: string | null) => {
        clearTimeout(timer)
        heard = null
        resolve(text)
      }
      const armTimer = () => {
        if (timer !== undefined) clearTimeout(timer)
        const untilHardStop = startedAt + MAX_LISTEN_MS - Date.now()
        // If the final result never arrives, the last interim text is better than nothing.
        timer = setTimeout(() => finish(interim || null), Math.max(0, Math.min(SILENCE_MS, untilHardStop)))
      }

      heard = (data) => {
        const text = data.text.trim()
        if (!text || Date.now() < skipUntil) return
        if (data.isFinal) {
          finish(text)
        } else {
          interim = text
          deps.push({heard: text})
          armTimer()
        }
      }
      armTimer()
    })
  }

  async function playReply(reply: TurnResponse, isCurrent: () => boolean): Promise<void> {
    if (reply.audio_url) {
      try {
        await session.speaker.play({audioUrl: reply.audio_url})
        return
      } catch (err) {
        // A press that interrupted playback is not a failure to recover from.
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

    deps.push({heard: null, reply: null, error: null})
    const photo = deps.capture()

    let text = typed
    if (text === null) {
      setPhase("listening")
      await cue()
      text = await listen()
      if (text === null) {
        await speakThenIdle(() => say(SAY.heardNothing))
        return
      }
      if (toneWorks) session.speaker.play({audioUrl: HEARD_TONE}).catch(() => {})
    }

    setPhase("sending")
    deps.push({heard: text})
    const imageUrl = await Promise.race([photo, sleep(PHOTO_WAIT_MS).then(() => null)])

    let reply: TurnResponse
    try {
      reply = await postTurn(settings.apiBase, {
        space_id: settings.spaceId,
        user_id: settings.user!.id,
        ts: timestamp(),
        text,
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

    deps.push({reply: {kind: reply.kind, text: reply.reply_text ?? ""}})
    await speakThenIdle(() => playReply(reply, isCurrent))
  }

  /** Stops a reply that is playing; refuses while a turn is listening or sending. */
  function begin(typed: string | null): boolean {
    if (phase === "listening" || phase === "sending") return false
    if (phase === "speaking") session.speaker.stop()
    run(typed).catch((err: unknown) => {
      // Nothing above should throw, but a turn stuck in "listening" or "sending"
      // would make the button dead, so recover whatever happened.
      console.error("turn failed unexpectedly:", messageOf(err))
      heard = null
      setPhase("idle")
    })
    return true
  }

  return {
    press: () => void begin(null),
    sendText: (text: string) => begin(text),
    /** Feed every transcription event here; only those inside a listening window are used. */
    onTranscript: (data: TranscriptionData) => {
      lastInterimAt = data.isFinal ? 0 : Date.now()
      heard?.(data)
    },
    busy: () => phase !== "idle",
  }
}
