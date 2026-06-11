import fs from 'node:fs';
import path from 'node:path';
import { parseClaudeJsonl } from './claude-jsonl.js';
import { coworkRoots } from '../paths.js';
import type { CanonicalMeta, CanonicalSession } from '../types.js';

/**
 * Cowork adapter.
 *
 * Layout (observed on real data, Claude Desktop 2026-06):
 *   <root>/<orgId>/<userId>/local_<sessionId>.json     ← session metadata
 *   <root>/<orgId>/<userId>/local_<sessionId>/         ← session dir
 *     .claude/projects/<encoded-cwd>/<cliSessionId>.jsonl   ← transcript
 *                                                        (Claude-Code format!)
 *     audit.jsonl (+ .audit-key)                        ← HMAC-chained audit log (read-only for us)
 *
 * Key insight: Cowork runs Claude Code internally, so the transcript reuses the
 * Claude Code JSONL format — parsed by the shared claude-jsonl parser.
 *
 * Project attribution: Cowork sessions work on *mounted folders*
 * (userSelectedFolders). The first mounted folder is the session's project;
 * sessions without mounted folders group under "cowork://<title>".
 */

export interface CoworkDiscovery {
  metaFile: string;
  transcript: string | null;
}

export function discoverCoworkSessions(rootsOverride?: string[]): CoworkDiscovery[] {
  const roots = rootsOverride ?? (process.env.SBUS_COWORK_ROOT ? [process.env.SBUS_COWORK_ROOT] : coworkRoots());
  const found: CoworkDiscovery[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const metaFile of walkFor(root, /^local_[0-9a-f-]+\.json$/, 3)) {
      const dir = metaFile.replace(/\.json$/, '');
      found.push({ metaFile, transcript: findTranscript(dir, metaFile) });
    }
  }
  return found;
}

function findTranscript(sessionDir: string, metaFile: string): string | null {
  let cliSessionId: string | null = null;
  try {
    cliSessionId = JSON.parse(fs.readFileSync(metaFile, 'utf8')).cliSessionId ?? null;
  } catch {
    /* fall back to glob below */
  }
  const projectsDir = path.join(sessionDir, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  const candidates: string[] = [];
  for (const enc of fs.readdirSync(projectsDir)) {
    const d = path.join(projectsDir, enc);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.jsonl')) continue;
      if (cliSessionId && f === `${cliSessionId}.jsonl`) return path.join(d, f);
      candidates.push(path.join(d, f));
    }
  }
  // no exact match: take the largest jsonl (the main transcript)
  candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return candidates[0] ?? null;
}

export async function parseCoworkSession(d: CoworkDiscovery): Promise<CanonicalSession | null> {
  let metaJson: any = {};
  try {
    metaJson = JSON.parse(fs.readFileSync(d.metaFile, 'utf8'));
  } catch {
    return null;
  }
  if (!d.transcript) return null;
  const parsed = await parseClaudeJsonl(d.transcript);

  const sessionUuid = String(metaJson.sessionId ?? path.basename(d.metaFile, '.json')).replace(/^local_/, '');
  const folders: string[] = Array.isArray(metaJson.userSelectedFolders) ? metaJson.userSelectedFolders : [];
  const title = String(metaJson.title ?? '') || deriveTitle(parsed.firstUserText) || '(untitled cowork session)';
  const project = folders[0] ? path.resolve(folders[0]) : `cowork://${title}`;

  const meta: CanonicalMeta = {
    kind: 'meta',
    schema: 1,
    id: `cowork-${sessionUuid.replace(/-/g, '').slice(-8)}`,
    source: 'cowork',
    sourceSessionId: sessionUuid,
    sourcePath: d.transcript,
    project,
    title,
    models: metaJson.model ? [String(metaJson.model)] : parsed.models,
    startedAt: metaJson.createdAt ? new Date(metaJson.createdAt).toISOString() : parsed.firstTs,
    endedAt: metaJson.lastActivityAt ? new Date(metaJson.lastActivityAt).toISOString() : parsed.lastTs,
    counts: { events: parsed.events.length, ...parsed.counts },
    usage: parsed.usage,
    filesTouched: parsed.filesTouched,
    originator: 'Claude Cowork',
  };
  return { meta, events: parsed.events };
}

function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n').find((l) => l.trim()) ?? '';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

function walkFor(dir: string, fileRe: RegExp, maxDepth: number): string[] {
  const out: string[] = [];
  if (maxDepth < 0) return out;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkFor(p, fileRe, maxDepth - 1));
    else if (fileRe.test(name)) out.push(p);
  }
  return out;
}
