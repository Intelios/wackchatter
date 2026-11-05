import { describe, expect, test } from 'bun:test';
import type { Connection } from '../../shared/providers/types.ts';
import { generationConnection } from './generate.ts';

const connections: Connection[] = [
  { id: 'chat', name: 'Chat', provider: 'custom', baseUrl: 'https://chat.example/v1' },
  { id: 'summary', name: 'Summary', provider: 'openrouter', baseUrl: 'https://summary.example/v1' },
];

describe('generationConnection', () => {
  test('the id selects that stored connection', () => {
    expect(generationConnection({ connections }, 'summary')).toBe(connections[1]!);
  });

  test('an unknown id is rejected rather than becoming client-supplied endpoint state', () => {
    expect(() => generationConnection({ connections }, 'missing')).toThrow('Unknown connection');
  });

  test('an empty id is also rejected: there is no active connection to fall back to', () => {
    expect(() => generationConnection({ connections }, '')).toThrow('Unknown connection');
  });
});
