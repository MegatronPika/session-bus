import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseClaudeJsonl } from './claude-jsonl.js';
import type { CanonicalMeta, CanonicalSession } from '../types.js';

/**
 * Claude Code (standalone CLI) adapter.
 *
 * Layout: ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
 * (CLAUDE_CONFIG_DIR overrides ~/.claude). The transcript format is identical
 * to Cowork's internal one — both go through the shared claude-jsonl parser.
 *
 * Project attribution: per-line `cwd` field (authoritative), falling back to
 * decoding the directory name (path with `/` → `-`, lossy for dirs whose names
 * contain `-`, hence only a fallback).
 *
 * No overlap with the Cowork adapter: Cowork sessions keep their transcripts
 * under the Cowork session dir's own .claude/, not under ~/.claude.
 */

export function claudeCodeProjectsDir(): string {
  const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(home, 'projects');
}

export interface ClaudeCodeDiscovery {
  transcript: string;
  encodedDir: string;
}

export function discoverClaudeCodeSessions(dirOverride?: string): ClaudeCodeDiscovery[] {
  const root = dirOverride ?? process.env.SBUS_CLAUDE_CODE_ROOT ?? claudeCodeProjectsDir();
  const found: ClaudeCodeDiscovery[] = [];
  if (!fs.existsSync(root)) return found;
  for (const enc of safeReaddir(root)) {
    const dir = path.join(root, enc);
    if (!safeIsDir(dir)) continue;
    for (const f of safeReaddir(dir)) {
      if (f.endsWith('.jsonl')) found.push({ transcript: path.join(dir, f), encodedDir: enc });
    }
  }
  return found;
}

export async function parseClaudeCodeSession(d: ClaudeCodeDiscovery): Promise<CanonicalSession> {
  const parsed = await parseClaudeJsonl(d.transcript);
  const sessionUuid = parsed.sessionId ?? path.basename(d.transcript, '.jsonl');
  const project = parsed.cwd ? path.resolve(parsed.cwd) : decodeProjectDir(d.encodedDir);

  const meta: CanonicalMeta = {
    kind: 'meta',
    schema: 1,
    id: `cc-${sessionUuid.replace(/-/g, '').slice(-8)}`,
    source: 'claude-code',
    sourceSessionId: sessionUuid,
    sourcePath: d.transcript,
    project,
    title: deriveTitle(parsed.firstUserText) || '(no user message)',
    models: parsed.models,
    startedAt: parsed.firstTs,
    endedAt: parsed.lastTs,
    counts: { events: parsed.events.length, ...parsed.counts },
    usage: parsed.usage,
    filesTouched: parsed.filesTouched,
    agentVersion: parsed.version ?? undefined,
    originator: 'Claude Code',
  };
  return { meta, events: parsed.events };
}

/** Lossy fallback: "-Users-zhangzekun-dev-app" → "/Users/zhangzekun/dev/app". */
export function decodeProjectDir(encoded: string): string {
  if (!encoded.startsWith('-')) return encoded;
  return encoded.replace(/-/g, '/');
}

function deriveTitle(text: string): string {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const firstReal = lines.find((l) => !/^#+\s|^<\w+/.test(l)) ?? lines[0] ?? '';
  return firstReal.length > 60 ? `${firstReal.slice(0, 57)}…` : firstReal;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
