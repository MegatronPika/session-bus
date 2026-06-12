# Canonical Format — Decision Log

Every implementation choice about the canonical session format IS a de-facto
standards decision, whether we announce it or not. This log records each one
(decision · rationale · implications) as it is made. The future SPEC.md will be
a compilation of this log, not an invention.

Format: one entry per decision, newest last. Status: `active` | `superseded by #N`.

---

## #1 · Carrier: UTF-8 JSONL, meta line first — `active`

**Decision**: a canonical session is one JSONL file; line 1 is `CanonicalMeta`,
every following line one `CanonicalEvent`.
**Why**: streaming parse for huge sessions; append-friendly; a corrupt line
loses one event, not the file (vs one big JSON).
**Implies**: consumers must tolerate trailing partial lines.

## #2 · Schema versioning: integer `schema` field in meta — `active`

**Decision**: `schema: 1` now; breaking changes bump the integer; consumers
reject schemas newer than they know.
**Why**: cheapest possible compatibility contract.

## #3 · Role × type vocabulary — `active`

**Decision**: `role ∈ user|assistant|system|tool`;
`type ∈ message|thinking|tool_call|tool_result|file_change|search|compaction|system`.
**Why**: the minimal set that survived mapping two very different native
formats (Codex rollouts, Claude-style transcripts) without loss of meaning.
**Implies**: new native event kinds map into these; only add vocabulary when
two+ sources need it.

## #4 · Lenient parsing as a contract — `active`

**Decision**: producers (adapters) skip-and-count bad lines (`counts.badLines`),
ignore unknown native fields; consumers ignore unknown canonical fields.
**Why**: native formats are undocumented and change without notice; the format
must survive the format-chase.
**Implies**: forward compatibility by default; never throw on unknown.

## #5 · Loss must be explicit: truncation markers + source pointer — `active`

**Decision**: any digested content carries a visible marker
(`…[+N chars, see srcLine]`) and every event keeps `srcLine` pointing into
`meta.sourcePath` (the untouched native file).
**Why**: "compressed but recoverable" is the core promise; silent loss is the
one unforgivable sin in an interchange format.
**Implies**: original files are the ground truth; the canonical store is a
derived, disposable cache.

## #6 · Provenance is mandatory — `active`

**Decision**: meta must carry `source` (app), `sourceSessionId`, `sourcePath`.
**Why**: auditability and round-trip; an event you can't trace is hearsay.

## #7 · User/assistant text verbatim; tool I/O digested — `active`

**Decision**: human + assistant natural-language messages are never truncated
in the store; tool inputs/outputs are capped (400/600 chars) with #5 markers.
**Why**: the conversation is the asset; tool output is bulk that's recoverable
from source (#5).

## #8 · Thinking is best-effort, never required — `active`

**Decision**: `thinking` events exist only when the source exposes readable
reasoning (Codex encrypts it; Claude transcripts sometimes include it);
distillation ignores them by default.
**Why**: cannot promise what vendors encrypt; decisions show up in messages
and actions anyway.

## #9 · Distillation (handoff) is an application, NOT part of the format — `active`

**Decision**: the interchange format only defines lossless-or-marked exchange;
handoff levels (brief/standard/full) are a session-bus feature layered on top.
**Why**: keeps the standard small enough to live; everyone can build their own
distillers on the same format.

## #10 · Anchor generalization (planned, schema 2) — `active`

**Decision**: today `project: string` (a directory path). Schema 2 introduces
`anchor: { type: "project-dir" | "topic" | "channel" | "persona", key: string }`,
with `project` kept as an alias during migration.
**Why**: "project" is one instance of a general concept; chat conversations
anchor to topics, personal-agent sessions to channels/personas. Deciding early
is cheap; retrofitting a shipped store is not.
**Status**: design committed (v0.3 dual-write, v0.4 first non-project anchors).

## #11 · Redaction must be visible — `active`

**Decision**: egress redaction replaces secrets with typed placeholders
(`sk-…REDACTED`, `[JWT REDACTED]`) rather than deleting them.
**Why**: a consumer must distinguish "there was a secret here" from "there was
nothing"; invisible redaction corrupts meaning.

## #12 · Container compression is transport, not semantics — `active`

**Decision**: .zst/.gz wrap files in transit/storage; the logical format is
always the uncompressed JSONL. Semantic compression is #9's territory.
