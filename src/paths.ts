import os from 'node:os';
import path from 'node:path';

/**
 * Per-OS candidate paths for every supported app.
 * Windows/Linux entries are designed in from day one (v0.1 is validated on macOS).
 */

export function sbusHome(): string {
  return process.env.SBUS_HOME ?? path.join(os.homedir(), '.sbus');
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

/** Roots that may contain Cowork local session data, most-likely first. */
export function coworkRoots(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return [path.join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')];
    case 'win32': {
      const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
      return [path.join(appData, 'Claude', 'local-agent-mode-sessions')];
    }
    default:
      return []; // no Cowork client on Linux (as of 2026-06)
  }
}
