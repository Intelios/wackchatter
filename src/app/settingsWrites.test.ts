import { describe, expect, test } from 'bun:test';
import type { SettingsResponse } from '@shared/types/settings.ts';
import { DEFAULT_SETTINGS } from '@shared/types/settings.ts';
import { applySavedChatModelSettings, createSettingsPainter } from './settingsWrites.ts';

const settings = (revision: number): SettingsResponse => ({
  ...structuredClone(DEFAULT_SETTINGS),
  settingsRevision: revision,
  keys: {},
});

describe('settings painting', () => {
  test('a response from before a newer save cannot paint over it', () => {
    const painted: SettingsResponse[] = [];
    const paint = createSettingsPainter((saved) => painted.push(saved));
    const before = settings(4);
    const after = settings(5);
    expect(paint(after)).toBe(true);
    expect(paint(before)).toBe(false);
    expect(painted).toEqual([after]);
  });

  test('responses at the same revision still paint, so a fresh fetch is never ignored', () => {
    const painted: SettingsResponse[] = [];
    const paint = createSettingsPainter((saved) => painted.push(saved));
    paint(settings(7));
    paint(settings(7));
    expect(painted).toHaveLength(2);
  });

  test('a delayed connection response cannot restore the model a later save replaced', () => {
    const painted: SettingsResponse[] = [];
    const paint = createSettingsPainter((saved) => painted.push(saved));

    // A connection PATCH answered from revision 3, before the model pick reached the server.
    const stale = settings(3);
    stale.models.chat = { connectionId: 'default', modelId: 'old-model' };

    // The confirmed model save is revision 4 and carries the new pick.
    const saved = settings(4);
    const model = { connectionId: 'default', modelId: 'new-model' };
    saved.models.chat = model;

    paint(saved);
    paint(stale);

    expect(painted).toHaveLength(1);
    expect(painted[0]?.models.chat).toEqual(model);
  });
});

describe('committed chat model state', () => {
  test('publishes a confirmed model even while newer unrelated settings are queued', () => {
    const current = settings(5);
    current.revealReplies = 'finished';
    current.models.nexus = { connectionId: 'default', modelId: 'memory' };
    const saved = settings(5);
    saved.models.chat = { connectionId: 'default', modelId: 'model-b' };
    const snapshot = structuredClone(current);
    const next = applySavedChatModelSettings(current, saved, {
      models: { chat: saved.models.chat },
    });
    expect(next.models.chat).toEqual(saved.models.chat);
    expect(next.models.nexus).toEqual(current.models.nexus);
    expect(next.revealReplies).toBe('finished');
    expect(current).toEqual(snapshot);
  });

  test('publishes a confirmed effort map without rolling back the selected model or other edits', () => {
    const current = settings(5);
    current.models.chat = { connectionId: 'default', modelId: 'model-b' };
    current.revealReplies = 'finished';
    const saved = settings(5);
    saved.chatReasoningEfforts = { default: { 'model-b': 'auto' } };
    const next = applySavedChatModelSettings(current, saved, {
      chatReasoningEfforts: { default: { 'model-b': 'auto' } },
    });
    expect(next.chatReasoningEfforts).toEqual(saved.chatReasoningEfforts);
    expect(next.models).toBe(current.models);
    expect(next.revealReplies).toBe('finished');
  });

  test('a cleared chat slot and a removed override are committed, not treated as absent', () => {
    const current = settings(2);
    current.models.chat = { connectionId: 'default', modelId: 'model-a' };
    current.chatReasoningEfforts = { default: { 'model-a': 'high' } };
    const next = applySavedChatModelSettings(current, settings(3), {
      models: { chat: null },
      chatReasoningEfforts: { default: { 'model-a': null } },
    });
    expect(next.models.chat).toBeNull();
    expect(next.chatReasoningEfforts).toEqual({});
  });
});
