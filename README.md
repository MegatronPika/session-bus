# session-bus

**Your AI conversations are project assets. Stop losing them when you switch apps.**

session-bus is a local-first "session bus" for AI agents: it discovers the session
logs that AI apps (OpenAI Codex, Claude Cowork, …) already write on your disk,
normalizes them into one canonical format organized **by project**, and serves
them back to *any* agent — as a distilled handoff document, or as an MCP server
the agent can query mid-task.

Start a project in Codex. Continue it in Claude Cowork. The new agent knows what
was said, what was decided, what's left to do — and can quote the original
conversation verbatim when it matters.

```
 Codex ~/.codex/sessions/*.jsonl ─┐                ┌─ HANDOFF.md   (cold-start injection)
 Cowork local sessions ──────────┼→ canonical store ┼─ MCP server   (on-demand retrieval:
 (more adapters coming) ─────────┘   ~/.sbus/        │   list_projects / list_sessions /
                                                     │   get_handoff / get_session /
                                                     └──  search_sessions)
```

## Why

Files are shared between your AI apps through the filesystem. The *process* —
why things were done, what was tried and rejected, what constraints you stated —
is locked inside each app's private session store. Switching apps (or starting a
new session on a newer model) resets that knowledge to zero. session-bus turns
the process into a portable asset.

Three design commitments:

1. **Local-first.** Nothing leaves your machine. The store is a derived cache on
   the same disk as the originals.
2. **Read-only adapters.** Native app directories are never written to. Zero
   risk to your apps, robust to their version changes.
3. **Reversible compression.** Handoff docs are distilled (brief/standard/full),
   but the verbatim history is always one MCP call away. Unlike in-app context
   compaction, nothing is ever unrecoverable.

## Install (dev preview)

```bash
git clone <repo> && cd session-bus
npm install
npm run dev -- scan        # ingest sessions (incremental, read-only)
npm run dev -- ls          # projects → sessions
npm run dev -- handoff <project> [--level brief|standard|full] [-o HANDOFF.md]
npm run dev -- search <query>
npm run dev -- mcp         # run the MCP server (stdio)
npm run dev -- setup codex|cowork|claude-code   # wiring instructions
```

## Connect your agents

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.session-bus]
command = "sbus"
args = ["mcp"]
```

**Claude Cowork / Claude Desktop** — `claude_desktop_config.json`:

```json
{ "mcpServers": { "session-bus": { "command": "sbus", "args": ["mcp"] } } }
```

Then just say: *"Pick up where Codex left off on this project."*

## Status

v0.1 (MVP): Codex adapter (validated on real-world data incl. 199 MB sessions,
compactions, multi-day sessions) · project-centric store · 3-level handoff ·
5-tool MCP server · secret redaction on egress.

Roadmap: Cowork adapter → Claude Code & Gemini CLI adapters → SessionStart-hook
auto-injection → watch mode → chat-app (ChatGPT/Claude.ai) export import →
(experimental) native-format write-back.

## Supported sources

| Source | Reads from | Status |
|---|---|---|
| OpenAI Codex (CLI/Desktop/IDE) | `~/.codex/sessions/**/rollout-*.jsonl` | ✅ |
| Claude Cowork | `…/Claude/local-agent-mode-sessions/**` (metadata + internal Claude-Code transcript; projects mapped from mounted folders) | ✅ |
| Claude Code | `~/.claude/projects/**.jsonl` (shares Cowork's parser) | planned (near-free) |
| Gemini CLI | `~/.gemini/tmp/**` | planned |

Notes: Codex `reasoning` items are encrypted by the vendor and are skipped.
`.jsonl.zst` rollouts are detected but not yet parsed (v0.2). Session formats
are undocumented and may change; parsers are deliberately lenient (unknown
fields ignored, bad lines counted, never fatal).

## Privacy

Sessions can contain secrets. session-bus never uploads anything; common
credential patterns (API keys, tokens, JWTs, private keys) are redacted from
everything that leaves the store (handoff files, MCP responses).

## License

MIT
