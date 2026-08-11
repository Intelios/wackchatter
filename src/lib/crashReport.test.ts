import { describe, expect, test } from 'bun:test';
import { describeError, formatCrashReport } from './crashReport.ts';

const AT = Date.parse('2026-08-11T19:04:11.000Z');

describe('describeError', () => {
  test('an Error reads as name and message', () => {
    expect(describeError(new TypeError('x is not a function'))).toBe(
      'TypeError: x is not a function',
    );
  });

  test('an Error with no message is still named', () => {
    expect(describeError(new Error(''))).toBe('Error');
  });

  /*
   * The whole reason this function is not `String(error)`: everything below is legal to
   * throw, and every one of them used to produce "[object Object]" or worse on the screen
   * whose only job is to tell someone what happened.
   */
  test('non-Error throws still say something', () => {
    expect(describeError('card is missing a name')).toBe('card is missing a name');
    expect(describeError(null)).toBe('null was thrown');
    expect(describeError(undefined)).toBe('undefined was thrown');
    expect(describeError({ code: 4 })).toBe('Non-Error thrown: {"code":4}');
    expect(describeError(42)).toBe('Non-Error thrown: 42');
  });

  test('a huge thrown value is truncated rather than pasted whole', () => {
    const described = describeError({ description: 'x'.repeat(5000) });
    expect(described.length).toBeLessThan(400);
    expect(described.endsWith('…')).toBe(true);
  });

  /** It runs inside the failure path. Throwing here is how a crash screen goes blank. */
  test('values that resist being printed do not throw', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeError(circular)).toContain('Non-Error thrown');
    expect(describeError(Symbol('nope'))).toBe('Non-Error thrown: Symbol(nope)');

    // Both of these throw on String(): a null-prototype object has no toString at all,
    // and this one has a toString that fails. Only the last resort answers them.
    expect(describeError(Object.create(null))).toBe(
      'Non-Error thrown (the value could not be printed)',
    );
    expect(
      describeError({
        toString() {
          throw new Error('hostile');
        },
      }),
    ).toBe('Non-Error thrown (the value could not be printed)');
  });
});

describe('formatCrashReport', () => {
  test('carries the build, the page and what threw', () => {
    const report = formatCrashReport({
      error: new TypeError('boom'),
      where: 'the chat',
      version: { version: '0.19.0', branch: 'dev', revision: 'ad0a6e2' },
      url: 'http://localhost:5173/',
      userAgent: 'TestBrowser/1.0',
      at: AT,
    });

    expect(report).toContain('WackChatter crash report');
    expect(report).toContain('2026-08-11T19:04:11.000Z');
    expect(report).toContain('the chat');
    expect(report).toContain("0.19.0 'dev' (ad0a6e2)");
    expect(report).toContain('http://localhost:5173/');
    expect(report).toContain('TestBrowser/1.0');
    expect(report).toContain('TypeError: boom');
  });

  test('a missing version says so rather than being left out', () => {
    const report = formatCrashReport({ error: new Error('boom'), at: AT });
    expect(report).toContain('Version:  unknown');
    // Nothing named the region, so the report says what that means.
    expect(report).toContain('the whole app');
  });

  test('the headline is not repeated when the stack already opens with it', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at somewhere (file.ts:1:1)';
    const report = formatCrashReport({ error, at: AT });
    expect(report.split('Error: boom').length - 1).toBe(1);
    expect(report).toContain('at somewhere (file.ts:1:1)');
  });

  test('the headline is added when the stack is only frames', () => {
    const error = new Error('boom');
    // Safari and Firefox stacks carry no message line.
    error.stack = 'render@file.ts:1:1';
    const report = formatCrashReport({ error, at: AT });
    expect(report).toContain('Error: boom\nrender@file.ts:1:1');
  });

  test('the component stack is included when React supplied one', () => {
    const report = formatCrashReport({
      error: new Error('boom'),
      componentStack: '\n    at MessageBubble\n    at ChatView',
      at: AT,
    });
    expect(report).toContain('Component stack:');
    expect(report).toContain('at MessageBubble');
  });

  /**
   * The screen rebuilds its report once the version request answers, which is after the
   * crash. Anything the global handlers log in that window — that request failing, a save
   * rejecting as the tree came down — must not join a list headed "before the crash".
   */
  test('only errors logged before the crash are listed', () => {
    const report = formatCrashReport({
      error: new Error('boom'),
      at: AT,
      priorErrors: [
        { at: AT - 20_000, source: 'rejection', text: 'TypeError: Failed to fetch' },
        { at: AT + 5, source: 'error', text: 'Error: boom' },
      ],
    });

    expect(report).toContain('Logged before the crash:');
    expect(report).toContain('rejection: TypeError: Failed to fetch');
    expect(report).not.toContain('error: Error: boom');
  });

  test('no prior errors means no empty section', () => {
    expect(formatCrashReport({ error: new Error('boom'), at: AT })).not.toContain(
      'Logged before the crash',
    );
  });
});
