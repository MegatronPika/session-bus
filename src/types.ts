/**
 * Canonical session format — the "lingua franca" of session-bus.
 * Every adapter translates its app's native session log into this shape.
 * Stored as JSONL: first line is CanonicalMeta, following lines are CanonicalEvent.
 */

export type Source = 'codex' | 'cowork' | 'claude-code' | 'gemini' | 'cursor' | 'copilot';

export interface CanonicalMeta {
  kind: 'meta';
  schema: 1;
  /** session-bus internal id, e.g. "codex-019e5536" */
  id: string;
  source: Source;
  sourceSessionId: string;
  /** absolute path of the native session file (回源指针 root) */
  sourcePath: string;
  /** absolute, normalized project directory this session belongs to */
  project: string;
  /** derived from first real user message */
  title: string;
  models: string[];
  startedAt: string | null;
  endedAt: string | null;
  counts: {
    events: number;
    userMsgs: number;
    assistantMsgs: number;
    toolCalls: number;
    compactions: number;
    /** lines we could not parse — resilience metric */
    badLines: number;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    contextWindow?: number;
  };
  /** unique files created/modified during the session */
  filesTouched: string[];
  agentVersion?: string;
  originator?: string;
}

export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type EventType =
  | 'message'      // user/assistant natural language
  | 'thinking'     // reasoning summary (often unavailable/encrypted)
  | 'tool_call'    // command / tool invocation
  | 'tool_result'  // its output (digested)
  | 'file_change'  // explicit file modification record
  | 'search'       // web search
  | 'compaction'   // context-compaction marker
  | 'system';      // env wrappers, permissions, instructions

export interface CanonicalEvent {
  kind: 'event';
  /** sequence number within the session */
  i: number;
  ts: string | null;
  role: Role;
  type: EventType;
  /** digested text; user/assistant messages are kept in full */
  text?: string;
  /** 回源指针: line number in sourcePath holding the full original record */
  srcLine?: number;
  tool?: { name: string; input?: string; ok?: boolean };
  files?: string[];
}

export interface CanonicalSession {
  meta: CanonicalMeta;
  events: CanonicalEvent[];
}

/** index.json shape */
export interface IndexFile {
  schema: 1;
  updatedAt: string;
  sessions: Record<string, IndexEntry>;
}

export interface IndexEntry {
  id: string;
  source: Source;
  project: string;
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  events: number;
  userMsgs: number;
  sourcePath: string;
  /** incremental-scan fingerprint */
  sourceMtimeMs: number;
  sourceSize: number;
}
