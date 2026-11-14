import type {MiniappSession} from "@mentra/miniapp/background"
import {messageOf, postFrame, timestamp} from "../shared/api"
import {isConfigured, SPACE_ID, type FrameMode, type Settings, type Status} from "../shared/channels"

const PHOTO_TIMEOUT_MS = 45_000
const WARM_DURATION_MS = 30_000
const MAX_POSTS_IN_FLIGHT = 2 // frames waiting on the server at once; caps the pile-up when it is slow
// ponytail: the Mac running frontend/scripts/receive-video.sh, which turns this stream into frames
// for the backend. Hardcoded for the hackathon network; make it a setting if the Mac's IP changes.
const VIDEO_URL = "rtmp://192.168.6.193:1935/live/glasses"

export interface Camera {
  /** Resolves with a signed photo URL, or null when capture failed. Never rejects. */
  capture(): Promise<string | null>
  /** Pre-warms the glasses camera sensor so the next capture is much faster. */
  warm(): void
  busy(): boolean
  /** The last photo's URL if it was taken within `maxAgeMs`, else null. */
  recent(maxAgeMs: number): string | null
}

export function createCamera(session: MiniappSession, push: (patch: Partial<Status>) => void): Camera {
  let inFlight: Promise<string | null> | null = null
  let last: {url: string; takenAt: number} | null = null

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
          last = {url: photo.photoUrl, takenAt: startedAt}
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

  const recent = (maxAgeMs: number) => (last && Date.now() - last.takenAt <= maxAgeMs ? last.url : null)

  return {capture, warm, busy: () => inFlight !== null, recent}
}

/**
 * Photo mode posts a photo to POST /api/frames every few seconds (and immediately on turn-on).
 * Video mode streams straight from the glasses to VIDEO_URL over Wi-Fi, skipping BLE and Mentra's cloud.
 */
export function createFrameLoop(deps: {
  camera: Camera
  settings: () => Settings
  turnBusy: () => boolean
  push: (patch: Partial<Status>) => void
  stream: MiniappSession["stream"]
  /** Speaks live guidance returned with a frame. */
  say?: (text: string) => void
}) {
  let timer: ReturnType<typeof setInterval> | null = null
  let mode: FrameMode = null
  let postsInFlight = 0
  let sent = 0
  let error: string | null = null

  const report = () => deps.push({frames: {mode, sent, error}})

  async function tick(): Promise<void> {
    const settings = deps.settings()
    if (!isConfigured(settings)) {
      error = "Save API base URL and user first"
      report()
      return
    }
    if (deps.turnBusy() || deps.camera.busy() || postsInFlight >= MAX_POSTS_IN_FLIGHT) return

    const url = await deps.camera.capture()
    // Keep the sensor hot for the next tick; without this it goes cold 30 s after the loop starts.
    deps.camera.warm()
    if (!url) {
      error = "Glasses did not return a photo (see Status above)"
      report()
      return
    }

    // The server downloads the photo and runs live guidance before it answers, so the next
    // capture starts while this POST is still out.
    // ponytail: two POSTs can finish out of order and briefly show the older frame; fine for 2-5 s frames.
    postsInFlight++
    try {
      const reply = await postFrame(settings.apiBase, {
        space_id: SPACE_ID,
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
      postsInFlight--
      report()
    }
  }

  function set(next: FrameMode): void {
    if (timer !== null) clearInterval(timer)
    timer = null
    const wasVideo = mode === "video"
    if (wasVideo && next !== "video") {
      deps.stream.stop().catch((err: unknown) => console.warn("stopping video failed:", messageOf(err)))
    }
    mode = next
    error = null
    if (typeof next === "number") {
      deps.camera.warm()
      void tick()
      timer = setInterval(() => void tick(), next)
    } else if (next === "video" && !wasVideo) {
      deps.stream.startStream({direct: VIDEO_URL, video: {width: 1280, height: 720, fps: 15}, sound: false}).then(
        (res) => console.log(`video streaming to ${VIDEO_URL}: ${res.status}`),
        (err: unknown) => {
          if (mode !== "video") return
          error = `Video failed: ${messageOf(err)}`
          mode = null
          report()
        },
      )
    }
    report()
  }

  return {set, sendOne: tick, videoOn: () => mode === "video"}
}
