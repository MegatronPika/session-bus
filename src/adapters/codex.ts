import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { CanonicalEvent, CanonicalMeta, CanonicalSession, EventType, Role } from '../types.js';

/**
 * Codex adapter — parses ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Observed format (verified on real data, Codex Desktop 0.133.x, 2026-06):
 *   one JSON object per line: { timestamp, type, payload }
 *   type ∈ session_meta | turn_context | response_item | event_msg | compacted
 *   response_item.payload.type ∈ message | reasoning | function_call |
 *     function_call_output | custom_tool_call | custom_tool_call_output | web_search_call
 *   event_msg.payload.type ∈ user_message | agent_message | token_count |
 *     task_started | task_complete | patch_apply_end | context_compacted | ...
 *
 * Parsing is deliberately lenient: unknown types are ignored, bad lines are
 * counted but never fatal (formats are undocumented and change between versions).
 */

const TOOL_INPUT_CAP = 400;
const TOOL_OUTPUT_CAP = 600;

export async function parseCodexFile(filePath: string): Promise<CanonicalSession> {
  const events: CanonicalEvent[] = [];
  const filesTouched = new Set<string>();
  const models = new Set<string>();
  const seenTexts = new Set<string>(); // dedupe across event_msg / response_item channels

  const meta: CanonicalMeta = {
    kind: 'meta',
    schema: 1,
    id: '',
    source: 'codex',
    sourceSessionId: '',
    sourcePath: filePath,
    project: '',
    title: '',
    models: [],
    startedAt: null,
    endedAt: null,
    counts: { events: 0, userMsgs: 0, assistantMsgs: 0, toolCalls: 0, compactions: 0, badLines: 0 },
    filesTouched: [],
  };

  let lineNo = 0;
  let seq = 0;
  let lastTs: string | null = null;

  const push = (e: Omit<CanonicalEvent, 'kind' | 'i'>): void => {
    events.push({ kind: 'event', i: seq++, ...e });
  };

  const dedupeKey = (role: string, text: string): string => `${role}:${text.slice(0, 300)}`;

  const addMessage = (role: Role, text: string, ts: string | null, srcLine: number): void => {
    if (!text.trim()) return;
    const key = dedupeKey(role, text);
    if (seenTexts.has(key)) return;
    seenTexts.add(key);

    if (role === 'user' && looksLikeSystemWrapper(text)) {
      push({ ts, role: 'system', type: 'system', text: truncate(text, 300), srcLine });
      return;
    }
    push({ ts, role, type: 'message', text, srcLine });
    if (role === 'user') {
      meta.counts.userMsgs++;
      if (!meta.title) meta.title = deriveTitle(text);
    } else if (role === 'assistant') {
      meta.counts.assistantMsgs++;
    }
  };

  const rl = readline.createInterface({
    input: await openRolloutStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      meta.counts.badLines++;
      continue;
    }
    const ts: string | null = rec.timestamp ?? null;
    if (ts) {
      if (!meta.startedAt) meta.startedAt = ts;
      lastTs = ts;
    }
    const p = rec.payload ?? {};

    try {
      switch (rec.type) {
        case 'session_meta': {
          meta.sourceSessionId = p.id ?? '';
          meta.project = normalizeProject(p.cwd ?? '');
          meta.agentVersion = p.cli_version;
          meta.originator = p.originator;
          if (p.model) models.add(String(p.model));
          break;
        }
        case 'turn_context': {
          if (p.model) models.add(String(p.model));
          if (p.cwd && !meta.project) meta.project = normalizeProject(p.cwd);
          break;
        }
        case 'compacted': {
          meta.counts.compactions++;
          const kept = Array.isArray(p.replacement_history) ? p.replacement_history.length : 0;
          push({
            ts, role: 'system', type: 'compaction',
            text: `context compacted (live history replaced by ${kept} condensed items; full log preserved on disk)`,
            srcLine: lineNo,
          });
          break;
        }
        case 'response_item':
          handleResponseItem(p, ts, lineNo);
          break;
        case 'event_msg':
          handleEventMsg(p, ts, lineNo);
          break;
        default:
          break; // unknown top-level type: ignore (forward compatibility)
      }
    } catch {
      meta.counts.badLines++;
    }
  }

  function handleResponseItem(p: any, ts: string | null, srcLine: number): void {
    switch (p.type) {
      case 'message': {
        const text = joinContent(p.content);
        const role: Role = p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : 'system';
        if (role === 'system') {
          push({ ts, role, type: 'system', text: truncate(text, 300), srcLine });
        } else {
          addMessage(role, text, ts, srcLine);
        }
        break;
      }
      case 'reasoning': {
        const summary = Array.isArray(p.summary) ? p.summary.map((s: any) => s?.text ?? '').join('\n').trim() : '';
        if (summary) push({ ts, role: 'assistant', type: 'thinking', text: truncate(summary, 500), srcLine });
        // encrypted_content is unreadable by design — skip silently
        break;
      }
      case 'function_call': {
        meta.counts.toolCalls++;
        push({
          ts, role: 'tool', type: 'tool_call', srcLine,
          tool: { name: p.name ?? 'unknown', input: digestToolInput(p.name, p.arguments) },
        });
        break;
      }
      case 'custom_tool_call': {
        meta.counts.toolCalls++;
        const files = (p.name === 'apply_patch' ? extractPatchFiles(String(p.input ?? '')) : [])
          .map((f) => absolutize(f, meta.project));
        files.forEach((f) => filesTouched.add(f));
        push({
          ts, role: 'tool', type: p.name === 'apply_patch' ? 'file_change' : 'tool_call', srcLine,
          tool: { name: p.name ?? 'unknown', input: truncate(String(p.input ?? ''), TOOL_INPUT_CAP) },
          files: files.length ? files : undefined,
        });
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const out = String(p.output ?? '');
        push({
          ts, role: 'tool', type: 'tool_result', srcLine,
          text: truncate(out, TOOL_OUTPUT_CAP),
          tool: { name: '', ok: !/exited with code [1-9]|Exit code: [1-9]/i.test(out) },
        });
        break;
      }
      case 'web_search_call': {
        const queries = p.action?.queries ?? (p.action?.query ? [p.action.query] : []);
        push({ ts, role: 'tool', type: 'search', text: queries.join(' | '), srcLine, tool: { name: 'web_search' } });
        break;
      }
      default:
        break;
    }
  }

  function handleEventMsg(p: any, ts: string | null, srcLine: number): void {
    switch (p.type) {
      case 'user_message':
        addMessage('user', String(p.message ?? ''), ts, srcLine);
        break;
      case 'agent_message':
        addMessage('assistant', String(p.message ?? ''), ts, srcLine);
        break;
      case 'patch_apply_end': {
        const changed = (p.changes && typeof p.changes === 'object' ? Object.keys(p.changes) : [])
          .map((f) => absolutize(f, meta.project));
        changed.forEach((f) => filesTouched.add(f));
        if (changed.length) {
          push({
            ts, role: 'tool', type: 'file_change', srcLine,
            text: p.success === false ? 'patch failed' : undefined,
            files: changed,
            tool: { name: 'apply_patch', ok: p.success !== false },
          });
        }
        break;
      }
      case 'token_count': {
        const u = p.info?.total_token_usage;
        if (u) {
          meta.usage = {
            ...meta.usage,
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            totalTokens: u.total_tokens,
          };
        }
        break;
      }
      case 'task_started': {
        if (p.model_context_window) {
          meta.usage = { ...meta.usage, contextWindow: p.model_context_window };
        }
        break;
      }
      case 'context_compacted':
        // companion marker of top-level `compacted` — already recorded there
        break;
      default:
        break;
    }
  }

  meta.endedAt = lastTs;
  meta.models = [...models];
  meta.filesTouched = [...filesTouched];
  meta.counts.events = events.length;
  // UUIDv7 prefixes are timestamps → same-day sessions collide on first chars.
  // Use the random tail of the uuid (fall back to a path hash) for uniqueness.
  const uuidTail = meta.sourceSessionId.replace(/-/g, '').slice(-8);
  meta.id = `codex-${uuidTail || hashName(filePath)}`;
  if (!meta.title) meta.title = '(no user message)';
  if (!meta.project) meta.project = '(unknown)';
  return { meta, events };
}

