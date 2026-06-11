import fs from 'node:fs';
import readline from 'node:readline';
import type { CanonicalEvent, Role } from '../types.js';

/**
 * Shared parser for the Claude-Code-style transcript JSONL
 * (used verbatim by Claude Code, and by Cowork internally — one parser, two adapters).
 *
 * Observed line types: user | assistant | attachment | queue-operation |
 * last-prompt | summary | progress | system. Content blocks inside messages:
 * text | thinking | tool_use | tool_result.
 */

const TOOL_INPUT_CAP = 400;
const TOOL_OUTPUT_CAP = 600;

export interface ClaudeJsonlResult {
  events: CanonicalEvent[];
  filesTouched: string[];
  models: string[];
  counts: { userMsgs: number; assistantMsgs: number; toolCalls: number; compactions: number; badLines: number; sidechainLines: number };
  firstTs: string | null;
  lastTs: string | null;
  firstUserText: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export async function parseClaudeJsonl(filePath: string): Promise<ClaudeJsonlResult> {
  const events: CanonicalEvent[] = [];
  const filesTouched = new Set<string>();
  const models = new Set<string>();
  const counts = { userMsgs: 0, assistantMsgs: 0, toolCalls: 0, compactions: 0, badLines: 0, sidechainLines: 0 };
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let firstUserText = '';
  let usage: ClaudeJsonlResult['usage'];
  let seq = 0;
  let lineNo = 0;

  const push = (e: Omit<CanonicalEvent, 'kind' | 'i'>): void => {
    events.push({ kind: 'event', i: seq++, ...e });
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      counts.badLines++;
      continue;
    }
    const ts: string | null = d.timestamp ?? null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }
    // subagent (sidechain) traffic: not part of the main timeline in v0.1
    if (d.isSidechain === true) {
      counts.sidechainLines++;
      continue;
    }

    try {
      switch (d.type) {
        case 'user': {
          const content = d.message?.content;
          if (typeof content === 'string') {
            handleUserText(content, ts, lineNo);
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'text') handleUserText(String(block.text ?? ''), ts, lineNo);
              else if (block?.type === 'tool_result') {
                push({
                  ts, role: 'tool', type: 'tool_result', srcLine: lineNo,
                  text: truncate(flattenToolResult(block.content), TOOL_OUTPUT_CAP),
                  tool: { name: '', ok: block.is_error !== true },
                });
              }
            }
          }
          break;
        }
        case 'assistant': {
          const msg = d.message ?? {};
          if (msg.model) models.add(String(msg.model));
          if (msg.usage) {
            usage = {
              inputTokens: msg.usage.input_tokens,
              outputTokens: (usage?.outputTokens ?? 0) + (msg.usage.output_tokens ?? 0),
            };
          }
          for (const block of Array.isArray(msg.content) ? msg.content : []) {
            if (block?.type === 'text' && String(block.text ?? '').trim()) {
              push({ ts, role: 'assistant', type: 'message', text: String(block.text), srcLine: lineNo });
              counts.assistantMsgs++;
            } else if (block?.type === 'thinking' && String(block.thinking ?? '').trim()) {
              push({ ts, role: 'assistant', type: 'thinking', text: truncate(String(block.thinking), 500), srcLine: lineNo });
            } else if (block?.type === 'tool_use') {
              counts.toolCalls++;
              const name = String(block.name ?? 'unknown');
              const input = block.input ?? {};
              const file = FILE_TOOLS.has(name) && input.file_path ? String(input.file_path) : null;
              if (file) filesTouched.add(file);
              push({
                ts, role: 'tool', type: file ? 'file_change' : 'tool_call', srcLine: lineNo,
                tool: { name, input: digestInput(name, input) },
                files: file ? [file] : undefined,
              });
            }
          }
          break;
        }
        case 'summary': {
          counts.compactions++;
          push({ ts, role: 'system', type: 'compaction', text: `compaction summary: ${truncate(String(d.summary ?? ''), 200)}`, srcLine: lineNo });
          break;
        }
        // attachment / queue-operation / last-prompt / progress / system: not timeline content
        default:
          break;
      }
    } catch {
      counts.badLines++;
    }
  }

  function handleUserText(text: string, ts: string | null, srcLine: number): void {
    if (!text.trim()) return;
    if (looksLikeSystemWrapper(text)) {
      push({ ts, role: 'system', type: 'system', text: truncate(text, 300), srcLine });
      return;
    }
    push({ ts, role: 'user', type: 'message', text, srcLine });
    counts.userMsgs++;
    if (!firstUserText) firstUserText = text;
  }

  return {
    events,
    filesTouched: [...filesTouched],
    models: [...models],
    counts,
    firstTs,
    lastTs,
    firstUserText,
    usage,
  };
}

function looksLikeSystemWrapper(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<scheduled-task') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<local-command') ||
    t.startsWith('Caveat:')
  );
}

function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (c?.type === 'text' ? c.text : '')).filter(Boolean).join('\n');
  }
  return '';
}

function digestInput(name: string, input: any): string {
  if (name === 'Bash' && input.command) return truncate(String(input.command), TOOL_INPUT_CAP);
  if (input.file_path) return truncate(String(input.file_path), TOOL_INPUT_CAP);
  if (input.pattern) return truncate(String(input.pattern), TOOL_INPUT_CAP);
  try {
    return truncate(JSON.stringify(input), TOOL_INPUT_CAP);
  } catch {
    return '';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars, see srcLine]` : s;
}
