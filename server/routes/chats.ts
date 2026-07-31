/** Chat CRUD. Storage is ours, so there is no external format to honour here. */

import type { Chat, ChatMessage, ChatMetadata } from '../../shared/types/chat.ts';
import { chatStore } from '../lib/chats.ts';
import { errorResponse, json, notFound, readJson } from '../lib/http.ts';

interface CreateBody {
  characterId?: string;
  title?: string;
  metadata?: ChatMetadata;
  messages?: ChatMessage[];
}

type ReplaceBody = Pick<Chat, 'messages'> & Partial<Pick<Chat, 'title' | 'metadata'>>;

export async function handleChatRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;
  const store = chatStore();

  // /api/chats?character=<avatar>
  if (segments.length === 0 && method === 'GET') {
    const character = new URL(request.url).searchParams.get('character');
    return json(store.listChats(character ?? undefined));
  }

  // /api/chats
  if (segments.length === 0 && method === 'POST') {
    const body = await readJson<CreateBody>(request);
    if (!body) return errorResponse('Request body is not valid JSON.');
    if (!body.characterId) return errorResponse('A characterId is required.');

    return json(
      store.createChat({
        characterId: body.characterId,
        title: body.title,
        metadata: body.metadata,
        messages: body.messages,
      }),
      { status: 201 },
    );
  }

  if (segments.length === 0) return null;
  const id = decodeURIComponent(segments[0]!);

  // /api/chats/:id/branch
  if (segments[1] === 'branch' && method === 'POST') {
    const body = await readJson<{ afterMessageId?: string; title?: string }>(request);
    if (!body?.afterMessageId) return errorResponse('An afterMessageId is required.');

    const branch = store.branchChat(id, body.afterMessageId, body.title);
    return branch ? json(branch, { status: 201 }) : notFound('Chat or message not found.');
  }

  // /api/chats/:id
  if (segments.length === 1) {
    if (method === 'GET') {
      const chat = store.getChat(id);
      return chat ? json(chat) : notFound('Chat not found.');
    }

    // Whole-chat write. Granular message endpoints would add a family of
    // client-and-server-disagree bugs to save a couple of milliseconds.
    if (method === 'PUT') {
      const body = await readJson<ReplaceBody>(request);
      if (!body) return errorResponse('Request body is not valid JSON.');
      if (!Array.isArray(body.messages)) return errorResponse('A messages array is required.');

      const saved = store.replaceChat(id, {
        title: body.title,
        metadata: body.metadata,
        messages: body.messages,
      });
      return saved ? json(saved) : notFound('Chat not found.');
    }

    if (method === 'PATCH') {
      const body = await readJson<{ title?: string; metadata?: ChatMetadata }>(request);
      if (!body) return errorResponse('Request body is not valid JSON.');

      const saved = store.updateChatMeta(id, body);
      return saved ? json(saved) : notFound('Chat not found.');
    }

    if (method === 'DELETE') {
      return store.deleteChat(id) ? json({ ok: true }) : notFound('Chat not found.');
    }
  }

  return null;
}
