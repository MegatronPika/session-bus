import { groupByProject, loadIndex, loadSession } from './store.js';
import type { IndexEntry } from './types.js';

export interface SearchHit {
  sessionId: string;
  project: string;
  source: string;
  eventIndex: number;
  role: string;
  ts: string | null;
  snippet: string;
}

/**
 * Keyword search over canonical store (case-insensitive substring, v0.1).
 * Searches message text only by default — that's where the answers live.
 */
export function searchSessions(query: string, opts: { project?: string; limit?: number; includeTools?: boolean } = {}): SearchHit[] {
  const idx = loadIndex();
  const limit = opts.limit ?? 20;
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];

  let entries = Object.values(idx.sessions);
  if (opts.project) {
    entries = entries.filter((e) => e.project.toLowerCase().includes(opts.project!.toLowerCase()));
  }
  // newest first — recent context usually matters more
  entries.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));

  for (const entry of entries) {
    if (hits.length >= limit) break;
    const s = loadSession(entry.id);
    if (!s) continue;
    for (const e of s.events) {
      if (hits.length >= limit) break;
      if (!opts.includeTools && e.role === 'tool') continue;
      const text = e.text ?? '';
      const pos = text.toLowerCase().indexOf(q);
      if (pos === -1) continue;
      hits.push({
        sessionId: entry.id,
        project: entry.project,
        source: entry.source,
        eventIndex: e.i,
        role: e.role,
        ts: e.ts,
        snippet: makeSnippet(text, pos, q.length),
      });
    }
  }
  return hits;
}

function makeSnippet(text: string, pos: number, qLen: number): string {
  const start = Math.max(0, pos - 80);
  const end = Math.min(text.length, pos + qLen + 120);
  const cut = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${cut}${end < text.length ? '…' : ''}`;
}
