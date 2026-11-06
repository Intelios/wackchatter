import { describe, expect, test } from 'bun:test';
import type { Connection } from '@shared/providers/types.ts';
import {
  type Catalogs,
  describeRef,
  groupKey,
  pickerSections,
  VENDOR_SPLIT_MIN,
} from './pickerLogic.ts';

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

describe('favourites and folding', () => {
  const big: Catalogs = {
    or: {
      status: 'ready',
      models: Array.from({ length: VENDOR_SPLIT_MIN }, (_, i) => {
        const vendor = i % 2 ? 'openai' : 'anthropic';
        const label = i % 2 ? 'OpenAI' : 'Anthropic';
        return { id: `${vendor}/m${i}`, name: `${label}: Model ${i}` };
      }),
    },
    local: { status: 'ready', models: [{ id: 'llama', name: 'llama' }] },
  };

  test('favourites head the list, never fold, and mark their options everywhere', () => {
    const star = { connectionId: 'or', modelId: 'openai/gpt-x' };
    const sections = pickerSections({
      connections,
      catalogs,
      recent: [star],
      favorites: [star],
      groups: { favorites: false },
      query: '',
    });
    expect(titles(sections)).toEqual(['Favourites', 'Recent', 'OpenRouter', 'Local']);
    expect(sections[0]).toMatchObject({ collapsible: false, open: true });
    expect(sections[1]?.options[0]?.favorite).toBe(true);
    const gpt = sections[2]?.options.find((o) => o.ref.modelId === 'openai/gpt-x');
    expect(gpt?.favorite).toBe(true);
  });

  test('a big vendor/model catalogue splits by vendor, folded shut by default', () => {
    const sections = pickerSections({ connections, catalogs: big, recent: [], query: '' });
    const or = sections.find((s) => s.key === groupKey.connection('or'));
    expect(or?.open).toBe(true);
    expect(or?.count).toBe(VENDOR_SPLIT_MIN);
    expect(or?.options).toEqual([]);
    expect(or?.groups?.map((g) => [g.title, g.open, g.count])).toEqual([
      ['Anthropic', false, VENDOR_SPLIT_MIN / 2],
      ['OpenAI', false, VENDOR_SPLIT_MIN / 2],
    ]);
    // Small catalogues stay flat.
    expect(sections.find((s) => s.key === groupKey.connection('local'))?.groups).toBeUndefined();
  });

  test('one vendor under several id prefixes is one group, titled as its names spell it', () => {
    const models = [
      ...Array.from({ length: VENDOR_SPLIT_MIN }, (_, i) => ({
        id: `meta-llama/m${i}`,
        name: `Meta: Llama ${i}`,
      })),
      { id: 'meta/muse', name: 'Meta: Muse' },
      { id: '~anthropic/claude-latest', name: 'Anthropic: Claude Latest' },
      { id: 'anthropic/claude', name: 'Anthropic: Claude' },
      { id: 'qwen/q1', name: 'Qwen: Q1' },
      { id: 'qwen/q2', name: 'q2' },
      { id: 'qwen/q3', name: 'Qwen: Q3' },
    ];
    const sections = pickerSections({
      connections,
      catalogs: { or: { status: 'ready', models } },
      recent: [],
      query: '',
    });
    const or = sections.find((s) => s.key === groupKey.connection('or'));
    expect(or?.groups?.map((g) => [g.title, g.count])).toEqual([
      ['Anthropic', 2],
      ['Meta', VENDOR_SPLIT_MIN + 1],
      // A name without the prefix still joins by its id, under the common spelling.
      ['Qwen', 3],
    ]);
  });

  test('remembered toggles override the defaults', () => {
    const sections = pickerSections({
      connections,
      catalogs: big,
      recent: [],
      groups: { [groupKey.connection('local')]: false, [groupKey.vendor('or', 'openai')]: true },
      query: '',
    });
    expect(sections.find((s) => s.key === groupKey.connection('local'))?.open).toBe(false);
    const or = sections.find((s) => s.key === groupKey.connection('or'));
    expect(or?.groups?.find((g) => g.title === 'OpenAI')?.open).toBe(true);
  });

  test('searching flattens and opens everything', () => {
    const sections = pickerSections({
      connections,
      catalogs: big,
      recent: [],
      groups: { [groupKey.connection('or')]: false },
      query: 'model 3',
    });
    const or = sections.find((s) => s.key === groupKey.connection('or'));
    expect(or).toMatchObject({ collapsible: false, open: true });
    expect(or?.groups).toBeUndefined();
    expect(or?.options.map((o) => o.ref.modelId)).toContain('openai/m3');
  });
});
