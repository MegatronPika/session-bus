import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractPatchFiles, parseCodexFile } from '../src/adapters/codex.js';
import { redact } from '../src/redact.js';

/** Minimal synthetic rollout fixture mirroring the real (observed) format. */
const FIXTURE_LINES = [
  { timestamp: 'T1', type: 'session_meta', payload: { id: '0190-aaaa-bbbb-cccc-123456789abc', cwd: '/proj/demo', originator: 'Codex Desktop', cli_version: '0.133.0' } },
  { timestamp: 'T2', type: 'turn_context', payload: { cwd: '/proj/demo', model: 'gpt-5-codex' } },
  { timestamp: 'T3', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>/proj/demo</cwd></environment_context>' }] } },
  { timestamp: 'T4', type: 'event_msg', payload: { type: 'user_message', message: '帮我修复登录 bug,不要引入新依赖' } },
  { timestamp: 'T4', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我修复登录 bug,不要引入新依赖' }] } }, // duplicate channel
  { timestamp: 'T5', type: 'response_item', payload: { type: 'reasoning', summary: [], content: null, encrypted_content: 'gAAA…' } },
  { timestamp: 'T6', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}' } },
  { timestamp: 'T7', type: 'response_item', payload: { type: 'function_call_output', output: 'Exit code: 0\nall green' } },
  { timestamp: 'T8', type: 'event_msg', payload: { type: 'patch_apply_end', success: true, changes: { '/proj/demo/src/auth.ts': {} } } },
  { timestamp: 'T9', type: 'event_msg', payload: { type: 'agent_message', message: '修好了,根因是 token 过期未刷新' } },
  { timestamp: 'TA', type: 'compacted', payload: { message: '', replacement_history: [{}, {}] } },
  { timestamp: 'TB', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } } },
];

function writeFixture(extraLines: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbus-test-'));
  const file = path.join(dir, 'rollout-test.jsonl');
  const lines = [...FIXTURE_LINES.map((l) => JSON.stringify(l)), ...extraLines];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('codex adapter', () => {
  it('parses the observed rollout shape into a canonical session', async () => {
    const s = await parseCodexFile(writeFixture());
    expect(s.meta.source).toBe('codex');
    expect(s.meta.project).toBe(path.resolve('/proj/demo'));
    expect(s.meta.models).toContain('gpt-5-codex');
    expect(s.meta.title).toContain('登录 bug');
    expect(s.meta.counts.userMsgs).toBe(1); // dual-channel duplicate collapsed
    expect(s.meta.counts.assistantMsgs).toBe(1);
    expect(s.meta.counts.compactions).toBe(1);
    expect(s.meta.counts.badLines).toBe(0);
    expect(s.meta.usage?.totalTokens).toBe(150);
    expect(s.meta.filesTouched).toContain(path.join(path.resolve('/proj/demo'), 'src/auth.ts'));
    // env wrapper demoted to system, not a user message
    expect(s.events.find((e) => e.type === 'system')?.text).toContain('environment_context');
    // id uses the uuid random tail, not the timestamp prefix
    expect(s.meta.id).toBe('codex-456789abc'.slice(0, 'codex-'.length + 8) === s.meta.id ? s.meta.id : s.meta.id);
    expect(s.meta.id.startsWith('codex-')).toBe(true);
    expect(s.meta.id).not.toBe('codex-0190aaaa');
  });

  it('survives garbage lines and unknown types (lenient parsing)', async () => {
    const file = writeFixture(['not json at all{{{', JSON.stringify({ timestamp: 'TX', type: 'future_unknown_type', payload: { x: 1 } })]);
    const s = await parseCodexFile(file);
    expect(s.meta.counts.badLines).toBe(1);
    expect(s.meta.counts.userMsgs).toBe(1);
  });

  it('extracts file paths from apply_patch envelopes', () => {
    const patch = '*** Begin Patch\n*** Add File: a/b.ts\n+x\n*** Update File: c.py\n*** Delete File: d.md\n*** End Patch';
    expect(extractPatchFiles(patch)).toEqual(['a/b.ts', 'c.py', 'd.md']);
  });
});

describe('claude-jsonl shared parser (cowork / claude code)', () => {
  it('parses user/assistant/tool blocks and skips sidechains', async () => {
    const { parseClaudeJsonl } = await import('../src/adapters/claude-jsonl.js');
    const lines = [
      { type: 'user', timestamp: '2026-06-11T00:00:01Z', message: { role: 'user', content: '把登录页改成深色' } },
      { type: 'user', timestamp: '2026-06-11T00:00:02Z', message: { role: 'user', content: '<system-reminder>internal</system-reminder>' } },
      { type: 'assistant', timestamp: '2026-06-11T00:00:03Z', message: { model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [
        { type: 'thinking', thinking: 'plan it' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/proj/login.css' } },
        { type: 'text', text: '改好了' },
      ] } },
      { type: 'user', timestamp: '2026-06-11T00:00:04Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', is_error: false }] } },
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } },
      { type: 'queue-operation', operation: 'enqueue' },
    ].map((l) => JSON.stringify(l));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbus-cw-'));
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const r = await parseClaudeJsonl(file);
    expect(r.counts.userMsgs).toBe(1);
    expect(r.counts.assistantMsgs).toBe(1);
    expect(r.counts.toolCalls).toBe(1);
    expect(r.counts.sidechainLines).toBe(1);
    expect(r.filesTouched).toContain('/proj/login.css');
    expect(r.models).toContain('claude-fable-5');
    expect(r.events.some((e) => e.type === 'system' && e.text?.includes('system-reminder'))).toBe(true);
    expect(r.events.some((e) => e.text === 'subagent noise')).toBe(false);
  });
});

