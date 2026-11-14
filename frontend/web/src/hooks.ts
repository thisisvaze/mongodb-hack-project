import { useCallback, useEffect, useReducer, useState } from 'react';
import { errorMessage, getState, openEvents, type StreamStatus } from './api';
import { stopSpeaking } from './speech';
import type { AuditEntry, FrameEvent, LiveTurn, Memory, Rules, SpaceState, User } from './types';

/** A string kept in localStorage. Falls back to plain state when storage is blocked. */
export function usePersistentState(key: string, initial: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: string) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // Not saved. The value still holds for this page load.
      }
    },
    [key],
  );
  return [value, set];
}

export function useMute(): [boolean, (muted: boolean) => void] {
  const [stored, setStored] = usePersistentState('safespace.muted', 'no');
  const setMuted = useCallback(
    (muted: boolean) => {
      if (muted) stopSpeaking();
      setStored(muted ? 'yes' : 'no');
    },
    [setStored],
  );
  return [stored === 'yes', setMuted];
}

export interface SpaceData {
  loaded: boolean;
  users: User[];
  rules: Rules | null;
  memories: Memory[];
  audit: AuditEntry[];
  /** Latest frame per user id, plus the single most recent frame across the space. */
  frames: Record<string, FrameEvent>;
  latestFrame: FrameEvent | null;
  latestTurn: LiveTurn | null;
}

type Action =
  | { type: 'reset' }
  | { type: 'snapshot'; snapshot: SpaceState }
  | { type: 'memory'; memory: Memory }
  | { type: 'audit'; entry: AuditEntry }
  | { type: 'rules'; rules: Rules }
  | { type: 'frame'; frame: FrameEvent }
  | { type: 'turn'; turn: LiveTurn };

const AUDIT_LIMIT = 200;
const HIGHLIGHT_MS = 1_500;

const time = (iso: string) => Date.parse(iso) || 0;
const newestMemories = (list: Memory[]) => [...list].sort((a, b) => time(b.created_at) - time(a.created_at));
const newestAudit = (list: AuditEntry[]) => [...list].sort((a, b) => time(b.ts) - time(a.ts)).slice(0, AUDIT_LIMIT);

function pickLatestFrame(frames: Record<string, FrameEvent>): FrameEvent | null {
  let best: FrameEvent | null = null;
  for (const frame of Object.values(frames)) {
    if (!best || time(frame.ts) >= time(best.ts)) best = frame;
  }
  return best;
}

function reduce(data: SpaceData, action: Action): SpaceData {
  switch (action.type) {
    case 'reset':
      return EMPTY;
    case 'snapshot': {
      const nextFrames = { ...data.frames };
      for (const frame of action.snapshot.frames ?? []) {
        nextFrames[frame.user_id] = frame;
      }
      return {
        ...data,
        loaded: true,
        users: action.snapshot.users,
        rules: action.snapshot.rules,
        memories: newestMemories(action.snapshot.memories),
        audit: newestAudit(action.snapshot.audit),
        frames: nextFrames,
        latestFrame: pickLatestFrame(nextFrames),
        latestTurn: action.snapshot.latest_turn ?? data.latestTurn,
      };
    }
    case 'memory': {
      const known = data.memories.some((m) => m.id === action.memory.id);
      const next = known
        ? data.memories.map((m) => (m.id === action.memory.id ? action.memory : m))
        : [action.memory, ...data.memories];
      return { ...data, memories: newestMemories(next) };
    }
    case 'audit':
      if (data.audit.some((entry) => entry.id === action.entry.id)) return data;
      return { ...data, audit: newestAudit([action.entry, ...data.audit]) };
    case 'rules':
      return { ...data, rules: action.rules };
    case 'frame': {
      const frames = { ...data.frames, [action.frame.user_id]: action.frame };
      return { ...data, frames, latestFrame: action.frame };
    }
    case 'turn': {
      const frames = action.turn.image_url
        ? { ...data.frames, [action.turn.user_id]: { user_id: action.turn.user_id, ts: action.turn.ts, image_url: action.turn.image_url } }
        : data.frames;
      const latestFrame = action.turn.image_url
        ? { user_id: action.turn.user_id, ts: action.turn.ts, image_url: action.turn.image_url }
        : data.latestFrame;
      return { ...data, frames, latestFrame, latestTurn: action.turn };
    }
  }
}

const EMPTY: SpaceData = {
  loaded: false,
  users: [],
  rules: null,
  memories: [],
  audit: [],
  frames: {},
  latestFrame: null,
  latestTurn: null,
};

export interface Space {
  data: SpaceData;
  status: StreamStatus;
  loadError: string | null;
  fresh: ReadonlySet<string>;
  reload(): void;
  applyRules(rules: Rules): void;
  recordLocalTurn(turn: LiveTurn): void;
}

/** Snapshot from GET /api/state, kept live by GET /api/events. */
export function useSpace(spaceId: string): Space {
  const [data, dispatch] = useReducer(reduce, EMPTY);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let latestLoad = 0;
    let replay: Action[] | null = null;
    const timers = new Set<number>();

    const load = async () => {
      const mine = ++latestLoad;
      replay ??= [];
      try {
        const snapshot = await getState(spaceId);
        if (cancelled || mine !== latestLoad) return;
        dispatch({ type: 'snapshot', snapshot });
        for (const action of replay ?? []) dispatch(action);
        setLoadError(null);
      } catch (err) {
        if (cancelled || mine !== latestLoad) return;
        setLoadError(errorMessage(err));
      } finally {
        if (mine === latestLoad) replay = null;
      }
    };

    const live = (action: Action, freshId?: string) => {
      replay?.push(action);
      dispatch(action);
      if (!freshId) return;
      setFresh((ids) => new Set(ids).add(freshId));
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        setFresh((ids) => {
          const next = new Set(ids);
          next.delete(freshId);
          return next;
        });
      }, HIGHLIGHT_MS);
      timers.add(timer);
    };

    dispatch({ type: 'reset' });
    setLoadError(null);
    void load();
    const close = openEvents(spaceId, {
      onStatus: setStatus,
      onOpen: load,
      onMemory: ({ memory }) => live({ type: 'memory', memory }, memory.id),
      onAudit: ({ entry }) => live({ type: 'audit', entry }, entry.id),
      onRules: ({ rules }) => live({ type: 'rules', rules }),
      onFrame: (frame) => live({ type: 'frame', frame }),
      onTurn: (turn) => live({ type: 'turn', turn }),
    });

    return () => {
      cancelled = true;
      close();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [spaceId, reloadCount]);

  const reload = useCallback(() => setReloadCount((n) => n + 1), []);
  const applyRules = useCallback((rules: Rules) => dispatch({ type: 'rules', rules }), []);
  const recordLocalTurn = useCallback((turn: LiveTurn) => dispatch({ type: 'turn', turn }), []);

  return { data, status, loadError, fresh, reload, applyRules, recordLocalTurn };
}
