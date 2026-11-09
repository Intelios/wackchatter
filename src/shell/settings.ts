/**
 * The Settings tool's rules, pure so they are pinned by tests: its chapters, the settings the
 * island's search can open, what each connection serves, and how a connection and the last
 * backup read at a glance.
 */

import { MODEL_SLOTS, type ModelSlot, type ModelSlots, slotRef } from '@shared/models/slots.ts';
import { type Connection, PROVIDERS } from '@shared/providers/types.ts';
import type { KeyInfo } from '@shared/types/settings.ts';
import type { SettingsChapter } from '../app/useAppController.ts';
import type { IconName } from './icons.tsx';

export interface ChapterInfo {
  id: SettingsChapter;
  title: string;
  icon: IconName;
  lede: string;
}

export const SETTINGS_CHAPTERS: readonly ChapterInfo[] = [
  {
    id: 'connections',
    title: 'Connections',
    icon: 'plug',
    lede: 'Where replies come from. Set once; models are picked where they’re used.',
  },
  {
    id: 'look',
    title: 'Look',
    icon: 'brush',
    lede: 'How the app looks behind your story. Drag a slider and the margin steps aside.',
  },
  { id: 'text', title: 'Text', icon: 'lines', lede: 'What happens to text on its way in and out.' },
  {
    id: 'library',
    title: 'Library',
    icon: 'box',
    lede: 'Everything you’ve made, where it lives, and how it’s kept safe.',
  },
  { id: 'hood', title: 'Under the hood', icon: 'gear', lede: 'The machinery. Rarely touched.' },
];

export interface SettingEntry {
  /** What the tool marks the setting with (`data-setting`), and lights up when it's opened. */
  key: string;
  label: string;
  chapter: SettingsChapter;
  /** More words it answers to in search. */
  words?: string;
}

/** Every setting the island's search can open, in the order the tool shows them. */
export const SETTING_INDEX: readonly SettingEntry[] = [
  {
    key: 'new-connection',
    label: 'New connection',
    chapter: 'connections',
    words: 'api endpoint provider',
  },
  { key: 'background', label: 'Background', chapter: 'look', words: 'image wallpaper upload' },
  { key: 'blur', label: 'Blur', chapter: 'look', words: 'background' },
  { key: 'dim', label: 'Dim', chapter: 'look', words: 'background dark' },
  { key: 'glass', label: 'Glass surfaces', chapter: 'look', words: 'transparent' },
  {
    key: 'effect',
    label: 'Background effect',
    chapter: 'look',
    words: 'rain snow petals fireflies particles animated',
  },
  { key: 'dialogue', label: 'Dialogue colour', chapter: 'look', words: 'quotes color' },
  {
    key: 'reveal',
    label: 'Reveal replies',
    chapter: 'text',
    words: 'streaming stream whole finished written',
  },
  { key: 'regex', label: 'Regex scripts', chapter: 'text', words: 'find replace' },
  { key: 'hidden-tags', label: 'Hidden tags', chapter: 'text', words: 'cards' },
  { key: 'backup', label: 'Back up the library', chapter: 'library', words: 'backup zip export' },
  {
    key: 'deleted',
    label: 'Recently deleted',
    chapter: 'library',
    words: 'trash bin restore chats',
  },
  { key: 'location', label: 'Library location', chapter: 'library', words: 'data folder move' },
  { key: 'streaming', label: 'Streaming refresh rate', chapter: 'hood', words: 'fps' },
  { key: 'tokenizer', label: 'Token counter', chapter: 'hood', words: 'tokenizer' },
  { key: 'usage', label: 'Record usage for TokenTrail', chapter: 'hood', words: 'stats log' },
  { key: 'version', label: 'What’s new', chapter: 'hood', words: 'version update about' },
  { key: 'shutdown', label: 'Shut down WackChatter', chapter: 'hood', words: 'quit stop server' },
];

/** What each app-wide model slot is called on a connection's card. */
const SLOT_NAMES: Readonly<Record<ModelSlot, string>> = {
  chat: 'chat',
  summary: 'summary',
  nexus: 'memory',
  cocreator: 'co-creator',
  sideChat: 'side chat',
};

/** The app-wide models a connection serves today, including slots that follow chat. */
export function connectionUses(models: ModelSlots, connectionId: string): string[] {
  return MODEL_SLOTS.filter((slot) => slotRef(models, slot)?.connectionId === connectionId).map(
    (slot) => SLOT_NAMES[slot],
  );
}

export type ConnectionTest =
  | { state: 'busy' }
  | { state: 'ok'; ms: number; models: number }
  | { state: 'failed'; error: string };

export type ConnectionHealth = 'ok' | 'nokey' | 'failed';

/**
 * The dot on a connection's card: a failed test wins, then a missing key on a provider that
 * needs one. A key isn't proof it works, which is what the Test button is for.
 */
export function connectionHealth(
  connection: Connection,
  key: KeyInfo | undefined,
  test: ConnectionTest | undefined,
): ConnectionHealth {
  if (test?.state === 'failed') return 'failed';
  if (test?.state === 'ok') return 'ok';
  return PROVIDERS[connection.provider].requiresKey && !key?.present ? 'nokey' : 'ok';
}

/** The endpoint without its scheme, as the card shows it. */
export function endpointLabel(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** How long ago the last backup was made, in words. */
export function backupAge(lastBackupAt: string | null, now: number): string {
  if (!lastBackupAt) return 'No backup made from this app yet';
  const then = Date.parse(lastBackupAt);
  if (!Number.isFinite(then)) return 'No backup made from this app yet';
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 2) return 'Backed up just now';
  if (minutes < 60) return `Backed up ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Backed up ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Backed up yesterday';
  if (days < 60) return `Backed up ${days} days ago`;
  return `Backed up ${Math.round(days / 30)} months ago`;
}

/** A backup older than this is worth nudging about. */
export const STALE_BACKUP_DAYS = 14;

export function backupIsStale(lastBackupAt: string | null, now: number): boolean {
  if (!lastBackupAt) return true;
  const then = Date.parse(lastBackupAt);
  return !Number.isFinite(then) || now - then > STALE_BACKUP_DAYS * 86400000;
}
