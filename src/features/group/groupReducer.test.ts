import { expect, test } from 'bun:test';
import { assistantPlaceholder } from '@shared/chat/message.ts';
import { type GroupState, groupReducer, initialGroupState } from './groupReducer.ts';

const withMessages = (count: number): GroupState => ({
  ...initialGroupState,
  chatId: 'chat-1',
  revision: 1,
  persistedRevision: 1,
  messages: Array.from({ length: count }, (_, i) => assistantPlaceholder(`m${i}`, 'Alex')),
});

test('a redundant running report keeps state identity, so React skips the render', () => {
  // The coordinator reports every transition — launch, settle, pump — and most of those
  // reports carry the same flag. Each one used to re-render the entire app.
  const started = groupReducer(initialGroupState, { type: 'group/running', running: true });
  expect(started).not.toBe(initialGroupState);
  expect(started.conversationRunning).toBe(true);
  expect(started.status).toBe('streaming');
  const again = groupReducer(started, { type: 'group/running', running: true });
  expect(again).toBe(started);
});

test('status consistency is still repaired on a redundant report', () => {
  const started = groupReducer(initialGroupState, { type: 'group/running', running: true });
  // A leftover from some other path must clear even though the flag itself did not move.
  const repaired = groupReducer(
    { ...started, streamingId: 'stale', mode: 'send' },
    { type: 'group/running', running: true },
  );
  expect(repaired.streamingId).toBeNull();
  expect(repaired.mode).toBeNull();
});

test('the exchange ends idle when the last job settles and the flag drops', () => {
  let state = groupReducer(withMessages(1), {
    type: 'group/start',
    jobId: 'j1',
    memberId: 'a',
    characterId: 'a.png',
    name: 'Alex',
    mode: 'send',
  });
  expect(state.status).toBe('streaming');
  state = groupReducer(state, {
    type: 'group/settle',
    jobId: 'j1',
    text: 'Done.',
    extra: {},
  });
  expect(state.status).toBe('idle');
  // And one final redundant report after that settles nothing must not re-render.
  const final = groupReducer(state, { type: 'group/running', running: false });
  expect(final).toBe(state);
});
