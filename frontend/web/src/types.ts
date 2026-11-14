// Shapes from docs/api-contract.md. Keep this file in step with the contract.

export interface User {
  id: string;
  name: string;
  role: string;
}

export interface RoleRule {
  can_see: string[];
}

export interface TopicRule {
  group: string;
  keep_for: string | null;
}

export interface Rules {
  roles: Record<string, RoleRule>;
  topics: Record<string, TopicRule>;
  default_group: string;
}

export type MemorySource = 'camera' | 'voice' | 'both';
export type MemoryStatus = 'active' | 'superseded' | 'forgotten' | 'expired';

export interface Memory {
  id: string;
  space_id: string;
  owner_id: string;
  item: string;
  summary: string;
  // The contract shows a string. Null is tolerated for notes with no place in them.
  location: string | null;
  topic: string;
  group: string;
  source: MemorySource;
  status: MemoryStatus;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  image_url: string | null;
}

export type AuditAction =
  | 'memory_stored'
  | 'memory_superseded'
  | 'memory_forgotten'
  | 'memory_expired'
  | 'query_answered'
  | 'query_denied'
  | 'rule_changed';

export type AuditVerdict = 'allowed' | 'denied' | 'info';

export interface AuditEntry {
  id: string;
  ts: string;
  space_id: string;
  actor_id: string;
  action: AuditAction;
  verdict: AuditVerdict;
  detail: string;
  memory_ids: string[];
}

export interface LiveTurn {
  user_id: string;
  ts: string;
  transcript: string | null;
  kind: TurnKind;
  reply_text: string;
  image_url: string | null;
}

export interface SpaceState {
  space_id: string;
  users: User[];
  rules: Rules;
  memories: Memory[];
  audit: AuditEntry[];
  frames?: FrameEvent[];
  latest_turn?: LiveTurn | null;
}

export type SendMode = 'text' | 'audio' | 'both';
export type InputUsed = 'text' | 'audio' | null;

export interface TurnAudio {
  format: string;
  sample_rate: number | null;
  channels: number;
  data_b64: string;
}

export interface TurnRequest {
  space_id: string;
  user_id: string;
  ts: string;
  text: string | null;
  audio: TurnAudio | null;
  image_b64: string | null;
  image_url: string | null;
}

export type TurnKind = 'saved' | 'answer' | 'denied' | 'forgot' | 'ignored';

export interface TurnResponse {
  kind: TurnKind;
  reply_text: string;
  audio_url: string | null;
  memory_ids: string[];
  heard_text?: string | null;
  input_used?: InputUsed;
}

export interface FrameRequest {
  space_id: string;
  user_id: string;
  ts: string;
  image_b64: string | null;
  image_url: string | null;
}

export interface RulesResponse {
  ok: boolean;
  rules: Rules;
}

export interface MemoryEvent {
  op: 'created' | 'updated';
  memory: Memory;
}

export interface AuditEvent {
  entry: AuditEntry;
}

export interface RulesEvent {
  rules: Rules;
}

export interface FrameEvent {
  user_id: string;
  ts: string;
  image_url: string;
}
