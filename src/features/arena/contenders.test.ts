import { describe, expect, test } from 'bun:test';
import type { Connection } from '@shared/providers/types.ts';
import type { Contender } from '@shared/types/arena.ts';
import {
  contenderLabel,
  eligibleContenders,
  resolveContender,
  resolveContenders,
} from './contenders.ts';

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'or',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'connection/default',
    ...overrides,
  };
}

function contender(overrides: Partial<Contender> = {}): Contender {
  return {
    id: 'k1',
    name: 'Sonnet',
    connectionId: 'or',
    model: 'anthropic/sonnet',
    enabled: true,
    ...overrides,
  };
}

describe('resolveContender', () => {
  test('applies the model over the connection it was chosen against', () => {
    const resolved = resolveContender(contender(), [connection()]);

    expect(resolved.unavailableReason).toBeNull();
    expect(resolved.connection?.model).toBe('anthropic/sonnet');
    // The rest of the endpoint is untouched, so one connection can serve many contenders.
    expect(resolved.connection?.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(resolved.connection?.provider).toBe('openrouter');
  });

  test('an empty model follows the connection default', () => {
    const resolved = resolveContender(contender({ model: '  ' }), [connection()]);

    expect(resolved.connection?.model).toBe('connection/default');
  });

  test('a deleted connection makes it unavailable, not absent', () => {
    const resolved = resolveContender(contender({ connectionId: 'gone' }), [connection()]);

    expect(resolved.connection).toBeNull();
    expect(resolved.unavailableReason).toBe('Its connection has been deleted.');
    // The entry itself survives, so the pool does not silently lose a row.
    expect(resolved.contender.id).toBe('k1');
  });

  test('a connection with no endpoint is unavailable and says which one', () => {
    const resolved = resolveContender(contender(), [connection({ baseUrl: '' })]);

    expect(resolved.connection).toBeNull();
    expect(resolved.unavailableReason).toContain('OpenRouter');
  });

  test('no model anywhere is unavailable', () => {
    const resolved = resolveContender(contender({ model: '' }), [connection({ model: '' })]);

    expect(resolved.connection).toBeNull();
    expect(resolved.unavailableReason).toContain('No model is set');
  });
});

describe('eligibleContenders', () => {
  test('keeps only the enabled ones that can actually run', () => {
    const pool = [
      contender({ id: 'ok' }),
      contender({ id: 'off', enabled: false }),
      contender({ id: 'broken', connectionId: 'gone' }),
    ];

    const eligible = eligibleContenders(resolveContenders(pool, [connection()]));
    expect(eligible.map((entry) => entry.id)).toEqual(['ok']);
  });
});

describe('contenderLabel', () => {
  test('prefers the name, then the model, then anything but blank', () => {
    expect(contenderLabel(contender())).toBe('Sonnet');
    expect(contenderLabel(contender({ name: '  ' }))).toBe('anthropic/sonnet');
    expect(contenderLabel(contender({ name: '', model: '' }), connection())).toBe(
      'connection/default',
    );
    expect(contenderLabel(contender({ name: '', model: '' }))).toBe('Unnamed contender');
  });
});
