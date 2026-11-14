import type { AuditAction, AuditVerdict, MemorySource, MemoryStatus, TurnKind } from './types';

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Time of day for today, date and time otherwise. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? timeFormat.format(date) : dateTimeFormat.format(date);
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date);
}

export const KIND_LABEL: Record<TurnKind, string> = {
  saved: 'Saved',
  answer: 'Answer',
  denied: 'Denied',
  forgot: 'Forgot',
  ignored: 'Ignored',
};

export const STATUS_LABEL: Record<MemoryStatus, string> = {
  active: 'Active',
  superseded: 'Superseded',
  forgotten: 'Forgotten',
  expired: 'Expired',
};

export const SOURCE_LABEL: Record<MemorySource, string> = {
  camera: 'Glasses cam',
  voice: 'Voice note',
  both: 'Cam + voice',
};

export const ACTION_LABEL: Record<AuditAction, string> = {
  memory_stored: 'Saved',
  memory_superseded: 'Updated',
  memory_forgotten: 'Wiped',
  memory_expired: 'Expired',
  query_answered: 'Answered',
  query_denied: 'Blocked',
  rule_changed: 'Rule updated',
};

export const VERDICT_LABEL: Record<AuditVerdict, string> = {
  allowed: 'Allowed',
  denied: 'Denied',
  info: 'Info',
};

/** Label for a value the contract may grow later: falls back to the raw value. */
export function labelOf<K extends string>(labels: Record<K, string>, value: string): string {
  return (labels as Record<string, string>)[value] ?? value;
}
