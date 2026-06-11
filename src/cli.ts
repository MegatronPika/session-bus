#!/usr/bin/env node
import { Command } from 'commander';

// exit quietly when stdout is closed early (e.g. `sbus ls | head`)
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});
import { scanAll, scanClaudeCode, scanCodex, scanCowork, shortProject } from './scan.js';
import { groupByProject, loadIndex, loadSession } from './store.js';
import { sbusHome } from './paths.js';

const program = new Command();
program
  .name('sbus')
  .description('session-bus — share AI agent sessions across apps, organized by project')
  .version('0.1.0');

program
  .command('scan')
  .description('discover & ingest sessions from supported apps (incremental)')
  .option('--codex-home <path>', 'override ~/.codex')
  .action(async (opts) => {
    console.log(`session-bus home: ${sbusHome()}`);
    console.log('scanning codex…');
    const rc = await scanCodex({ home: opts.codexHome });
    console.log('scanning cowork…');
    const rw = await scanCowork();
    console.log('scanning claude-code…');
    const rcc = await scanClaudeCode();
    for (const [name, r] of [['codex', rc], ['cowork', rw], ['claude-code', rcc]] as const) {
      console.log(
        `${name}: ${r.scanned} sessions — ${r.added} added, ${r.updated} updated, ${r.skipped} unchanged` +
        (r.zstSkipped ? `, ${r.zstSkipped} .zst skipped (v0.2)` : ''),
      );
      for (const f of r.failed) console.error(`  ✗ ${f.file}: ${f.error}`);
    }
  });

program
  .command('ls')
  .description('list projects, or sessions of one project (filter by substring)')
  .argument('[project]', 'project path substring')
  .action((projectFilter?: string) => {
    const idx = loadIndex();
    const groups = groupByProject(idx);
    if (groups.size === 0) {
      console.log('store is empty — run `sbus scan` first');
      return;
    }
    if (!projectFilter) {
      const rows = [...groups.entries()].sort(
        (a, b) => lastActivity(b[1]).localeCompare(lastActivity(a[1])),
      );
      console.log('PROJECT'.padEnd(44) + 'SESSIONS  LAST ACTIVITY');
      for (const [project, entries] of rows) {
        console.log(shortProject(project).padEnd(44) + String(entries.length).padEnd(10) + lastActivity(entries).slice(0, 10));
      }
      return;
    }
    const hits = [...groups.entries()].filter(([p]) => p.toLowerCase().includes(projectFilter.toLowerCase()));
    if (hits.length === 0) {
      console.log(`no project matching "${projectFilter}"`);
      return;
    }
    for (const [project, entries] of hits) {
      console.log(`\n${project}`);
      for (const e of entries) {
        console.log(
          `  ${e.id}  ${(e.startedAt ?? '').slice(0, 16).replace('T', ' ')}  [${e.source}]  ` +
          `${String(e.userMsgs).padStart(3)} msgs  "${e.title}"`,
        );
      }
    }
  });

program
  .command('show')
  .description('render one session (id or unique prefix)')
  .argument('<id>')
  .option('-n, --limit <n>', 'max events to print', '60')
  .option('--all', 'print all events')
  .option('--types <list>', 'comma-separated event types to include')
  .action((id: string, opts) => {
    const s = loadSession(id);
    if (!s) {
      console.error(`session "${id}" not found (or ambiguous prefix) — try \`sbus ls\``);
      process.exitCode = 1;
      return;
    }
    const { meta } = s;
    console.log(`# ${meta.id} — ${meta.title}`);
    console.log(`project: ${meta.project}`);
    console.log(`source:  ${meta.source} (${meta.originator ?? '?'} ${meta.agentVersion ?? ''})  file: ${meta.sourcePath}`);
    console.log(`span:    ${meta.startedAt} → ${meta.endedAt}`);
    console.log(
      `counts:  ${meta.counts.events} events | ${meta.counts.userMsgs} user | ${meta.counts.assistantMsgs} assistant | ` +
      `${meta.counts.toolCalls} tools | ${meta.counts.compactions} compactions | ${meta.counts.badLines} bad lines`,
    );
    if (meta.usage?.totalTokens) console.log(`tokens:  ${meta.usage.totalTokens} total (window ${meta.usage.contextWindow ?? '?'})`);
    if (meta.filesTouched.length) console.log(`files:   ${meta.filesTouched.length} touched`);
    console.log('');

    const want = opts.types ? new Set(String(opts.types).split(',')) : null;
    const events = s.events.filter((e) => (want ? want.has(e.type) : true));
    const limit = opts.all ? events.length : Number(opts.limit);
    for (const e of events.slice(0, limit)) {
      const ts = e.ts ? e.ts.slice(11, 19) : '--:--:--';
      const head = `[${ts}] ${e.role.padEnd(9)} ${e.type.padEnd(11)}`;
      if (e.type === 'tool_call') console.log(`${head} ${e.tool?.name}: ${oneLine(e.tool?.input ?? '', 120)}`);
      else if (e.type === 'file_change') console.log(`${head} ${(e.files ?? []).join(', ')}`);
      else console.log(`${head} ${oneLine(e.text ?? '', 160)}`);
    }
    if (events.length > limit) console.log(`… ${events.length - limit} more events (use --all)`);
  });

