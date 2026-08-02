/**
 * Persistent guide list edits.
 *
 * Pure and separate from the popover for the same reason `buildChatMenu` is separate from
 * `ChatMenu`: there is no DOM harness in this project, so the logic worth testing has to
 * live somewhere a test can reach it.
 *
 * Every function returns a new array. `chat/metadata` is a shallow merge that bumps the
 * chat revision, so an in-place edit would neither persist nor re-render.
 */

import type { PersistentGuide } from '@shared/types/chat.ts';

/** The lowest free `Guide N`, so deleting the middle one and adding does not collide. */
export function nextGuideName(guides: PersistentGuide[]): string {
  const taken = new Set(
    guides
      .map((guide) => /^Guide (\d+)$/.exec(guide.name)?.[1])
      .filter((n): n is string => n !== undefined),
  );

  let n = 1;
  while (taken.has(String(n))) n += 1;
  return `Guide ${n}`;
}

export function addGuide(guides: PersistentGuide[], id: string): PersistentGuide[] {
  return [...guides, { id, name: nextGuideName(guides), text: '', enabled: true }];
}

export function updateGuide(
  guides: PersistentGuide[],
  id: string,
  patch: Partial<Omit<PersistentGuide, 'id'>>,
): PersistentGuide[] {
  return guides.map((guide) => (guide.id === id ? { ...guide, ...patch } : guide));
}

export function removeGuide(guides: PersistentGuide[], id: string): PersistentGuide[] {
  return guides.filter((guide) => guide.id !== id);
}

/**
 * How many guides actually reach the prompt.
 *
 * Blank ones are excluded because assembly skips blank content — the badge is the only
 * hint that something invisible is shaping every reply, so it must not overstate.
 */
export function countEnabledGuides(guides: PersistentGuide[]): number {
  return guides.filter((guide) => guide.enabled && guide.text.trim()).length;
}
