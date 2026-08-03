import { describe, expect, test } from 'bun:test';
import type { Connection } from '../../shared/providers/types.ts';
import { generationConnection } from './generate.ts';

const connections: Connection[] = [
  {
    id: 'chat',
    name: 'Chat',
    provider: 'custom',
    baseUrl: 'https://chat.example/v1',
    model: 'chat-model',
  },
  {
    id: 'summary',
    name: 'Summary',
    provider: 'openrouter',
    baseUrl: 'https://summary.example/v1',
    model: 'summary-model',
  },
];

describe('generationConnection', () => {
  test('ordinary generation follows the active connection', () => {
    expect(generationConnection({ connections, connectionId: 'chat' })?.id).toBe('chat');
  });

  test('an explicit id selects that stored connection', () => {
    expect(generationConnection({ connections, connectionId: 'chat' }, 'summary')).toBe(
      connections[1]!,
    );
  });

  test('an unknown id is rejected rather than becoming client-supplied endpoint state', () => {
    expect(() => generationConnection({ connections, connectionId: 'chat' }, 'missing')).toThrow(
      'Unknown connection',
    );
  });

  test('an empty explicit id is also rejected', () => {
    expect(() => generationConnection({ connections, connectionId: 'chat' }, '')).toThrow(
      'Unknown connection',
    );
  });
});
