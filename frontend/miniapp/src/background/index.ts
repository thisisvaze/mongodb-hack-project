/**
 * Background entry: owns the glasses. Wires the button and the microphone to
 * the turn state machine, keeps the settings, and answers the phone UI.
 */

import {registerMiniapp} from "@mentra/miniapp/background"
import {getState, messageOf, normalizeBase} from "../shared/api"
import {DEFAULT_SETTINGS, isConfigured, type Channels, type Settings, type Status} from "../shared/channels"
import {createCamera, createFrameLoop} from "./camera"
import {createTurns} from "./turn"

const SETTINGS_KEY = "settings"

registerMiniapp<Channels>(async (session) => {
  const status: Status = {
    settings: DEFAULT_SETTINGS,
    hasCamera: null,
    phase: "idle",
    heard: null,
    reply: null,
    error: null,
    photo: null,
    photoError: null,
    frames: {on: false, sent: 0, error: null},
  }

  // session.ui.send drops the message when the phone UI is closed, which is fine:
  // the UI asks for the whole status when it opens.
  const push = (patch: Partial<Status>) => {
    Object.assign(status, patch)
    session.ui.send("status", status)
  }

  const settings = () => status.settings
  const camera = createCamera(session, push)
  const turns = createTurns(session, {settings, capture: camera.capture, push})
  const frames = createFrameLoop({camera, settings, turnBusy: turns.busy, push})

  const loaded = session.storage
    .get(SETTINGS_KEY)
    .then((raw) => {
      if (raw) push({settings: {...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>)}})
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

  // Subscribed once and left open: the microphone and recognizer are already
  // running when the button is pressed, so no first words are lost while they
  // start. The turn machine drops everything outside its listening window.
  session.transcription.on(turns.onTranscript)

  const reportCamera = () => push({hasCamera: session.capabilities ? Boolean(session.capabilities.hasCamera) : null})
  session.on("ready", reportCamera)
  session.onCapabilitiesChange(reportCamera)

  await loaded
})
