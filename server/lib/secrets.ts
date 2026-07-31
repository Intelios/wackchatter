/**
 * API key storage.
 *
 * Keys live here and nowhere else: not in settings.json, not in a preset, and never in a
 * response body. The client is told only whether a key is present and its last four
 * characters, which is enough to render "configured" state without the value ever
 * reaching the browser.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ProviderId } from '../../shared/providers/types.ts';
import { PROVIDER_IDS } from '../../shared/providers/types.ts';
import { PATHS } from './paths.ts';

export interface KeyInfo {
  present: boolean;
  /** Last four characters, for recognising which key is configured. */
  hint: string;
}

type SecretsFile = Partial<Record<ProviderId, string>>;

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

export function getApiKey(provider: ProviderId): string | null {
  return read()[provider]?.trim() || null;
}

export function setApiKey(provider: ProviderId, key: string | null): void {
  const secrets = read();
  const trimmed = key?.trim();

  if (trimmed) secrets[provider] = trimmed;
  else delete secrets[provider];

  write(secrets);
}

/** The only shape of key information allowed to cross the wire. */
export function describeKeys(): Record<ProviderId, KeyInfo> {
  const secrets = read();
  const result = {} as Record<ProviderId, KeyInfo>;

  for (const provider of PROVIDER_IDS) {
    const key = secrets[provider]?.trim();
    result[provider] = { present: Boolean(key), hint: key ? key.slice(-4) : '' };
  }

  return result;
}
