import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { ProviderToolCall } from '@shared/providers/types.ts';
import type { PresetCocreatorMessage } from '@shared/types/preset-cocreator.ts';
import type { PresetToolDeps } from './assistant.ts';
import { executePresetToolBatch } from './toolExecution.ts';

function call(id: string, name = 'patch_preset'): ProviderToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(
        name === 'patch_preset'
          ? {
              expectedRevision: 0,
              summary: 'Cooler',
              operations: [{ op: 'replace', path: '/temperature', value: 0.5 }],
            }
          : name === 'read_reference_preset'
            ? { name: 'Example' }
            : { message: 'Hello', restart: true, rationale: 'Check voice' },
      ),
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(overrides: Partial<PresetToolDeps> = {}) {
  const controller = new AbortController();
  const results: PresetCocreatorMessage[] = [];
  let patches = 0;
  let proposals = 0;
  const deps: PresetToolDeps = {
    currentRevision: () => ({ revision: 0, preset: createDefaultPreset() }),
    identity: () => ({ sessionTitle: 'Test', sourcePresetId: null, targetPresetId: null }),
    patchDraft: async () => {
      patches += 1;
      return { revision: patches, diff: [] };
    },
    proposeTest: () => {
      proposals += 1;
    },
    readReference: async () => ({}),
    ...overrides,
  };
  return {
    controller,
    results,
    patches: () => patches,
    proposals: () => proposals,
    run: (calls: ProviderToolCall[]) =>
      executePresetToolBatch({
        calls,
        turnId: 'turn',
        signal: controller.signal,
        deps,
        onResult: (result) => results.push(result),
      }),
  };
}

describe('Preset Co-Creator tool cancellation', () => {
  test('Stop before a batch records every call as skipped without executing it', async () => {
    const state = fixture();
    state.controller.abort();
    await state.run([call('patch'), call('proposal', 'propose_test')]);
    expect(state.patches()).toBe(0);
    expect(state.proposals()).toBe(0);
    expect(state.results.map((result) => result.toolCallId)).toEqual(['patch', 'proposal']);
    for (const result of state.results) {
      expect(JSON.parse(result.content)).toMatchObject({ ok: false, interrupted: true });
      expect(result.content).toContain('not executed');
    }
  });

  test('Stop during a reference read prevents the following patch and proposal', async () => {
    const entered = deferred();
    const release = deferred();
    const state = fixture({
      readReference: async (_name, signal) => {
        expect(signal).toBe(state.controller.signal);
        entered.resolve();
        await release.promise;
        return { name: 'Example' };
      },
    });
    const pending = state.run([
      call('read', 'read_reference_preset'),
      call('patch'),
      call('proposal', 'propose_test'),
    ]);
    await entered.promise;
    state.controller.abort();
    release.resolve();
    await pending;
    expect(state.patches()).toBe(0);
    expect(state.proposals()).toBe(0);
    expect(state.results).toHaveLength(3);
    expect(JSON.parse(state.results[0]!.content)).toEqual({ name: 'Example' });
    expect(JSON.parse(state.results[1]!.content)).toMatchObject({ interrupted: true });
  });

  test('Stop during the pre-patch save prevents dispatching the edit', async () => {
    const entered = deferred();
    const release = deferred();
    const state = fixture({
      beforePatch: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const pending = state.run([call('patch')]);
    await entered.promise;
    state.controller.abort();
    release.resolve();
    await pending;
    expect(state.patches()).toBe(0);
    expect(JSON.parse(state.results[0]!.content)).toMatchObject({ interrupted: true });
  });

  test('an edit already dispatched keeps its successful receipt after Stop', async () => {
    const entered = deferred();
    const release = deferred();
    let patches = 0;
    const state = fixture({
      patchDraft: async () => {
        patches += 1;
        entered.resolve();
        await release.promise;
        return { revision: 1, diff: [] };
      },
    });
    const pending = state.run([call('first'), call('second')]);
    await entered.promise;
    state.controller.abort();
    release.resolve();
    await pending;
    expect(patches).toBe(1);
    expect(JSON.parse(state.results[0]!.content)).toEqual({ ok: true, revision: 1, diff: [] });
    expect(JSON.parse(state.results[1]!.content)).toMatchObject({ interrupted: true });
  });

  test('an aborted read becomes a result and the remaining calls stay unexecuted', async () => {
    const state = fixture({
      readReference: async () => {
        state.controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
    });
    await state.run([call('read', 'read_reference_preset'), call('patch')]);
    expect(state.patches()).toBe(0);
    expect(state.results).toHaveLength(2);
    expect(JSON.parse(state.results[0]!.content)).toMatchObject({ ok: false, interrupted: true });
  });

  test('ordinary rejected calls still return errors and allow later tools', async () => {
    const state = fixture({
      readReference: async () => {
        throw new Error('Missing reference');
      },
    });
    await state.run([call('read', 'read_reference_preset'), call('patch')]);
    expect(JSON.parse(state.results[0]!.content)).toEqual({
      ok: false,
      error: 'Missing reference',
    });
    expect(state.patches()).toBe(1);
  });

  test('missing or duplicate ids reject the whole batch before any edit', async () => {
    for (const calls of [
      [call('first'), call('')],
      [call('same'), call('same')],
    ]) {
      const state = fixture();
      await expect(state.run(calls)).rejects.toThrow('unique');
      expect(state.patches()).toBe(0);
      expect(state.results).toEqual([]);
    }
  });
});
