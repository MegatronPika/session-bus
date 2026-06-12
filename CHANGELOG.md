# Changelog

## v0.2.0 (unreleased)

- **Claude Code adapter** — standalone `~/.claude/projects` sessions, sharing the
  Cowork transcript parser; project attribution from per-line `cwd`, git branches captured
- **`sbus init --global`** — one-shot ambient trigger via `~/.codex/AGENTS.md` +
  `~/.claude/CLAUDE.md`; field-tested: agents call `get_handoff` unprompted
- **MCP pre-warm** — initial scan starts at server startup; queries during the
  warm-up are served from the existing index with a "refreshing" note
- **Advisory-session downweighting** — pure Q&A sessions (no file changes) are
  tagged on the timeline and excluded from "latest state" extraction in handoffs
- **`.jsonl.zst` support** — archived Codex rollouts, via pure-JS fzstd (zero native deps)
- **Token-budget fixes** — `brief` handoff tightened (~2k tokens); MCP `get_handoff`
  caps responses at 50k chars and points to file export for `full`
- **Windows/Linux path tables** (experimental — community testing welcome)
- **docs/FORMAT-DECISIONS.md** — living decision log for the canonical format
- Privacy: generic examples in code/docs; egress redaction unchanged

## v0.1.0

- Codex (CLI/Desktop/IDE) + Claude Cowork adapters → canonical JSONL store,
  organized by project, incremental scan, read-only on native dirs
- 3-level handoff distillation (brief / standard / full)
- MCP server: `list_projects`, `list_sessions`, `get_session`, `search_sessions`,
  `get_handoff` (lazy incremental refresh before every query)
- `sbus setup <app> --apply` — one-command MCP wiring with config backup
- `sbus init` — per-project ambient trigger block (AGENTS.md + CLAUDE.md)
- Secret redaction on egress (API keys, tokens, JWTs, private keys)
- Bilingual README (EN / 简体中文)
- Validated on real data: 60+ sessions, a 199 MB rollout, context compactions,
  multi-day sessions; bidirectional acceptance test passed (Cowork ⇄ Codex)