program
  .command('handoff')
  .description('distill a project\'s full cross-app timeline into a handoff document')
  .argument('<project>', 'project path or substring')
  .option('-l, --level <level>', 'brief | standard | full', 'standard')
  .option('-o, --out <file>', 'write to file instead of stdout (e.g. HANDOFF.md in the project dir)')
  .action(async (project: string, opts) => {
    await scanAll({ quiet: true }); // lazy refresh
    const { generateHandoff } = await import('./handoff.js');
    const doc = generateHandoff(project, opts.level);
    if (!doc) {
      console.error(`no project matching "${project}" — try \`sbus ls\``);
      process.exitCode = 1;
      return;
    }
    if (opts.out) {
      const fs = await import('node:fs');
      fs.writeFileSync(opts.out, doc, 'utf8');
      console.log(`handoff written to ${opts.out}`);
    } else {
      console.log(doc);
    }
  });

program
  .command('search')
  .description('full-text search across all recorded sessions')
  .argument('<query>')
  .option('-p, --project <p>', 'restrict to a project (substring)')
  .option('-n, --limit <n>', 'max hits', '20')
  .action(async (query: string, opts) => {
    await scanAll({ quiet: true });
    const { searchSessions } = await import('./search.js');
    const hits = searchSessions(query, { project: opts.project, limit: Number(opts.limit) });
    if (hits.length === 0) {
      console.log(`no matches for "${query}"`);
      return;
    }
    for (const h of hits) {
      console.log(`${h.sessionId} [${h.role} @${h.eventIndex}] ${(h.ts ?? '').slice(0, 16)}\n  ${h.snippet}\n`);
    }
  });

program
  .command('mcp')
  .description('run the session-bus MCP server (stdio) — connect Codex, Cowork, Claude Code, …')
  .action(async () => {
    const { runMcpServer } = await import('./mcp.js');
    await runMcpServer();
  });

program
  .command('init')
  .description('make session-bus auto-trigger in a project: write an ambient instruction block into AGENTS.md + CLAUDE.md (idempotent)')
  .argument('[dir]', 'project directory', '.')
  .action(async (dir: string) => {
    const { initProject } = await import('./init.js');
    try {
      for (const r of initProject(dir)) console.log(`  ${r.action}: ${r.file}`);
      console.log('→ agents in this project will now consult session-bus without being told by name.');
    } catch (err) {
      console.error(String(err));
      process.exitCode = 1;
    }
  });

program
  .command('setup')
  .description('print (or with --apply, write) MCP wiring for an app')
  .argument('<app>', 'codex | cowork | claude-code')
  .option('--apply', 'edit the app config file directly (backs up the original to *.bak)')
  .action(async (app: string, opts: { apply?: boolean }) => {
    if (opts.apply) {
      const { applySetup } = await import('./setup.js');
      try {
        const msg = await applySetup(app);
        console.log(msg);
      } catch (err) {
        console.error(String(err));
        process.exitCode = 1;
      }
      return;
    }
    // GUI apps (Claude Desktop) don't inherit your shell PATH — use absolute paths.
    const { fileURLToPath } = await import('node:url');
    const self = fileURLToPath(import.meta.url);
    const isTs = self.endsWith('.ts');
    const node = process.execPath;
    const command = isTs ? 'npx' : node;
    const argsToml = isTs ? `"tsx", "${self}", "mcp"` : `"${self}", "mcp"`;
    const argsJson = isTs ? `"tsx", "${self}", "mcp"` : `"${self}", "mcp"`;
    const snippets: Record<string, string> = {
      codex: `# ~/.codex/config.toml 中追加:
[mcp_servers.session-bus]
command = "${command}"
args = [${argsToml}]

# 可选:在项目 AGENTS.md 中加一行,让 agent 主动用:
# "This project has cross-app session history. Before continuing prior work, call the session-bus MCP tool get_handoff."`,
      cowork: `# Claude Desktop (Cowork) — claude_desktop_config.json 的 mcpServers 中追加:
{
  "mcpServers": {
    "session-bus": { "command": "${command}", "args": [${argsJson}] }
  }
}
# 配置文件位置 (macOS): ~/Library/Application Support/Claude/claude_desktop_config.json
# 重启 Claude Desktop 后,Cowork 会话即可调用 session-bus 工具。`,
      'claude-code': `# 终端执行:
claude mcp add session-bus -- ${isTs ? `npx tsx ${self}` : `${node} ${self}`} mcp`,
    };
    console.log(snippets[app] ?? `unknown app "${app}" — supported: codex, cowork, claude-code`);
  });

function lastActivity(entries: { endedAt: string | null }[]): string {
  return entries.reduce((acc, e) => ((e.endedAt ?? '') > acc ? e.endedAt! : acc), '');
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

program.parseAsync();
