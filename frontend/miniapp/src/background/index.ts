/**
 * Background entry: owns the glasses. Wires the button to the turn state
 * machine, keeps settings in persistent storage, and answers the phone UI.
 *
 * Battery rule: no microphone or transcription subscription is opened at
 * startup. Subscriptions live only inside a turn's listening window.
 */

import {registerMiniapp} from "@mentra/miniapp/background"
import {getState, messageOf, normalizeBase, type SendMode} from "../shared/api"
import {DEFAULT_SETTINGS, isConfigured, type Channels, type Settings, type Status} from "../shared/channels"
import {createCamera, createFrameLoop} from "./camera"
import {createTurns} from "./turn"

const SETTINGS_KEY = "settings"

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
    frames: {on: false, sent: 0, error: null},
  }

  const push = (patch: Partial<Status>) => {
    Object.assign(status, patch)
    session.ui.send("status", status)
  }

  const settings = () => status.settings
  const camera = createCamera(session, push)
  const turns = createTurns(session, {settings, capture: camera.capture, push})
  const frames = createFrameLoop({
    camera,
    settings,
    turnBusy: turns.busy,
    push,
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
      spaceId: next.spaceId.trim() || DEFAULT_SETTINGS.spaceId,
      user: next.user,
      sendMode: validSendMode(next.sendMode),
    }
    await session.storage.set(SETTINGS_KEY, JSON.stringify(saved))
    push({settings: saved})
    return status
  })

  session.ui.handle("testConnection", async ({apiBase, spaceId}) => {
    const state = await getState(normalizeBase(apiBase), spaceId.trim() || DEFAULT_SETTINGS.spaceId)
    return {users: state.users ?? [], memories: state.memories?.length ?? 0}
  })

  session.ui.handle("sendText", ({text}) => {
    const trimmed = text.trim()
    if (!trimmed) return {accepted: false, reason: "Type something first."}
    if (!isConfigured(settings())) return {accepted: false, reason: "Save an API base URL and a user first."}
    if (!turns.sendText(trimmed)) return {accepted: false, reason: "A turn is already in progress."}
    return {accepted: true}
  })

  session.ui.on("setFrames", ({on}) => frames.set(on))
  session.ui.onOpen(() => session.ui.send("status", status))

  // Short and long presses both start a turn; see the README for why.
  session.input.onButtonPress((press) => {
    console.log(`button ${press.buttonId} ${press.pressType}`)
    void loaded.then(turns.press)
  })

  const reportCamera = () => push({hasCamera: session.capabilities ? Boolean(session.capabilities.hasCamera) : null})
  session.on("ready", reportCamera)
  session.onCapabilitiesChange(reportCamera)

  await loaded
})
