import { describe, expect, test } from 'bun:test';
import type { Connection } from '@shared/providers/types.ts';
import { type Catalogs, describeRef, pickerSections } from './pickerLogic.ts';

const connections: Connection[] = [
  { id: 'or', name: 'OpenRouter', provider: 'openrouter', baseUrl: 'https://or/v1' },
  { id: 'local', name: 'Local', provider: 'custom', baseUrl: 'http://local/v1' },
];

const catalogs: Catalogs = {
  or: {
    status: 'ready',
    models: [
      { id: 'anthropic/claude-sonnet', name: 'Claude Sonnet', contextLength: 200000 },
      { id: 'openai/gpt-x', name: 'GPT X', promptPrice: 0 },
    ],
  },
  local: { status: 'ready', models: [] },
};

const titles = (sections: ReturnType<typeof pickerSections>) => sections.map((s) => s.title);

describe('pickerSections', () => {
  test('recents first, then every connection by name', () => {
    const sections = pickerSections({
      connections,
      catalogs,
      recent: [{ connectionId: 'or', modelId: 'openai/gpt-x' }],
      query: '',
    });
    expect(titles(sections)).toEqual(['Recent', 'OpenRouter', 'Local']);
    expect(sections[0]?.options[0]).toMatchObject({
      name: 'GPT X',
      connectionName: 'OpenRouter',
      hint: 'free',
    });
    expect(sections[1]?.options.map((o) => o.name)).toEqual(['Claude Sonnet', 'GPT X']);
    expect(sections[1]?.options[0]?.hint).toBe('200k ctx');
    // An endpoint that lists nothing says how to pick anyway.
    expect(sections[2]?.note).toContain('Type a model id');
  });

  test('a recent pick on a deleted connection is not offered', () => {
    const sections = pickerSections({
      connections,
      catalogs,
      recent: [{ connectionId: 'gone', modelId: 'x' }],
      query: '',
    });
    expect(titles(sections)).not.toContain('Recent');
  });

  test('every word of the query must match, connection name included', () => {
    const sections = pickerSections({ connections, catalogs, recent: [], query: 'sonnet open' });
    expect(sections[0]?.options.map((o) => o.name)).toEqual(['Claude Sonnet']);
  });

  test('a typed id is offered on each connection that does not list it', () => {
    const sections = pickerSections({ connections, catalogs, recent: [], query: 'my-model' });
    const typed = sections.find((section) => section.key === 'typed');
    expect(typed?.options.map((o) => o.ref)).toEqual([
      { connectionId: 'or', modelId: 'my-model' },
      { connectionId: 'local', modelId: 'my-model' },
    ]);

    const exact = pickerSections({ connections, catalogs, recent: [], query: 'openai/gpt-x' });
    expect(exact.find((s) => s.key === 'typed')?.options.map((o) => o.ref.connectionId)).toEqual([
      'local',
    ]);
  });

  test('loading and failed catalogues say so, but only when nothing is being searched', () => {
    const pending: Catalogs = {
      or: { status: 'loading' },
      local: { status: 'error', error: '401' },
    };
    const idle = pickerSections({ connections, catalogs: pending, recent: [], query: '' });
    expect(idle.map((s) => s.note)).toEqual(['Loading models…', 'Could not list models: 401']);
    const searching = pickerSections({ connections, catalogs: pending, recent: [], query: 'x y' });
    expect(searching).toEqual([]);
  });
});

test('describeRef names the model by its catalogue name and reports a deleted connection', () => {
  expect(
    describeRef({ connectionId: 'or', modelId: 'openai/gpt-x' }, connections, catalogs),
  ).toEqual({ name: 'GPT X', connectionName: 'OpenRouter' });
  expect(describeRef({ connectionId: 'gone', modelId: 'raw' }, connections, catalogs)).toEqual({
    name: 'raw',
    connectionName: null,
  });
});