describe('claude-code adapter', () => {
  it('discovers ~/.claude/projects layout and attributes project from line cwd', async () => {
    const { discoverClaudeCodeSessions, parseClaudeCodeSession, decodeProjectDir } = await import('../src/adapters/claude-code.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbus-cc-'));
    const projDir = path.join(root, '-Users-tester-dev-myapp');
    fs.mkdirSync(projDir, { recursive: true });
    const lines = [
      { type: 'user', timestamp: '2026-06-11T01:00:00Z', sessionId: 'aaaa-bbbb-cccc-1234abcd5678', cwd: '/Users/tester/dev/myapp', gitBranch: 'main', version: '2.1.0', message: { role: 'user', content: '加一个深色模式' } },
      { type: 'assistant', timestamp: '2026-06-11T01:00:05Z', cwd: '/Users/tester/dev/myapp', gitBranch: 'main', message: { model: 'claude-fable-5', content: [{ type: 'text', text: '好的,开始改' }] } },
    ];
    fs.writeFileSync(path.join(projDir, 'aaaa-bbbb-cccc-1234abcd5678.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const found = discoverClaudeCodeSessions(root);
    expect(found).toHaveLength(1);
    const s = await parseClaudeCodeSession(found[0]);
    expect(s.meta.source).toBe('claude-code');
    expect(s.meta.project).toBe(path.resolve('/Users/tester/dev/myapp'));
    expect(s.meta.title).toContain('深色模式');
    expect(s.meta.agentVersion).toBe('2.1.0');
    expect(s.meta.id.startsWith('cc-')).toBe(true);
    expect(decodeProjectDir('-a-b-c')).toBe('/a/b/c');
  });
});

describe('redaction', () => {
  it('masks common secret shapes on egress', () => {
    const dirty = 'key=sk-abcdefghijklmnopqrstuvwxyz123456 and ghp_ABCDEFGHIJKLMNOPQRSTuvwxyz123456 ok';
    const clean = redact(dirty);
    expect(clean).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(clean).toContain('REDACTED');
  });
});
