import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sbusHome } from './paths.js';
import type { CanonicalEvent, CanonicalMeta, CanonicalSession, IndexEntry, IndexFile } from './types.js';

/**
 * Store layout:
 *   $SBUS_HOME/index.json                      — global index (incremental-scan fingerprints)
 *   $SBUS_HOME/store/<projHash>/<id>.jsonl     — canonical sessions (meta line + event lines)
 * Originals are never touched; the store is a derived, disposable cache.
 */

export function projectHash(project: string): string {
  return crypto.createHash('sha1').update(project).digest('hex').slice(0, 12);
}

export function loadIndex(): IndexFile {
  const f = path.join(sbusHome(), 'index.json');
  if (!fs.existsSync(f)) return { schema: 1, updatedAt: new Date().toISOString(), sessions: {} };
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as IndexFile;
  } catch {
    return { schema: 1, updatedAt: new Date().toISOString(), sessions: {} };
  }
}

export function saveIndex(idx: IndexFile): void {
  const home = sbusHome();
  fs.mkdirSync(home, { recursive: true });
  idx.updatedAt = new Date().toISOString();
  atomicWrite(path.join(home, 'index.json'), JSON.stringify(idx, null, 1));
}

export function sessionFilePath(meta: Pick<CanonicalMeta, 'project' | 'id'>): string {
  return path.join(sbusHome(), 'store', projectHash(meta.project), `${meta.id}.jsonl`);
}

export function saveSession(s: CanonicalSession): void {
  const file = sessionFilePath(s.meta);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [JSON.stringify(s.meta), ...s.events.map((e) => JSON.stringify(e))];
  atomicWrite(file, lines.join('\n') + '\n');
}

export function loadSession(idOrPrefix: string): CanonicalSession | null {
  const idx = loadIndex();
  const entry = resolveEntry(idx, idOrPrefix);
  if (!entry) return null;
  const file = sessionFilePath(entry);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const meta = JSON.parse(lines[0]) as CanonicalMeta;
  const events = lines.slice(1).map((l) => JSON.parse(l) as CanonicalEvent);
  return { meta, events };
}

/** Accept full id, unambiguous prefix, or source session id prefix. */
export function resolveEntry(idx: IndexFile, idOrPrefix: string): IndexEntry | null {
  if (idx.sessions[idOrPrefix]) return idx.sessions[idOrPrefix];
  const matches = Object.values(idx.sessions).filter((e) => e.id.startsWith(idOrPrefix));
  return matches.length === 1 ? matches[0] : null;
}

export function entryFromMeta(meta: CanonicalMeta, mtimeMs: number, size: number): IndexEntry {
  return {
    id: meta.id,
    source: meta.source,
    project: meta.project,
    title: meta.title,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    events: meta.counts.events,
    userMsgs: meta.counts.userMsgs,
    sourcePath: meta.sourcePath,
    sourceMtimeMs: mtimeMs,
    sourceSize: size,
  };
}

export function groupByProject(idx: IndexFile): Map<string, IndexEntry[]> {
  const map = new Map<string, IndexEntry[]>();
  for (const e of Object.values(idx.sessions)) {
    const arr = map.get(e.project) ?? [];
    arr.push(e);
    map.set(e.project, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  return map;
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}
