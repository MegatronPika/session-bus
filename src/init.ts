import fs from 'node:fs';
import os from 'node:os';
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

const GLOBAL_BLOCK = `${BEGIN}
## Cross-app session history (session-bus)

Projects on this machine may have AI session history recorded across multiple
apps (Codex, Claude Cowork, Claude Code, …), served by the \`session-bus\` MCP server.

- When asked to continue prior work — or when past decisions/context might exist —
  first call \`get_handoff(project: "<current project dir>")\` for a briefing.
  If it reports no matching project, just proceed normally.
- Use \`search_sessions(query)\` / \`get_session(id)\` to quote verbatim history when needed.
- Sessions are collected automatically; nothing to register.
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
  return ['AGENTS.md', 'CLAUDE.md'].map((name) => writeBlock(path.join(target, name), BLOCK));
}

/**
 * Global mode: one shot covers every project, present and future, via the
 * per-app global instruction files (both documented, plain Markdown):
 *   ~/.codex/AGENTS.md   — read by Codex in every session
 *   ~/.claude/CLAUDE.md  — read by Claude Code in every session
 * Cowork has no safely-writable global file; mounted-folder CLAUDE.md
 * (per-project init) covers it, or paste the block into Cowork's global
 * instructions by hand — `sbus init --global` prints it for copying.
 */
export function initGlobal(): { results: InitResult[]; coworkBlock: string } {
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex');
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
  const results = [
    writeBlock(path.join(codexHome, 'AGENTS.md'), GLOBAL_BLOCK),
    writeBlock(path.join(claudeHome, 'CLAUDE.md'), GLOBAL_BLOCK),
  ];
  return { results, coworkBlock: GLOBAL_BLOCK };
}

function writeBlock(file: string, block: string): InitResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, block + '\n', 'utf8');
    return { file, action: 'created' };
  }
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.includes(BEGIN)) {
    const updated = raw.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`), block);
    fs.writeFileSync(file, updated, 'utf8');
    return { file, action: 'updated' };
  }
  fs.writeFileSync(file, raw.trimEnd() + '\n\n' + block + '\n', 'utf8');
  return { file, action: 'appended' };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
