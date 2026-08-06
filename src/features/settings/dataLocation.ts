/**
 * What the data-location panel says about a chosen folder.
 *
 * Pure, and separate from the component for the same reason buildChatMenu is: there is no
 * DOM test harness here, so the branching that decides what the user is told has to be
 * testable on its own.
 */

import type { LocationInfo, LocationVerdict } from '@shared/types/location.ts';

export interface VerdictDescription {
  /** The button label. Reads as a statement of what will happen, not a question. */
  label: string;
  tone: 'neutral' | 'warn' | 'danger';
  /** Lines under the field, most important first. */
  detail: string[];
  /** Non-null means the action is unavailable, and this says why. */
  disabledReason: string | null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "3 characters", "1 character" — the panel says these often enough to be worth getting right. */
function count(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

export function describeCurrent(info: LocationInfo): string[] {
  const detail: string[] = [];

  if (info.source === 'env') detail.push('Set by WC_DATA_DIR.');
  else if (info.source === 'pointer') detail.push('Custom folder.');
  else detail.push('Default folder.');

  if (info.size) {
    detail.push(`${formatBytes(info.size.bytes)} · ${count(info.size.files, 'file')}`);
  }
  return detail;
}

/**
 * Blocking conditions, in the order the user can act on them. Every disabled control names
 * its reason rather than sitting there greyed out and unexplained.
 */
function blockedBy(info: LocationInfo, busy: boolean, unsavedPreset: boolean): string | null {
  if (info.needsRestart) return info.needsRestart;
  if (info.envLocked) {
    return 'WC_DATA_DIR pins this folder. Unset it and restart to change it here.';
  }
  if (busy) return 'Already moving.';
  if (unsavedPreset) return 'Save or revert your preset first — the app reloads after a move.';
  return null;
}

export function describeVerdict(
  verdict: LocationVerdict,
  info: LocationInfo,
  options: { busy?: boolean; unsavedPreset?: boolean } = {},
): VerdictDescription {
  const disabledReason = blockedBy(info, options.busy ?? false, options.unsavedPreset ?? false);

  if (!verdict.ok) {
    return {
      label: 'Move here',
      tone: 'danger',
      detail: [verdict.message],
      disabledReason: verdict.message,
    };
  }

  if (verdict.kind === 'same') {
    return {
      label: 'Move here',
      tone: 'neutral',
      detail: ['Already using this folder.'],
      disabledReason: 'Already using this folder.',
    };
  }

  const detail: string[] = [];
  let label: string;

  if (verdict.kind === 'library') {
    label = 'Use the library already here';
    const stats = verdict.library;
    if (stats) {
      const parts = [count(stats.characters, 'character')];
      if (stats.presets > 0) parts.push(count(stats.presets, 'preset'));
      if (stats.lorebooks > 0) parts.push(count(stats.lorebooks, 'lorebook'));
      if (!stats.hasChats) parts.push('no chats yet');
      detail.push(`A WackChatter library: ${parts.join(' · ')}.`);
      if (stats.modified) {
        detail.push(`Last changed ${new Date(stats.modified).toLocaleDateString()}.`);
      }
    }
    detail.push('Nothing is moved — your current folder is left exactly as it is.');
  } else {
    label = 'Move here';
    detail.push('Empty folder. Your library will be moved into it.');
    detail.push(
      verdict.sameDevice
        ? 'Same disk, so this is instant.'
        : 'A different disk, so everything is copied — this can take a minute.',
    );
    if (!verdict.sameDevice) {
      detail.push('Your old folder is kept until you delete it yourself.');
    }
  }

  // Warnings come last in construction but first in importance, so they go on top.
  const warnings = verdict.warnings.map((warning) => warning.message);
  const tone = warnings.length > 0 ? 'warn' : 'neutral';
  if (warnings.length > 0) label = `${label} anyway`;

  return { label, tone, detail: [...warnings, ...detail], disabledReason };
}
