import fs from 'node:fs';
import path from 'node:path';

/**
 * `sbus init [dir]` — drop an ambient trigger into a project so agents use
 * session-bus WITHOUT being told to by name.
 *
 * Agents act on three inputs: the user's prompt, ambient instruction files,
 * and tool descriptions. Tool descriptions alone don't trigger proactive use
 * (in some hosts MCP tools are even lazy-loaded), so we write a short block
 * into the files each app reads automatically at session start:
 *   - AGENTS.md  → Codex (native), Cursor, Copilot, Roo, …
 *   - CLAUDE.md  → Claude Code, and Cowork (reads CLAUDE.md in mounted folders)
 *
 * Idempotent: the block is fenced by markers and replaced on re-run.
 */

const BEGIN = '<!-- session-bus:begin -->';
const END = '<!-- session-bus:end -->';

const BLOCK = `${BEGIN}
## Cross-app session history (session-bus)

This project has AI session history recorded across multiple apps (Codex, Claude Cowork, …)
and served by the \`session-bus\` MCP server.

- Before continuing prior work — or whenever past decisions/context might exist — first call
  \`get_handoff(project: "<this project dir>")\` for a briefing.
- Use \`search_sessions(query)\` / \`get_session(id)\` to quote the verbatim history when needed.
- After finishing significant work, you do NOT need to register anything: sessions are
  collected automatically.
- If no \`session-bus\` tools are available in this session, tell the user to run
  \`sbus setup <app> --apply\` and restart the app.
${END}`;

export interface InitResult {
  file: string;
  action: 'created' | 'appended' | 'updated';
}

export function initProject(dir: string): InitResult[] {
  const target = path.resolve(dir);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`not a directory: ${target}`);
  }
  const results: InitResult[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(target, name);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, BLOCK + '\n', 'utf8');
      results.push({ file, action: 'created' });
      continue;
    }
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.includes(BEGIN)) {
      const updated = raw.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`), BLOCK);
      fs.writeFileSync(file, updated, 'utf8');
      results.push({ file, action: 'updated' });
    } else {
      fs.writeFileSync(file, raw.trimEnd() + '\n\n' + BLOCK + '\n', 'utf8');
      results.push({ file, action: 'appended' });
    }
  }
  return results;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
