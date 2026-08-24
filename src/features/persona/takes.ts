/**
 * The converter's takes: one editable draft per roll.
 *
 * A re-roll **appends** rather than replacing, and the stepper walks back to earlier takes
 * with whatever edits were made to them intact. Same reasoning as the Co-Creator's re-roll
 * ("appends a take, never displaces; do not add a destructive regenerate"): a draft you spent
 * a minute trimming must not be destroyed by asking the model for another opinion.
 *
 * Nothing here reaches disk — the converter writes exactly once, on Save — so this is
 * ordinary list state, pure and testable without a DOM.
 */

export interface Take {
  name: string;
  description: string;
  /** Whether the user has edited this take since it arrived. Drives the discard confirm. */
  dirty: boolean;
}

export function appendTake(takes: readonly Take[], take: Take): { takes: Take[]; index: number } {
  const next = [...takes, take];
  return { takes: next, index: next.length - 1 };
}

export function editTake(takes: readonly Take[], index: number, patch: Partial<Take>): Take[] {
  const current = takes[index];
  if (!current) return [...takes];
  return takes.map((take, at) => (at === index ? { ...take, ...patch, dirty: true } : take));
}

/** Clamped, so stepping past either end is a no-op rather than an index that does not exist. */
export function stepTake(takes: readonly Take[], index: number, step: number): number {
  if (takes.length === 0) return 0;
  return Math.min(Math.max(index + step, 0), takes.length - 1);
}

/** Any take edited since it arrived — what "discard the draft?" is asking about. */
export function hasDirtyTake(takes: readonly Take[]): boolean {
  return takes.some((take) => take.dirty);
}
