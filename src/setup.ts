import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `sbus setup <app> --apply` — register the session-bus MCP server in the
 * app's own config file, so the agent actually gets the tools.
 *
 * Always: absolute paths (GUI apps don't inherit shell PATH), backup to *.bak,
 * idempotent (re-running updates the same entry).
 */

function selfCommand(): { command: string; args: string[] } {
  const self = fileURLToPath(import.meta.url); // …/dist/setup.js or …/src/setup.ts
  const cliJs = path.join(path.dirname(self), self.endsWith('.ts') ? 'cli.ts' : 'cli.js');
  if (self.endsWith('.ts')) return { command: 'npx', args: ['tsx', cliJs, 'mcp'] };
  return { command: process.execPath, args: [cliJs, 'mcp'] };
}

export async function applySetup(app: string): Promise<string> {
  switch (app) {
    case 'cowork':
      return applyCowork();
    case 'codex':
      return applyCodex();
    case 'claude-code':
      return '`claude mcp add` manages its own config — run:\n  claude mcp add session-bus -- ' +
        [selfCommand().command, ...selfCommand().args].join(' ');
    default:
      throw new Error(`unknown app "${app}" — supported: codex, cowork, claude-code`);
  }
}

function claudeDesktopConfigPath(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  throw new Error('Claude Desktop is not available on this platform');
}

function applyCowork(): string {
  const file = claudeDesktopConfigPath();
  let config: any = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      config = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`${file} is not valid JSON — fix it manually first (no changes made)`);
    }
    fs.copyFileSync(file, `${file}.bak`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers['session-bus'] = selfCommand();
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return `✓ registered session-bus in ${file}\n  (backup: ${file}.bak)\n→ 完全退出并重启 Claude Desktop 后生效。`;
}

function applyCodex(): string {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const file = path.join(home, 'config.toml');
  const { command, args } = selfCommand();
  const block =
    `\n# added by sbus setup codex --apply\n[mcp_servers.session-bus]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map((a) => JSON.stringify(a)).join(', ')}]\n`;

  let raw = '';
  if (fs.existsSync(file)) {
    raw = fs.readFileSync(file, 'utf8');
    fs.copyFileSync(file, `${file}.bak`);
  } else {
    fs.mkdirSync(home, { recursive: true });
  }
  if (/^\[mcp_servers\.session-bus\]/m.test(raw)) {
    // idempotent update: replace the existing block (up to the next table header or EOF)
    raw = raw.replace(
      /\n?# added by sbus setup codex --apply\n\[mcp_servers\.session-bus\][\s\S]*?(?=\n\[|$)/,
      block,
    );
    if (!/^\[mcp_servers\.session-bus\]/m.test(raw)) raw += block; // fallback if pattern missed
    fs.writeFileSync(file, raw, 'utf8');
  } else {
    fs.writeFileSync(file, raw + block, 'utf8');
  }
  return `✓ registered session-bus in ${file}\n  (backup: ${file}.bak)\n→ 重启 Codex(桌面端/新 CLI 会话)后生效。`;
}
