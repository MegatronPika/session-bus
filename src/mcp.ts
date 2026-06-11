import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { scanAll } from './scan.js';
import { groupByProject, loadIndex, loadSession } from './store.js';
import { generateHandoff } from './handoff.js';
import { searchSessions } from './search.js';
import { redact } from './redact.js';

/**
 * session-bus MCP server (stdio).
 *
 * Every tool lazy-refreshes the store first (incremental, mtime-based) so
 * agents always see the latest on-disk state — switch apps as often as you
 * like, the answer is current.
 */
export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'session-bus', version: '0.2.0' });

  // Pre-warm: start the (potentially slow) initial scan at server startup,
  // not on the first tool call. First-ever scans on a big machine can take
  // tens of seconds; queries during that window are served from the existing
  // index with a "refreshing" note instead of blocking.
  let warming: Promise<unknown> | null = scanAll({ quiet: true })
    .catch(() => {})
    .finally(() => {
      warming = null;
    });

  /** Returns true when results may be slightly stale (initial scan running). */
  const refresh = async (): Promise<boolean> => {
    if (warming) {
      await Promise.race([warming, sleep(2500)]);
      return warming !== null;
    }
    try {
      await scanAll({ quiet: true }); // incremental: fingerprint-skip, fast
    } catch {
      /* never let a scan failure break a query */
    }
    return false;
  };

  const STALE_NOTE = '\n\n[note: initial index refresh still running — results may lag; call again in a few seconds for the freshest state]';
  const text = (s: string, stale = false) => ({ content: [{ type: 'text' as const, text: redact(s) + (stale ? STALE_NOTE : '') }] });

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List all projects that have recorded AI agent sessions on this machine (across Codex, Cowork, …), with session counts and last activity. Start here to discover what history exists.',
      inputSchema: {},
    },
    async () => {
      const stale = await refresh();
      const groups = groupByProject(loadIndex());
      if (groups.size === 0) return text('No sessions recorded yet. Ask the user to run `sbus scan`.', stale);
      const rows = [...groups.entries()]
        .map(([project, es]) => ({
          project,
          sessions: es.length,
          lastActivity: es.reduce((a, e) => ((e.endedAt ?? '') > a ? e.endedAt! : a), ''),
          sources: [...new Set(es.map((e) => e.source))],
        }))
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
      return text(JSON.stringify(rows, null, 1), stale);
    },
  );

  server.registerTool(
    'list_sessions',
    {
      title: 'List sessions of a project',
      description:
        'List the session timeline of one project (sessions ≈ sub-tasks, ordered by time, each with id/source/title/message count). Use the ids with get_session or get_handoff.',
      inputSchema: { project: z.string().describe('project path or any substring of it, e.g. "petpet"') },
    },
    async ({ project }) => {
      const stale = await refresh();
      const groups = groupByProject(loadIndex());
      const hit = [...groups.entries()].find(([p]) => p.toLowerCase().includes(project.toLowerCase()));
      if (!hit) return text(`No project matching "${project}". Call list_projects to see what exists.`, stale);
      const rows = hit[1].map((e) => ({
        id: e.id,
        source: e.source,
        started: e.startedAt,
        ended: e.endedAt,
        userMsgs: e.userMsgs,
        title: e.title,
      }));
      return text(`project: ${hit[0]}\n${JSON.stringify(rows, null, 1)}`, stale);
    },
  );

  server.registerTool(
    'get_handoff',
    {
      title: 'Get project handoff',
      description:
        'Generate a handoff document for a project: goal, per-session timeline, user-stated constraints (verbatim), open threads, files touched. THE tool to call before taking over work started in another AI app. Levels: brief (~1k tokens) | standard | full.',
      inputSchema: {
        project: z.string().describe('project path or substring'),
        level: z.enum(['brief', 'standard', 'full']).optional().describe('default: standard'),
      },
    },
    async ({ project, level }) => {
      const stale = await refresh();
      const doc = generateHandoff(project, level ?? 'standard');
      return doc ? text(doc, stale) : text(`No project matching "${project}". Call list_projects first.`, stale);
    },
  );

  server.registerTool(
    'get_session',
    {
      title: 'Read one session verbatim',
      description:
        'Page through the normalized events of one session (user/assistant messages verbatim; tool calls digested). Use offset/limit to paginate; filter roles to keep responses small.',
      inputSchema: {
        id: z.string().describe('session id (or unique prefix) from list_sessions'),
        offset: z.number().int().min(0).optional().describe('event index to start from (default 0)'),
        limit: z.number().int().min(1).max(200).optional().describe('max events to return (default 50)'),
        rolesOnly: z.boolean().optional().describe('true = only user/assistant messages (default true)'),
      },
    },
    async ({ id, offset, limit, rolesOnly }) => {
      const stale = await refresh();
      const s = loadSession(id);
      if (!s) return text(`Session "${id}" not found or ambiguous — use list_sessions.`, stale);
      const keep = rolesOnly === false ? s.events : s.events.filter((e) => e.role === 'user' || e.role === 'assistant');
      const start = offset ?? 0;
      const lim = limit ?? 50;
      const page = keep.slice(start, start + lim);
      const lines = page.map((e) => `[${e.i}] ${e.role}/${e.type} ${(e.ts ?? '').slice(0, 19)}\n${e.text ?? (e.tool ? `${e.tool.name}: ${e.tool.input ?? ''}` : '')}`);
      const head = `session ${s.meta.id} · "${s.meta.title}" · project ${s.meta.project}\nevents ${start}–${start + page.length - 1} of ${keep.length} (filtered) / ${s.meta.counts.events} (total)`;
      const tail = start + lim < keep.length ? `\n…more — call again with offset=${start + lim}` : '';
      return text(`${head}\n\n${lines.join('\n\n')}${tail}`, stale);
    },
  );

  server.registerTool(
    'search_sessions',
    {
      title: 'Search all session history',
      description:
        'Full-text keyword search across every recorded session (all apps, all projects). Returns snippets with session id + event index — follow up with get_session(id, offset=eventIndex) for surrounding context. Use this to answer "what did the user say about X in the other app?".',
      inputSchema: {
        query: z.string().describe('keyword or phrase (case-insensitive)'),
        project: z.string().optional().describe('restrict to one project (substring)'),
        limit: z.number().int().min(1).max(50).optional().describe('default 20'),
      },
    },
    async ({ query, project, limit }) => {
      const stale = await refresh();
      const hits = searchSessions(query, { project, limit });
      if (hits.length === 0) return text(`No matches for "${query}".`, stale);
      const lines = hits.map(
        (h) => `${h.sessionId} [${h.role} @ event ${h.eventIndex}] ${path.basename(h.project)} ${(h.ts ?? '').slice(0, 16)}\n  ${h.snippet}`,
      );
      return text(lines.join('\n\n'), stale);
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('session-bus MCP server running (stdio)');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
