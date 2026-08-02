/** Chat CRUD. Storage is ours, so there is no external format to honour here. */

import type {
  Chat,
  ChatMessage,
  ChatMetadata,
  StaleChatRevision,
} from '../../shared/types/chat.ts';
import { chatStore } from '../lib/chats.ts';
import { errorResponse, json, notFound, readJson } from '../lib/http.ts';

interface CreateBody {
  characterId?: string;
  title?: string;
  metadata?: ChatMetadata;
  messages?: ChatMessage[];
}

type ReplaceBody = Pick<Chat, 'messages' | 'revision'> & Partial<Pick<Chat, 'title' | 'metadata'>>;

function saveResponse(result: ReturnType<ReturnType<typeof chatStore>['replaceChat']>): Response {
  if (result.kind === 'saved') return json(result.chat);
  if (result.kind === 'notFound') return notFound('Chat not found.');
  const conflict: StaleChatRevision = result.conflict;
  return json({ error: 'Chat changed elsewhere.', ...conflict }, { status: 409 });
}

export async function handleChatRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;
  const store = chatStore();

  // /api/chats?character=<avatar>&limit=<n>
  if (segments.length === 0 && method === 'GET') {
    const params = new URL(request.url).searchParams;
    const character = params.get('character');
    const limit = params.get('limit');
    if (!character && limit) {
      const n = Number(limit);
      if (!Number.isInteger(n) || n < 1) return errorResponse('limit must be a positive integer.');
      return json(store.listRecent(n));
    }
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
      if (!Number.isSafeInteger(body.revision) || body.revision < 0) {
        return errorResponse('A non-negative revision is required.');
      }

      return saveResponse(
        store.replaceChat(id, {
          revision: body.revision,
          title: body.title,
          metadata: body.metadata,
          messages: body.messages,
        }),
      );
    }

    if (method === 'PATCH') {
      const body = await readJson<{ revision?: number; title?: string; metadata?: ChatMetadata }>(
        request,
      );
      if (!body) return errorResponse('Request body is not valid JSON.');
      const revision = body.revision;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        return errorResponse('A non-negative revision is required.');
      }

      return saveResponse(
        store.updateChatMeta(id, {
          revision,
          title: body.title,
          metadata: body.metadata,
        }),
      );
    }

    if (method === 'DELETE') {
      return store.deleteChat(id) ? json({ ok: true }) : notFound('Chat not found.');
    }
  }

  return null;
}
