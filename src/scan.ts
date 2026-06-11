import fs from 'node:fs';
import path from 'node:path';
import { codexHome } from './paths.js';
import { parseCodexFile } from './adapters/codex.js';
import { discoverCoworkSessions, parseCoworkSession } from './adapters/cowork.js';
import { entryFromMeta, loadIndex, saveIndex, saveSession } from './store.js';

export interface ScanResult {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  failed: { file: string; error: string }[];
  zstSkipped: number;
}

/**
 * Incremental scan: a source file is re-parsed only when its mtime/size
 * fingerprint changed. Lazy-refresh callers (handoff/MCP) invoke this first,
 * so query results always reflect the latest on-disk state.
 */
export async function scanCodex(opts: { home?: string; quiet?: boolean } = {}): Promise<ScanResult> {
  const root = path.join(opts.home ?? codexHome(), 'sessions');
  const res: ScanResult = { scanned: 0, added: 0, updated: 0, skipped: 0, failed: [], zstSkipped: 0 };
  if (!fs.existsSync(root)) return res;

  const files = walk(root).filter((f) => path.basename(f).startsWith('rollout-'));
  const idx = loadIndex();
  const known = new Map(Object.values(idx.sessions).map((e) => [e.sourcePath, e]));

  for (const file of files) {
    if (file.endsWith('.zst')) {
      res.zstSkipped++; // compressed rollouts: planned for v0.2 (needs zstd dep)
      continue;
    }
    if (!file.endsWith('.jsonl')) continue;
    res.scanned++;
    const st = fs.statSync(file);
    const prev = known.get(file);
    if (prev && prev.sourceMtimeMs === st.mtimeMs && prev.sourceSize === st.size) {
      res.skipped++;
      continue;
    }
    try {
      const session = await parseCodexFile(file);
      saveSession(session);
      idx.sessions[session.meta.id] = entryFromMeta(session.meta, st.mtimeMs, st.size);
      prev ? res.updated++ : res.added++;
      if (!opts.quiet) {
        console.log(`  ${prev ? '↻' : '+'} ${session.meta.id}  ${shortProject(session.meta.project)}  "${session.meta.title}"`);
      }
    } catch (err) {
      res.failed.push({ file, error: String(err) });
    }
  }
  saveIndex(idx);
  return res;
}

/** Scan Cowork local sessions (transcript fingerprint = mtime+size, incremental). */
export async function scanCowork(opts: { roots?: string[]; quiet?: boolean } = {}): Promise<ScanResult> {
  const res: ScanResult = { scanned: 0, added: 0, updated: 0, skipped: 0, failed: [], zstSkipped: 0 };
  const idx = loadIndex();
  const known = new Map(Object.values(idx.sessions).map((e) => [e.sourcePath, e]));

  for (const d of discoverCoworkSessions(opts.roots)) {
    if (!d.transcript) continue;
    res.scanned++;
    let st: fs.Stats;
    try {
      st = fs.statSync(d.transcript);
    } catch {
      continue;
    }
    const prev = known.get(d.transcript);
    if (prev && prev.sourceMtimeMs === st.mtimeMs && prev.sourceSize === st.size) {
      res.skipped++;
      continue;
    }
    try {
      const session = await parseCoworkSession(d);
      if (!session) continue;
      saveSession(session);
      idx.sessions[session.meta.id] = entryFromMeta(session.meta, st.mtimeMs, st.size);
      prev ? res.updated++ : res.added++;
      if (!opts.quiet) {
        console.log(`  ${prev ? '↻' : '+'} ${session.meta.id}  ${shortProject(session.meta.project)}  "${session.meta.title}"`);
      }
    } catch (err) {
      res.failed.push({ file: d.transcript, error: String(err) });
    }
  }
  saveIndex(idx);
  return res;
}

/** Refresh every supported source (used by CLI scan and MCP lazy refresh). */
export async function scanAll(opts: { quiet?: boolean } = {}): Promise<Record<string, ScanResult>> {
  return {
    codex: await scanCodex(opts),
    cowork: await scanCowork(opts),
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function shortProject(p: string): string {
  const parts = p.split(path.sep);
  return parts.length > 2 ? parts.slice(-2).join('/') : p;
}
