import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { Connection } from '@shared/providers/types.ts';
import { DEFAULT_WI_SETTINGS } from '@shared/types/worldinfo.ts';
import {
  appendPresetTestUserMessage,
  createPresetTest,
  noCardCharacter,
  preparePresetTestRequest,
} from './testing.ts';
import { resolvePresetTestSource } from './testingSources.ts';

const draft = createDefaultPreset();
const earlier = createDefaultPreset();
earlier.temperature = 0.3;
const session = {
  current: { revision: 4, preset: draft },
  history: [{ revision: 2, preset: earlier }],
};

describe('preset test source resolution', () => {
  test('working draft follows the current revision; a selected revision is fixed', async () => {
    const loaders = {
      library: async () => {
        throw new Error('unexpected library read');
      },
      reference: async () => {
        throw new Error('unexpected reference read');
      },
    };
    const working = await resolvePresetTestSource({ kind: 'draft' }, session, loaders);
    const old = await resolvePresetTestSource({ kind: 'revision', revision: 2 }, session, loaders);

    expect(working.used).toMatchObject({ source: { kind: 'draft' }, revision: 4 });
    expect(old.used).toMatchObject({ source: { kind: 'revision', revision: 2 }, revision: 2 });
    expect(old.preset.temperature).toBe(0.3);
  });

  test('library and reference sources are read afresh for each generation', async () => {
    let version = 'one';
    let referenceVersion = 'ref-one';
    const loaders = {
      library: async () => ({
        preset: { ...draft, temperature: version === 'one' ? 0.4 : 0.8 },
        version,
      }),
      reference: async () => ({ preset: draft, version: referenceVersion }),
    };
    const source = { kind: 'library' as const, id: 'Other' };
    const first = await resolvePresetTestSource(source, session, loaders);
    version = 'two';
    const second = await resolvePresetTestSource(source, session, loaders);
    const reference = await resolvePresetTestSource(
      { kind: 'reference', id: 'Example' },
      session,
      loaders,
    );
    referenceVersion = 'ref-two';
    const updatedReference = await resolvePresetTestSource(
      { kind: 'reference', id: 'Example' },
      session,
      loaders,
    );

    expect(first.used.version).toBe('one');
    expect(second.used.version).toBe('two');
    expect(first.preset.temperature).toBe(0.4);
    expect(second.preset.temperature).toBe(0.8);
    expect(reference.used).toMatchObject({
      source: { kind: 'reference', id: 'Example' },
      version: 'ref-one',
    });
    expect(updatedReference.used.version).toBe('ref-two');
  });

  test('a missing source fails rather than falling back to the draft', async () => {
    await expect(
      resolvePresetTestSource({ kind: 'library', id: 'Gone' }, session, {
        library: async () => {
          throw new Error('Preset not found');
        },
        reference: async () => {
          throw new Error('unexpected');
        },
      }),
    ).rejects.toThrow('Preset not found');
  });

  test('outgoing macros, assembled prompt and provider body share one resolved copy', async () => {
    const external = createDefaultPreset();
    external.openai_max_tokens = 96;
    const resolved = await resolvePresetTestSource({ kind: 'library', id: 'Other' }, session, {
      library: async () => ({ preset: external, version: 'first-version' }),
      reference: async () => {
        throw new Error('unexpected reference read');
      },
    });
    external.openai_max_tokens = 200;
    const testChat = createPresetTest({
      characterId: null,
      character: noCardCharacter('Assistant'),
      greetingIndex: 0,
      persona: null,
      worldInfoSources: [],
      worldInfoSettings: DEFAULT_WI_SETTINGS,
      regexScripts: [],
      variables: { local: {}, global: {} },
    });
    const withUser = appendPresetTestUserMessage(testChat, '{{maxResponse}}', resolved.preset)!;
    const countTokens: TokenCounter = {
      countText: (value) => value.split(/\s+/).length,
      countChat: (messages) => messages.length * 4,
    };
    const connection: Connection = {
      id: 'conn-1',
      name: 'Test',
      provider: 'custom',
      baseUrl: 'https://example.invalid/v1',
      model: 'test-model',
    };
    const prepared = preparePresetTestRequest({
      test: withUser,
      kind: 'send',
      preset: resolved.preset,
      connection,
      countTokens,
    });

    expect(withUser.messages.at(-1)?.mes).toBe('96');
    expect(prepared?.assembled.messages.at(-1)?.content).toBe('96');
    expect(prepared?.body?.max_tokens).toBe(96);
    expect(resolved.used.version).toBe('first-version');
  });
});
