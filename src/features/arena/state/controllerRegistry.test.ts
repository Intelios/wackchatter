import { describe, expect, test } from 'bun:test';
import { createControllerRegistry } from './controllerRegistry.ts';

describe('controllerRegistry', () => {
  test('a registered controller is a member until its own finally removes it', () => {
    const registry = createControllerRegistry();
    const controller = new AbortController();

    registry.add(controller);
    expect(registry.has(controller)).toBe(true);

    registry.remove(controller);
    expect(registry.has(controller)).toBe(false);
  });

  test('abortAll stops every member without ending ownership', () => {
    const registry = createControllerRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.add(first);
    registry.add(second);

    registry.abortAll();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    // The aborted requests still settle their own columns — membership survives Stop.
    expect(registry.has(first)).toBe(true);
    expect(registry.has(second)).toBe(true);
  });

  test('revokeAll stops every member and ends ownership', () => {
    const registry = createControllerRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.add(first);
    registry.add(second);

    registry.revokeAll();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(registry.has(first)).toBe(false);
    expect(registry.has(second)).toBe(false);
  });

  test('remove after revokeAll is inert — a finally can always retire its own request', () => {
    const registry = createControllerRegistry();
    const controller = new AbortController();
    registry.add(controller);

    registry.revokeAll();
    registry.remove(controller);

    expect(registry.has(controller)).toBe(false);
  });

  test('abort handlers that reach back into the registry do not corrupt the walk', () => {
    // The zombie-run shape: clear() revokes while a request is mid-flight, and the abort
    // handler runs synchronously inside the walk. Every member must still be stopped — the
    // walk runs over a copy precisely so a handler reaching back cannot skip one.
    const registry = createControllerRegistry();
    const observed: boolean[] = [];
    const first = new AbortController();
    const second = new AbortController();
    first.signal.addEventListener('abort', () => {
      observed.push(registry.has(first));
    });
    registry.add(first);
    registry.add(second);

    registry.revokeAll();

    // The handler saw the registry mid-walk — membership ends after the walk, not during
    // it, which is also why a settle that races the walk still finds itself owned.
    expect(observed).toEqual([true]);
    // Both members were stopped, the one whose handler reached back included.
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    // And once the revoke has completed, no late callback from either is owned again.
    expect(registry.has(first)).toBe(false);
    expect(registry.has(second)).toBe(false);
  });
});
