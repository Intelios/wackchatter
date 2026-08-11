/*
 * The text a crashed screen hands to the user.
 *
 * One thing matters here: a beta tester pastes one message into a chat window and we can
 * tell what happened without a follow-up. So the report is plain text — no JSON, no
 * markdown fence — and carries the four things every bug report is missing by default:
 * which build, which browser, what threw, and what the app was doing before it did.
 *
 * Pure and separate from the boundary that renders it, because this is the part worth
 * testing: it runs while the app is already broken, on values that are not guaranteed to
 * be Errors, and it must not throw.
 */

import type { VersionInfo } from './api.ts';

/** An error that never reached the UI, kept by the global handlers in `errorLog.ts`. */
export interface PriorError {
  /** Epoch ms. */
  at: number;
  source: 'error' | 'rejection';
  text: string;
}

export interface CrashReportInput {
  /** Whatever was thrown. Rarely, but legally, not an Error. */
  error: unknown;
  /** React's own component stack, from `componentDidCatch`. */
  componentStack?: string | null;
  /** The region that died, in the app's words: 'the chat', 'the left panel'. */
  where?: string | null;
  /** Null when the version fetch has not landed, or the server is down. */
  version?: VersionInfo | null;
  url?: string;
  userAgent?: string;
  /** Epoch ms of the crash. */
  at: number;
  priorErrors?: readonly PriorError[];
}

/** A thrown object printed into the report is a clue, not a payload. */
const MAX_VALUE_CHARS = 300;

/**
 * One line naming what went wrong, for a thrown value of any shape.
 *
 * `throw 'nope'` and `throw {code: 4}` are both legal, and a card field that trips some
 * library's argument check is exactly the kind of code that does it. This is the headline
 * on the crash screen, so every branch has to produce something a person can read — and
 * none of them may throw, since the app is already in its failure path when we get here.
 */
export function describeError(value: unknown): string {
  if (value instanceof Error) {
    const name = value.name || 'Error';
    return value.message ? `${name}: ${value.message}` : name;
  }
  if (typeof value === 'string') return value.trim() || 'An empty string was thrown';
  if (value === null) return 'null was thrown';
  if (value === undefined) return 'undefined was thrown';

  try {
    const json = JSON.stringify(value);
    // '{}' means every own property was non-enumerable or a function — String() usually
    // does better with those, so fall through to it.
    if (json && json !== '{}') return `Non-Error thrown: ${truncate(json)}`;
  } catch {
    // Circular, a BigInt, or a getter that throws. String() is the next thing to try.
  }

  try {
    return `Non-Error thrown: ${truncate(String(value))}`;
  } catch {
    // String() throws on a Symbol, and on anything with a hostile toString.
    return 'Non-Error thrown (the value could not be printed)';
  }
}

function truncate(text: string): string {
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

function stackOf(value: unknown): string | null {
  if (!(value instanceof Error) || typeof value.stack !== 'string') return null;
  return value.stack.trim() || null;
}

function versionLine(version: VersionInfo | null | undefined): string {
  if (!version) return 'unknown (the version request did not answer)';
  return version.branch && version.revision
    ? `${version.version} '${version.branch}' (${version.revision})`
    : version.version;
}

/** Assembled once and shown verbatim, so what the user copies is what they can read. */
export function formatCrashReport(input: CrashReportInput): string {
  const headline = describeError(input.error);
  const stack = stackOf(input.error);

  const lines: string[] = [
    'WackChatter crash report',
    `When:     ${new Date(input.at).toISOString()}`,
    `Where:    ${input.where || 'the whole app'}`,
    `Version:  ${versionLine(input.version)}`,
  ];
  if (input.url) lines.push(`Page:     ${input.url}`);
  if (input.userAgent) lines.push(`Browser:  ${input.userAgent}`);

  // V8 stacks already open with "Name: message"; JavaScriptCore's and SpiderMonkey's do
  // not. Printing the headline unconditionally would duplicate that first line on Chrome,
  // which is the browser most of these reports will come from.
  lines.push(
    '',
    stack?.startsWith(headline) ? stack : [headline, stack].filter(Boolean).join('\n'),
  );

  // React's stack opens with a newline and indents every frame. Only the blank line goes:
  // trimming would unindent the first frame alone and leave the block looking ragged.
  const componentStack = input.componentStack?.replace(/^\n+/, '').replace(/\s+$/, '');
  if (componentStack) lines.push('', 'Component stack:', componentStack);

  // Only what was logged before the crash. The report is rebuilt when the version fetch
  // lands, a moment after the app has already died, so without the filter anything that
  // failed in between — that very request, for one — would be listed under a heading
  // saying it came first.
  const prior = (input.priorErrors ?? []).filter((entry) => entry.at <= input.at);
  if (prior.length > 0) {
    lines.push('', 'Logged before the crash:');
    for (const entry of prior) {
      lines.push(`  ${new Date(entry.at).toISOString()}  ${entry.source}: ${entry.text}`);
    }
  }

  return lines.join('\n');
}
