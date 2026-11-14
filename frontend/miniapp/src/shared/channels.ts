/**
 * Typed channel registry: the messages that flow between the background layer
 * and the UI WebView. Both layers import this file.
 */

import type {Rpc} from "@mentra/miniapp/ui"
import type {TurnKind, User} from "./api"

export interface Settings {
  /** Backend base URL without a trailing slash. Empty until someone sets it. */
  apiBase: string
  spaceId: string
  /** Who is wearing the glasses, picked from the users in GET /api/state. */
  user: User | null
}

export const DEFAULT_SETTINGS: Settings = {apiBase: "", spaceId: "home", user: null}

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
  reply: {kind: TurnKind; text: string} | null
  /** Why the latest turn failed, if it did. */
  error: string | null
  photo: {url: string; tookMs: number} | null
  /** Why the latest photo failed, if it did. */
  photoError: string | null
  frames: {on: boolean; sent: number; error: string | null}
}

export interface Channels {
  // background → UI
  status: Status

  // UI → background
  getStatus: Rpc<null, Status>
  saveSettings: Rpc<Settings, Status>
  /** Calls GET /api/state with values that may not be saved yet. Rejects with the error. */
  testConnection: Rpc<{apiBase: string; spaceId: string}, {users: User[]; memories: number}>
  /** Starts a typed turn. Progress arrives on `status`. */
  sendText: Rpc<{text: string}, {accepted: boolean; reason?: string}>
  setFrames: {on: boolean}
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
