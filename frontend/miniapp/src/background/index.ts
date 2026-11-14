/**
 * Background entry: owns the glasses. Wires the button to the turn state
 * machine, keeps settings in persistent storage, and answers the phone UI.
 *
 * Always listening: one transcription subscription opens at startup, so the
 * wearer just talks. The button still starts a turn too.
 */

import {registerMiniapp} from "@mentra/miniapp/background"
import {getState, messageOf, normalizeBase, postFrame, timestamp, type SendMode} from "../shared/api"
import {DEFAULT_SETTINGS, isConfigured, SPACE_ID, type Channels, type Settings, type Status} from "../shared/channels"
import {createCamera, createFrameLoop} from "./camera"
import {createTurns} from "./turn"

const SETTINGS_KEY = "settings"
const RECENT_PHOTO_MS = 8_000 // covers the 5 s frame interval plus a slow BLE transfer

function validSendMode(value: unknown): SendMode {
  return value === "audio" || value === "both" ? value : "text"
}

registerMiniapp<Channels>(async (session) => {
  const status: Status = {
    settings: DEFAULT_SETTINGS,
    hasCamera: null,
    phase: "idle",
    heard: null,
    audioSent: null,
    inputUsed: null,
    reply: null,
    error: null,
    photo: null,
    photoError: null,
    frames: {mode: null, sent: 0, error: null},
  }

  const push = (patch: Partial<Status>) => {
    Object.assign(status, patch)
    session.ui.send("status", status)
  }

  const settings = () => status.settings
  const camera = createCamera(session, push)
  // A turn reuses the frame loop's latest photo when it is fresh, instead of waiting for a new one.
  // While video streams the camera is taken, so a turn goes without a photo.
  const turnPhoto = () => {
    if (frames.videoOn()) return Promise.resolve(null)
    const url = camera.recent(RECENT_PHOTO_MS)
    return url ? Promise.resolve(url) : camera.capture()
  }
  const turns = createTurns(session, {settings, capture: turnPhoto, push})
  const frames = createFrameLoop({
    camera,
    settings,
    turnBusy: turns.busy,
    push,
    stream: session.stream,
    say: (text) => {
      session.speaker.speak(text).catch((err: unknown) => console.warn("guidance speech failed:", messageOf(err)))
    },
  })

  const loaded = session.storage
    .get(SETTINGS_KEY)
    .then((raw) => {
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<Settings>
      push({
        settings: {
          ...DEFAULT_SETTINGS,
          ...parsed,
          sendMode: validSendMode(parsed.sendMode),
        },
      })
    })
    .catch((err: unknown) => console.warn("could not load settings:", messageOf(err)))

  // Handlers are registered before anything is awaited, so they exist when the UI opens.
  session.ui.handle("getStatus", async () => {
    await loaded
    return status
  })

  session.ui.handle("saveSettings", async (next) => {
    const saved: Settings = {
      apiBase: normalizeBase(next.apiBase),
      user: next.user,
      sendMode: validSendMode(next.sendMode),
    }
    await session.storage.set(SETTINGS_KEY, JSON.stringify(saved))
    push({settings: saved})
    return status
  })

  session.ui.handle("testConnection", async ({apiBase}) => {
    const state = await getState(normalizeBase(apiBase), SPACE_ID)
    return {users: state.users ?? [], memories: state.memories?.length ?? 0}
  })

  session.ui.handle("sendText", ({text}) => {
    const trimmed = text.trim()
    if (!trimmed) return {accepted: false, reason: "Type something first."}
    if (!isConfigured(settings())) return {accepted: false, reason: "Save an API base URL and a user first."}
    if (!turns.sendText(trimmed)) return {accepted: false, reason: "A turn is already in progress."}
    return {accepted: true}
  })

  session.ui.handle("takePhotoNow", async () => {
    const t0 = Date.now()
    const url = await camera.capture()
    if (!url) {
      return {ok: false, error: status.photoError ?? "Glasses did not return a photo."}
    }
    const cur = settings()
    if (isConfigured(cur)) {
      await postFrame(cur.apiBase, {
        space_id: SPACE_ID,
        user_id: cur.user!.id,
        ts: timestamp(),
        image_b64: null,
        image_url: url,
      }).catch((err: unknown) => console.warn("postFrame failed:", messageOf(err)))
    }
    return {ok: true, url, tookMs: Date.now() - t0}
  })

  session.ui.on("setFrames", ({mode}) => frames.set(mode))
  session.ui.onOpen(() => {
    camera.warm()
    session.ui.send("status", status)
  })

  // Short and long presses both start a turn; see the README for why.
  session.input.onButtonPress((press) => {
    console.log(`button ${press.buttonId} ${press.pressType}`)
    void loaded.then(turns.press)
  })

  const reportCamera = () => push({hasCamera: session.capabilities ? Boolean(session.capabilities.hasCamera) : null})
  session.on("ready", reportCamera)
  session.onCapabilitiesChange(reportCamera)

  await loaded
  turns.listenAlways()
})