/* ----------------------------- helpers ----------------------------- */

/**
 * Plain .jsonl streams from disk; .jsonl.zst (Codex's archived rollouts) is
 * decompressed in memory via fzstd (pure JS — keeps the zero-native-deps
 * promise). Archived rollouts are decompressed whole; very large archives
 * trade memory for simplicity (acceptable for v0.2, revisit if it bites).
 */
async function openRolloutStream(filePath: string): Promise<Readable> {
  if (!filePath.endsWith('.zst')) {
    return fs.createReadStream(filePath, { encoding: 'utf8' }) as unknown as Readable;
  }
  let fzstd: typeof import('fzstd');
  try {
    fzstd = await import('fzstd');
  } catch {
    throw new Error('.zst rollouts need the "fzstd" dependency — run `npm install` in session-bus');
  }
  const compressed = fs.readFileSync(filePath);
  const out = fzstd.decompress(new Uint8Array(compressed));
  return Readable.from(Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('utf8'));
}

function joinContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => c?.text ?? c?.input_text ?? c?.output_text ?? '')
    .filter(Boolean)
    .join('\n');
}

function looksLikeSystemWrapper(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('<permissions') ||
    t.startsWith('<user_instructions>') ||
    t.startsWith('<turn_aborted') ||
    t.startsWith('<system_')
  );
}

function deriveTitle(text: string): string {
  // skip IDE-injected wrapper headings ("# Context from my IDE setup:" etc.)
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const firstReal = lines.find((l) => !/^#+\s|^<\w+/.test(l)) ?? lines[0] ?? '';
  return firstReal.length > 60 ? `${firstReal.slice(0, 57)}…` : firstReal;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars, see srcLine]` : s;
}

function digestToolInput(name: string | undefined, args: unknown): string {
  const raw = String(args ?? '');
  try {
    const parsed = JSON.parse(raw);
    if (parsed.cmd) return truncate(String(parsed.cmd), TOOL_INPUT_CAP);
    if (parsed.command) return truncate(String(parsed.command), TOOL_INPUT_CAP);
  } catch {
    /* not JSON — fall through */
  }
  return truncate(raw, TOOL_INPUT_CAP);
}

/** Extract file paths from an apply_patch envelope. */
export function extractPatchFiles(patch: string): string[] {
  const files: string[] = [];
  const re = /^\*{3} (?:Add|Update|Delete) File: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) files.push(m[1].trim());
  return files;
}

function normalizeProject(cwd: string): string {
  if (!cwd) return '';
  return path.resolve(cwd);
}

/** Patch envelopes mix relative and absolute paths — anchor relative ones to the project dir. */
function absolutize(f: string, project: string): string {
  if (path.isAbsolute(f)) return path.normalize(f);
  return project ? path.join(project, f) : f;
}

function hashName(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).padStart(8, '0');
}
