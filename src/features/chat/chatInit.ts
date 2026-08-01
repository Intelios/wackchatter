/**
 * Serializes background chat initialization independently for each character.
 *
 * A single global in-flight slot is not enough: selecting A, then B, then A again while
 * A's create request is still running forgets the first A request and can create a second
 * transcript. Keeping one tail per character makes every later A pass observe the result
 * of the earlier A pass, regardless of what other characters were selected between them.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(task);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

export interface InitialChatApi {
  list(characterId: string): Promise<ChatSummary[]>;
  get(chatId: string): Promise<Chat>;
  create(input: {
    characterId: string;
    title: string;
    metadata: ChatMetadata;
  }): Promise<Chat>;
}

export interface InitialChatResult {
  chat: Chat | null;
  summaries: ChatSummary[];
  created: boolean;
}

/**
 * Resolve the most recent chat, creating one only after a successful empty listing.
 * Listing errors deliberately propagate: an error is not evidence that no chats exist.
 */
export async function resolveInitialChat(
  api: InitialChatApi,
  characterId: string,
  metadata: ChatMetadata,
  canCreate: () => boolean,
): Promise<InitialChatResult> {
  const summaries = await api.list(characterId);
  const recent = summaries[0];
  if (recent) {
    return { chat: await api.get(recent.id), summaries, created: false };
  }
  if (!canCreate()) return { chat: null, summaries, created: false };

  const chat = await api.create({ characterId, title: 'New chat', metadata });
  return {
    chat,
    created: true,
    summaries: [
      {
        id: chat.id,
        characterId: chat.characterId,
        title: chat.title,
        created: chat.created,
        modified: chat.modified,
        messageCount: chat.messages.length,
        lastMessage: '',
      },
    ],
  };
}
import type { Chat, ChatMetadata, ChatSummary } from '@shared/types/chat.ts';
