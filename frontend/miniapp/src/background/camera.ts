import type {MiniappSession} from "@mentra/miniapp/background"
import {messageOf, postFrame, timestamp} from "../shared/api"
import {isConfigured, type Settings, type Status} from "../shared/channels"

const PHOTO_TIMEOUT_MS = 45_000
const WARM_DURATION_MS = 30_000

export interface Camera {
  /** Resolves with a signed photo URL, or null when capture failed. Never rejects. */
  capture(): Promise<string | null>
  /** Pre-warms the glasses camera sensor so the next capture is much faster. */
  warm(): void
  busy(): boolean
}

export function createCamera(session: MiniappSession, push: (patch: Partial<Status>) => void): Camera {
  let inFlight: Promise<string | null> | null = null

  function warm(): void {
    if (inFlight || session.capabilities?.hasCamera === false) return
    session.camera.warmUp({size: "low", durationMs: WARM_DURATION_MS}).catch(() => {})
  }

  function capture(): Promise<string | null> {
    if (inFlight) return inFlight
    if (session.capabilities?.hasCamera === false) {
      push({photoError: "Connected glasses report hasCamera=false."})
      return Promise.resolve(null)
    }

    const startedAt = Date.now()
    const shot = session.camera
      // ponytail: "auto" tries the glasses' own Wi-Fi upload first and hung past the timeout on our network.
      // BLE relays the small "low" photo through the phone; try "auto" again on a network with open internet.
      .takePhoto({size: "low", compress: "high", sound: false, transferMethod: "ble", timeoutMs: PHOTO_TIMEOUT_MS})
      .then(
        (photo) => {
          const tookMs = Date.now() - startedAt
          console.log(`photo ok in ${tookMs}ms: ${photo.photoUrl.slice(0, 60)}...`)
          push({photo: {url: photo.photoUrl, tookMs}, photoError: null})
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

  return {capture, warm, busy: () => inFlight !== null}
}

/** While on, posts a photo to POST /api/frames every few seconds (and immediately on turn-on). */
export function createFrameLoop(deps: {
  camera: Camera
  settings: () => Settings
  turnBusy: () => boolean
  push: (patch: Partial<Status>) => void
  /** Speaks live guidance returned with a frame. */
  say?: (text: string) => void
}) {
  let timer: ReturnType<typeof setInterval> | null = null
  let everyMs: number | null = null
  let posting = false
  let sent = 0
  let error: string | null = null

  const report = () => deps.push({frames: {everyMs, sent, error}})

  async function tick(): Promise<void> {
    const settings = deps.settings()
    if (!isConfigured(settings)) {
      error = "Save API base URL and user first"
      report()
      return
    }
    if (deps.turnBusy() || deps.camera.busy() || posting) return

    posting = true
    try {
      const url = await deps.camera.capture()
      if (!url) {
        error = "Glasses did not return a photo (see Status above)"
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

  /** null turns the loop off; a number (re)starts it at that interval. */
  function set(next: number | null): void {
    if (timer !== null) clearInterval(timer)
    timer = null
    everyMs = next
    if (next !== null) {
      deps.camera.warm()
      void tick()
      timer = setInterval(() => void tick(), next)
    }
    report()
  }

  return {set, sendOne: tick}
}
