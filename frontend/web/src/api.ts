// Every call to the backend lives here. See docs/api-contract.md.

import type {
  AuditEvent,
  FrameEvent,
  FrameRequest,
  MemoryEvent,
  Rules,
  RulesEvent,
  RulesResponse,
  SpaceState,
  TurnRequest,
  TurnResponse,
} from './types';

const STORAGE_KEY = 'safespace.apiBase';
const FALLBACK_API_BASE = 'http://localhost:8787';
const TURN_TIMEOUT_MS = 15_000;
const RETRY_MS = 3_000;

function cleanBase(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '');
  return trimmed || null;
}

function readSavedBase(): string | null {
  try {
    return cleanBase(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveBase(value: string | null): void {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked (private mode). The ?api= parameter still works.
  }
}

export const DEFAULT_API_BASE = cleanBase(import.meta.env.VITE_API_BASE) ?? FALLBACK_API_BASE;

// Order: ?api= (saved when present), then the saved value, then VITE_API_BASE, then localhost.
function resolveApiBase(): string {
  const params = new URLSearchParams(window.location.search);
  if (params.has('api')) {
    const fromQuery = cleanBase(params.get('api'));
    saveBase(fromQuery);
    if (fromQuery) return fromQuery;
  }
  return readSavedBase() ?? DEFAULT_API_BASE;
}

export const API_BASE = resolveApiBase();

export interface SpacePreset {
  id: string;
  label: string;
  context: string;
  prompts: Record<string, string[]>;
}

export const SPACE_PRESETS: SpacePreset[] = [
  {
    id: 'hotel',
    label: 'Hotel Room 412',
    context: 'Temporary stay · private items wipe at checkout',
    prompts: {
      guest: [
        'My passport is in the room safe on the closet shelf',
        'Where is the shampoo bottle?',
        'Check out of the room',
      ],
      staff: [
        'Fresh towels are on the lower bathroom rack',
        'Where did the guest put their passport?',
      ],
      next_guest: [
        'Where is the thermostat and wall outlet?',
        'Where is the previous guest passport?',
      ],
    },
  },
  {
    id: 'home',
    label: 'Shared Home',
    context: 'Household · shared layout & care, personal items locked',
    prompts: {
      resident: [
        "I'm putting my keys in my left jacket pocket",
        'Where are my evening pills?',
        'Forget my house keys',
      ],
      caregiver: [
        'Evening pills are in the pill organizer left of the kettle',
        'Where are the house keys?',
      ],
      visitor: [
        'Where is the bathroom?',
        'Where are the evening pills?',
      ],
    },
  },
  {
    id: 'office',
    label: 'Office Floor 3',
    context: 'Workplace · shared tactile landmarks, personal gear locked',
    prompts: {
      member: [
        'My spare cane is hooked under the right side of my desk',
        'Where is the elevator from suite 300?',
      ],
      coworker: [
        'Taped cable ramp across the center aisle near printer',
        'Where is the coffee mug shelf?',
      ],
      visitor: [
        'Where is the accessible restroom?',
        'Where is the spare cane?',
      ],
    },
  },
];

export const DEFAULT_SPACE_ID = 'hotel';

export function readInitialSpace(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('space')?.trim();
  if (fromUrl) return fromUrl;
  try {
    const saved = localStorage.getItem('safespace.spaceId')?.trim();
    if (saved) return saved;
  } catch {
    // Ignore blocked storage.
  }
  return DEFAULT_SPACE_ID;
}

export function syncSpaceParam(spaceId: string): void {
  try {
    localStorage.setItem('safespace.spaceId', spaceId);
  } catch {
    // Ignore blocked storage.
  }
  const url = new URL(window.location.href);
  if (spaceId === DEFAULT_SPACE_ID) url.searchParams.delete('space');
  else url.searchParams.set('space', spaceId);
  window.history.replaceState(null, '', url.toString());
}

export const SPACE_ID = readInitialSpace();

/** Saves a new base URL (null goes back to the default) and reloads the page. */
export function changeApiBase(next: string | null): void {
  saveBase(cleanBase(next));
  const url = new URL(window.location.href);
  url.searchParams.delete('api');
  window.location.replace(url.toString());
}

/** A link to another route that carries the current base URL and space, for opening on a phone. */
export function linkWithApi(path: string, spaceId = SPACE_ID): string {
  const params = new URLSearchParams();
  if (API_BASE !== DEFAULT_API_BASE) params.set('api', API_BASE);
  if (spaceId && spaceId !== DEFAULT_SPACE_ID) params.set('space', spaceId);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = TURN_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, { ...init, signal: controller.signal });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body ? String(body.error) : `Backend answered HTTP ${res.status}.`;
      throw new ApiError(message, res.status);
    }
    return body as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (controller.signal.aborted) {
      throw new ApiError(`The backend did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, 0);
    }
    throw new ApiError(`Cannot reach the backend at ${API_BASE}.`, 0);
  } finally {
    window.clearTimeout(timer);
  }
}

function sendJson<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const spaceQuery = (spaceId: string) => `space_id=${encodeURIComponent(spaceId)}`;

/** Timestamp in the contract's format: ISO 8601 UTC, whole seconds. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function getState(spaceId: string): Promise<SpaceState> {
  return request<SpaceState>(`/api/state?${spaceQuery(spaceId)}`);
}

export function postTurn(turn: TurnRequest): Promise<TurnResponse> {
  return sendJson<TurnResponse>('POST', '/api/turn', turn);
}

/** `say` is live guidance about this view: something already remembered here, or null. */
export function postFrame(frame: FrameRequest): Promise<{ ok: boolean; say?: string | null }> {
  return sendJson<{ ok: boolean; say?: string | null }>('POST', '/api/frames', frame);
}

export function putRules(spaceId: string, rules: Rules): Promise<RulesResponse> {
  return sendJson<RulesResponse>('PUT', `/api/rules?${spaceQuery(spaceId)}`, rules);
}

export type StreamStatus = 'connecting' | 'live' | 'retrying';

export interface StreamHandlers {
  onStatus(status: StreamStatus): void;
  /** Fires on every successful connect, including reconnects. */
  onOpen(): void;
  onMemory(event: MemoryEvent): void;
  onAudit(event: AuditEvent): void;
  onRules(event: RulesEvent): void;
  onFrame(event: FrameEvent): void;
}

/** Opens the server-sent event stream. Returns a function that closes it. */
export function openEvents(spaceId: string, handlers: StreamHandlers): () => void {
  const url = `${API_BASE}/api/events?${spaceQuery(spaceId)}`;
  let source: EventSource | null = null;
  let retryTimer: number | undefined;
  let closed = false;

  const listen = <T>(name: string, handle: (data: T) => void) => {
    source?.addEventListener(name, (event) => {
      try {
        handle(JSON.parse((event as MessageEvent<string>).data) as T);
      } catch (err) {
        console.warn(`Ignored a malformed "${name}" event`, err);
      }
    });
  };

  const connect = () => {
    source = new EventSource(url);
    source.onopen = () => {
      handlers.onStatus('live');
      handlers.onOpen();
    };
    source.onerror = () => {
      if (closed) return;
      handlers.onStatus('retrying');
      // The browser retries by itself unless the server refused the stream outright.
      if (source?.readyState === EventSource.CLOSED) {
        source.close();
        retryTimer = window.setTimeout(connect, RETRY_MS);
      }
    };
    listen<MemoryEvent>('memory', handlers.onMemory);
    listen<AuditEvent>('audit', handlers.onAudit);
    listen<RulesEvent>('rules', handlers.onRules);
    listen<FrameEvent>('frame', handlers.onFrame);
  };

  handlers.onStatus('connecting');
  connect();

  return () => {
    closed = true;
    window.clearTimeout(retryTimer);
    source?.close();
  };
}
