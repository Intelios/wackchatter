import { currentText, type MessageState } from '@shared/chat/message.ts';
import type { CompactionMessage } from '@shared/cocreator/compaction.ts';
import type { SideChatSnapshot } from '@shared/types/cocreator.ts';

export function characterCompactionSources(
  messages: readonly MessageState[],
  snapshot?: SideChatSnapshot,
): CompactionMessage[] {
  const background: CompactionMessage[] = (snapshot?.messages ?? []).map((m, index) => ({
    id: `background:${snapshot!.capturedAt}:${index}`,
    group: `background:${index}`,
    role: 'reference',
    content: JSON.stringify(m),
  }));
  return [
    ...background,
    ...messages
      .filter((m) => currentText(m).trim())
      .map(
        (m): CompactionMessage => ({
          id: m.id,
          group: m.id,
          role: m.is_user ? 'user' : 'assistant',
          content: currentText(m),
          ...(m.is_user && !currentText(m).startsWith('Continue your interrupted answer')
            ? { userText: currentText(m) }
            : {}),
        }),
      ),
  ];
}
