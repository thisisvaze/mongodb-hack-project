import type {MiniappSession} from "@mentra/miniapp/background"
import {messageOf, postFrame, timestamp} from "../shared/api"
import {isConfigured, type Settings, type Status} from "../shared/channels"

// The SDK waits 60 s by default. A photo this late is no use to a turn, and it
// would keep the frame loop skipping ticks in the meantime.
const PHOTO_TIMEOUT_MS = 15_000
const FRAME_INTERVAL_MS = 5_000

export interface Camera {
  /** Resolves with a signed photo URL, or null when there is no camera or the capture failed. Never rejects. */
  capture(): Promise<string | null>
  busy(): boolean
}

export function createCamera(session: MiniappSession, push: (patch: Partial<Status>) => void): Camera {
  let inFlight: Promise<string | null> | null = null

  function capture(): Promise<string | null> {
    // One capture at a time: a caller that arrives mid-capture shares its result.
    if (inFlight) return inFlight
    if (!session.capabilities?.hasCamera) return Promise.resolve(null)

    const startedAt = Date.now()
    const shot = session.camera
      .takePhoto({size: "medium", compress: "medium", sound: false, timeoutMs: PHOTO_TIMEOUT_MS})
      .then(
        (photo) => {
          push({photo: {url: photo.photoUrl, tookMs: Date.now() - startedAt}, photoError: null})
          return photo.photoUrl
        },
        (err: unknown) => {
          const code = (err as {code?: string} | null)?.code
          const message = code ? `${code}: ${messageOf(err)}` : messageOf(err)
          console.warn("takePhoto failed:", message)
          push({photoError: message})
          return null
        },
      )
      .then((url) => {
        inFlight = null
        return url
      })
    inFlight = shot
    return shot
  }

  return {capture, busy: () => inFlight !== null}
}

/** While on, posts a photo to POST /api/frames every few seconds. */
export function createFrameLoop(deps: {
  camera: Camera
  settings: () => Settings
  turnBusy: () => boolean
  push: (patch: Partial<Status>) => void
  /** Speaks live guidance returned with a frame. */
  say?: (text: string) => void
}) {
  let timer: ReturnType<typeof setInterval> | null = null
  let posting = false
  let sent = 0
  let error: string | null = null

  const report = () => deps.push({frames: {on: timer !== null, sent, error}})

  async function tick(): Promise<void> {
    const settings = deps.settings()
    if (!isConfigured(settings)) {
      error = "Not configured"
      report()
      return
    }
    if (deps.turnBusy() || deps.camera.busy() || posting) return

    posting = true
    try {
      const url = await deps.camera.capture()
      if (!url) {
        error = "No photo taken"
        return
      }
      const reply = await postFrame(settings.apiBase, {
        space_id: settings.spaceId,
        user_id: settings.user!.id,
        ts: timestamp(),
        image_b64: null,
        image_url: url,
      })
      // Live guidance: never talk over a turn the wearer has started.
      if (reply.say && !deps.turnBusy()) deps.say?.(reply.say)
      sent++
      error = null
    } catch (err) {
      error = messageOf(err)
    } finally {
      posting = false
      report()
    }
  }

  function set(on: boolean): void {
    if (on && timer === null) {
      timer = setInterval(() => void tick(), FRAME_INTERVAL_MS)
    } else if (!on && timer !== null) {
      clearInterval(timer)
      timer = null
    }
    report()
  }

  return {set}
}
