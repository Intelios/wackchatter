/**
 * Undo stacks for operations that touch several stores and must not half-apply.
 *
 * Each step that succeeds pushes the action that would undo it. If a later step throws, the
 * stack unwinds in reverse and the original error is rethrown — the caller sees the failure
 * that actually mattered, not the cleanup.
 *
 * Rolling back can itself fail, and that is a genuinely different situation: some of the
 * change is now stuck. Those cases surface as an AggregateError carrying both the original
 * failure and the rollback failures, so nothing is silently swallowed.
 */

export type Rollback = () => Promise<void> | void;

/** Run every rollback in reverse order, collecting failures rather than stopping at the first. */
export async function rollbackAll(rollbacks: Rollback[], what = 'operation'): Promise<void> {
  const failures: unknown[] = [];
  for (const rollback of [...rollbacks].reverse()) {
    try {
      await rollback();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Rollback of the ${what} failed.`);
  }
}

/** Unwind the stack, then rethrow the failure that caused it. Never returns. */
export async function failAfterRollback(
  error: unknown,
  rollbacks: Rollback[],
  what = 'operation',
): Promise<never> {
  try {
    await rollbackAll(rollbacks, what);
  } catch (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      `The ${what} failed, and rolling it back also failed.`,
    );
  }
  throw error;
}
