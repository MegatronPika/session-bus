# session-bus

[![npm](https://img.shields.io/npm/v/session-bus)](https://www.npmjs.com/package/session-bus)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**English** | [简体中文](./README.zh-CN.md)

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

## Install

```bash
npm install -g session-bus

sbus scan          # ingest sessions (incremental, read-only)
sbus ls            # projects → sessions
sbus handoff <project> [--level brief|standard|full] [-o HANDOFF.md]
sbus search <query>
sbus mcp           # run the MCP server (stdio)
```

From source: `git clone https://github.com/MegatronPika/session-bus && cd session-bus && npm install && npm run build && npm link`

## Connect your agents

One command per app — it edits the app's config for you (with a `*.bak` backup),
using absolute paths so GUI apps find it without your shell PATH:

```bash
sbus setup cowork --apply   # Claude Cowork / Claude Desktop, then fully restart the app
sbus setup codex --apply    # Codex CLI/Desktop/IDE
sbus setup claude-code      # prints the `claude mcp add` command
```

(Or drop `--apply` to just print the snippet and edit configs yourself.)

## Make it automatic (recommended)

Connecting the MCP server gives agents the *ability* to consult history — but agents
only act on what's in front of them, and won't reach for session-bus unprompted.
`init` fixes that per project:

```bash
cd /path/to/your/project
sbus init        # writes a fenced instruction block into AGENTS.md + CLAUDE.md (idempotent)
```

AGENTS.md is read natively by Codex (and Cursor/Copilot/Roo); CLAUDE.md by Claude Code
and by Cowork for mounted folders. After `init`, you can just say
*"pick up where the other tool left off"* — no need to mention session-bus by name.

Or cover **all projects at once** via the per-app global instruction files
(`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`):

```bash
sbus init --global
```

Per-project `init` is still worth it for repos you share — the block travels
with the repo, so teammates' agents get the hint too. (Cowork has no
safely-writable global file; per-project covers it, or paste the printed block
into Claude Desktop's global instructions.)

## Status

v0.1 (MVP), acceptance-tested both ways on real data: a Cowork session cold-started
from a Codex project via `get_handoff` and continued the work without re-asking the
user; a Codex session answered "what did Cowork do after taking over?" precisely via
MCP. Validated against 60+ real sessions incl. a 199 MB rollout, context
compactions, and multi-day sessions.

Core pieces: Codex + Cowork adapters · project-centric store · 3-level handoff ·
5-tool MCP server (lazy incremental refresh) · secret redaction on egress ·
one-command setup (`--apply`).

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
