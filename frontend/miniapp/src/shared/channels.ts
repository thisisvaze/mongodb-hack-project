/**
 * Typed channel registry: the messages that flow between the background layer
 * and the UI WebView. Both layers import this file.
 */

import type {Rpc} from "@mentra/miniapp/ui"
import type {InputUsed, SendMode, TurnKind, User} from "./api"

export interface Settings {
  /** Backend base URL without a trailing slash. Empty until someone sets it. */
  apiBase: string
  /** Who is wearing the glasses, picked from the users in GET /api/state. */
  user: User | null
  /** What each spoken turn sends to POST /api/turn. Default "text" saves battery. */
  sendMode: SendMode
}

/** The one space the glasses use. db/setup.js seeds it on the real backend. */
export const SPACE_ID = "hotel"

export const DEFAULT_SETTINGS: Settings = {apiBase: "", user: null, sendMode: "text"}

export function isConfigured(settings: Settings): boolean {
  return settings.apiBase !== "" && settings.user !== null
}

export type Phase = "idle" | "listening" | "sending" | "speaking"

export interface Status {
  settings: Settings
  /** Whether the connected glasses report a camera. Null until the glasses profile arrives. */
  hasCamera: boolean | null
  phase: Phase
  /** The words heard or typed for the latest turn. Updates live while listening. */
  heard: string | null
  /** Audio clip summary from the latest turn, when audio was sent. */
  audioSent: {format: string; kb: number} | null
  /** Which input ("text" or "audio") the backend reported using on the latest reply. */
  inputUsed: InputUsed
  reply: {kind: TurnKind; text: string} | null
  /** Why the latest turn failed, if it did. */
  error: string | null
  photo: {url: string; tookMs: number} | null
  /** Why the latest photo failed, if it did. */
  photoError: string | null
  /** everyMs is the frame-loop interval, or null when the loop is off. */
  frames: {everyMs: number | null; sent: number; error: string | null}
}

export interface Channels {
  // background → UI
  status: Status

  // UI → background
  getStatus: Rpc<null, Status>
  saveSettings: Rpc<Settings, Status>
  /** Calls GET /api/state with values that may not be saved yet. Rejects with the error. */
  testConnection: Rpc<{apiBase: string}, {users: User[]; memories: number}>
  /** Starts a typed turn. Progress arrives on `status`. */
  sendText: Rpc<{text: string}, {accepted: boolean; reason?: string}>
  /** Takes one photo immediately on the glasses and posts it to /api/frames if configured. */
  takePhotoNow: Rpc<null, {ok: boolean; url?: string; tookMs?: number; error?: string}>
  setFrames: {everyMs: number | null}
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
