/**
 * API key storage.
 *
 * Keys live here and nowhere else: not in settings.json, not in a preset, and never in a
 * response body. The client is told only whether a key is present and its last four
 * characters, which is enough to render "configured" state without the value ever
 * reaching the browser.
 *
 * Keys are stored per connection, keyed by the connection's opaque id. Two connections
 * to the same provider are two separate keys; deleting a connection deletes its key.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PATHS } from './paths.ts';

export interface KeyInfo {
  present: boolean;
  /** Last four characters, for recognising which key is configured. */
  hint: string;
}

type SecretsFile = Record<string, string>;

function read(): SecretsFile {
  if (!existsSync(PATHS.secrets)) return {};
  try {
    const parsed = JSON.parse(readFileSync(PATHS.secrets, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SecretsFile) : {};
  } catch {
    // A corrupt secrets file must not take the server down; the user re-enters the key.
    console.error('[wackchatter] secrets.json is unreadable — treating it as empty.');
    return {};
  }
}

function write(secrets: SecretsFile): void {
  writeFileSync(PATHS.secrets, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  // Re-applied explicitly: the mode option only takes effect when creating the file.
  chmodSync(PATHS.secrets, 0o600);
}

export function getApiKey(connectionId: string): string | null {
  return read()[connectionId]?.trim() || null;
}

export function setApiKey(connectionId: string, key: string | null): void {
  const secrets = read();
  const trimmed = key?.trim();

  if (trimmed) secrets[connectionId] = trimmed;
  else delete secrets[connectionId];

  write(secrets);
}

/** The only shape of key information allowed to cross the wire. */
export function describeKeys(connectionIds: string[]): Record<string, KeyInfo> {
  const secrets = read();
  const result: Record<string, KeyInfo> = {};

  for (const id of connectionIds) {
    const key = secrets[id]?.trim();
    result[id] = { present: Boolean(key), hint: key ? key.slice(-4) : '' };
  }

  return result;
}

/**
 * Drop keys whose connection no longer exists. Called after every settings save, so a
 * deleted connection takes its key with it — a key with no connection is a key that can
 * only ever leak.
 */
export function pruneApiKeys(connectionIds: string[]): void {
  const secrets = read();
  const valid = new Set(connectionIds);
  const entries = Object.entries(secrets);
  if (entries.every(([id]) => valid.has(id))) return;

  write(Object.fromEntries(entries.filter(([id]) => valid.has(id))));
}

/** One-time rename for the legacy provider-keyed format. No-op when `from` has no key. */
export function rekeyApiKey(from: string, to: string): void {
  const secrets = read();
  const key = secrets[from];
  if (key === undefined) return;

  delete secrets[from];
  secrets[to] = key;
  write(secrets);
}
