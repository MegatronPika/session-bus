/**
 * Egress redaction — applied to anything leaving the store
 * (handoff documents, MCP responses). The store itself stays verbatim:
 * it lives on the same disk as the originals, so redacting it adds nothing.
 */

const PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{20,}/g, 'sk-…REDACTED'],
  [/(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '$1_…REDACTED'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_…REDACTED'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA…REDACTED'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox…REDACTED'],
  [/Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, 'Bearer …REDACTED'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[JWT REDACTED]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}
