/*
 * The errors nobody ever saw.
 *
 * A render crash is rarely the first thing that went wrong. A rejected save, a fetch that
 * died when the server was restarted, a listener that threw — none of those happen during
 * a render, so no error boundary will ever see them, and the browser logs them to a
 * console the user does not have open.
 *
 * So keep the last few and let the crash report carry them. "TypeError: x is undefined"
 * answers far less than the same line preceded by "the settings save rejected twenty
 * seconds ago".
 *
 * Deliberately silent: no banner, no toast. The app has no toast system, and a background
 * rejection the code already handled is not worth interrupting someone's chat for. This
 * only remembers.
 */

import { describeError, type PriorError } from './crashReport.ts';

/** Enough to show a pattern, few enough that the report stays readable at a glance. */
const LIMIT = 5;

const entries: PriorError[] = [];
let installed = false;

export function recordError(source: PriorError['source'], value: unknown): void {
  entries.push({ at: Date.now(), source, text: describeError(value) });
  if (entries.length > LIMIT) entries.shift();
}

/** Oldest first. Handed to `formatCrashReport`, which drops anything after the crash. */
export function recentErrors(): readonly PriorError[] {
  return entries;
}

export function installGlobalErrorHandlers(): void {
  // Vite re-executes this module on a hot update; the listeners it already added survive
  // that, so without the guard a long dev session logs every error several times over.
  if (installed) return;
  installed = true;

  // `event.error` is the thrown value where the browser has it, and is null for a
  // cross-origin script error — `event.message` is all there is to keep in that case.
  window.addEventListener('error', (event) => {
    recordError('error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordError('rejection', event.reason);
  });
}
