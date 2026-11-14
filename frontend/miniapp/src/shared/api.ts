/**
 * Backend calls and contract types. Source of truth: docs/api-contract.md.
 *
 * Imported by the background layer, so it must stay inside the background
 * runtime: plain fetch with string bodies, no URL/Headers/AbortController.
 * The background fetch ignores `signal`, so timeouts race a timer instead.
 */

export interface User {
  id: string
  name: string
  role: string
}

export interface StateResponse {
  space_id: string
  users: User[]
  rules: unknown
  memories: unknown[]
  audit: unknown[]
}

export type TurnKind = "saved" | "answer" | "denied" | "forgot" | "ignored"
export type SendMode = "text" | "audio" | "both"
export type InputUsed = "text" | "audio" | null

export interface TurnAudio {
  format: string
  sample_rate: number | null
  channels: number
  data_b64: string
}

export interface TurnRequest {
  space_id: string
  user_id: string
  ts: string
  text: string | null
  audio: TurnAudio | null
  image_b64: string | null
  image_url: string | null
}

export interface TurnResponse {
  kind: TurnKind
  reply_text: string
  audio_url: string | null
  memory_ids: string[]
  heard_text?: string | null
  input_used?: InputUsed
}

export interface FrameRequest {
  space_id: string
  user_id: string
  ts: string
  image_b64: string | null
  image_url: string | null
}

export const STATE_TIMEOUT_MS = 10_000
export const TURN_TIMEOUT_MS = 15_000
export const FRAME_TIMEOUT_MS = 10_000

export class ApiError extends Error {
  /** HTTP status when the server answered; undefined for network failures and timeouts. */
  status?: number
  timedOut = false

  constructor(message: string, status?: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === "object" && typeof (err as {message?: unknown}).message === "string") {
    return (err as {message: string}).message
  }
  return String(err)
}

/** "example.com/" becomes "https://example.com"; an empty string stays empty. */
export function normalizeBase(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** ISO 8601 UTC without milliseconds, as in the contract examples. */
export function timestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z")
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new ApiError(`No answer after ${Math.round(ms / 1000)} seconds`)
      err.timedOut = true
      reject(err)
    }, ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

async function call<T>(base: string, method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<T> {
  if (!base) throw new ApiError("The API base URL is not set")

  const request = async (): Promise<T> => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : {"Content-Type": "application/json"},
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((err: unknown) => {
      throw new ApiError(`Cannot reach ${base}: ${messageOf(err)}`)
    })

    const text = await res.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = undefined
    }

    if (!res.ok) {
      const detail = (data as {error?: unknown} | undefined)?.error
      throw new ApiError(typeof detail === "string" ? detail : `HTTP ${res.status}`, res.status)
    }
    if (data === undefined || data === null) {
      throw new ApiError(`${method} ${path} did not return JSON`, res.status)
    }
    return data as T
  }

  return withTimeout(request(), timeoutMs)
}

export function getState(base: string, spaceId: string): Promise<StateResponse> {
  return call(base, "GET", `/api/state?space_id=${encodeURIComponent(spaceId)}`, undefined, STATE_TIMEOUT_MS)
}

export function postTurn(base: string, turn: TurnRequest): Promise<TurnResponse> {
  return call(base, "POST", "/api/turn", turn, TURN_TIMEOUT_MS)
}

export function postFrame(base: string, frame: FrameRequest): Promise<{ok: boolean}> {
  return call(base, "POST", "/api/frames", frame, FRAME_TIMEOUT_MS)
}
