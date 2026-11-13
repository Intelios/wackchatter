import { currentText, type MessageState } from '@shared/chat/message.ts';
import {
  activeCheckpoint,
  type CompactionState,
  renderCheckpoint,
} from '@shared/cocreator/compaction.ts';
import { messageCoster, type TokenCounter } from '@shared/prompt/token-cache.ts';
import type { ApiMessage } from '@shared/types/chat.ts';
import type { SideChatSnapshot } from '@shared/types/cocreator.ts';
import { characterCompactionSources } from './compactionSources.ts';

export const SIDE_CHAT_INSTRUCTION = `You are the user's focused side-chat helper for a character-design conversation. The main conversation below is background context. Answer the user's side question directly; do not resume the main design interview, repeat its unanswered questions, or insist on its stages before helping. Side ideas are tentative until the user chooses to bring them back. You may suggest names, brainstorm alternatives, explain, or help draft an answer. When producing card-field content, use the main instructions' labelled card blocks. Do not claim to have changed the main conversation or filed anything into the card.`;
export const SIDE_CHAT_BOUNDARY =
  'End of main-conversation background. The following messages are the separate side conversation. Answer the latest side request.';

/** Full context is saved; packing is a disposable view for this particular model/request. */
export function buildSidePrompt(input: {
  compaction?: CompactionState;
  snapshot: SideChatSnapshot;
  messages: readonly MessageState[];
  countTokens: TokenCounter;
  maxPromptTokens: number;
}) {
  const { snapshot, countTokens, maxPromptTokens } = input;
  const checkpoint = activeCheckpoint(
    input.compaction,
    characterCompactionSources(input.messages, snapshot),
  );
  const coveredMain = Math.min(snapshot.messages.length, checkpoint?.coveredMessages ?? 0);
  const coveredSide = Math.max(0, (checkpoint?.coveredMessages ?? 0) - snapshot.messages.length);
  const fixed: ApiMessage[] = [
    {
      role: 'system',
      content: [
        snapshot.systemPrompt,
        SIDE_CHAT_INSTRUCTION,
        snapshot.exampleBlock,
        snapshot.draftBlock ?? '',
      ]
        .filter((block) => block.trim())
        .join('\n\n'),
    },
  ];
  if (checkpoint) fixed.push({ role: 'user', content: renderCheckpoint(checkpoint) });
  const boundary: ApiMessage = { role: 'user', content: SIDE_CHAT_BOUNDARY };
  const side = input.messages
    .filter((m) => currentText(m).trim())
    .slice(coveredSide)
    .map((m): ApiMessage => ({ role: m.is_user ? 'user' : 'assistant', content: currentText(m) }));
  const { cost } = messageCoster(countTokens);
  let tokens = countTokens.countChat([...fixed, boundary]);
  const fixedOverflow = tokens > maxPromptTokens;
  const packedSide: ApiMessage[] = [];
  const packedMain: ApiMessage[] = [];
  if (!fixedOverflow) {
    for (let i = side.length - 1; i >= 0; i -= 1) {
      const entry = side[i]!;
      if (tokens + cost(entry) > maxPromptTokens) break;
      packedSide.unshift(entry);
      tokens += cost(entry);
    }
    if (packedSide.length === side.length) {
      for (let i = snapshot.messages.length - 1; i >= coveredMain; i -= 1) {
        const entry = snapshot.messages[i]!;
        if (tokens + cost(entry) > maxPromptTokens) break;
        packedMain.unshift(entry);
        tokens += cost(entry);
      }
    }
  }
  const messages = [...fixed, ...packedMain, boundary, ...packedSide];
  return {
    messages,
    totalTokens: countTokens.countChat(messages),
    fixedOverflow,
    droppedMainMessages: snapshot.messages.length - coveredMain - packedMain.length,
    droppedSideMessages: side.length - packedSide.length,
  };
}
