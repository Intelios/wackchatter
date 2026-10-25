import { NEXUS_MODEL_FINGERPRINT } from '../../shared/nexus/model.ts';
import { validateGroup } from '../../shared/types/group.ts';

/** Chat CRUD. Storage is ours, so there is no external format to honour here. */

import { emptyNexus, migrateMemories } from '../../shared/nexus/state.ts';
import type { ChatMessage, ChatMetadata, StaleChatRevision } from '../../shared/types/chat.ts';
import { parseChatExport } from '../lib/backups.ts';
import { type ChatSaveAckResult, type ChatSaveInput, chatStore } from '../lib/chats.ts';
import { getDb } from '../lib/db.ts';
import { contentDisposition, errorResponse, json, notFound, readJson } from '../lib/http.ts';
import { readNexusIndex, validEmbedding, writeNexusIndex } from '../lib/nexus.ts';
import { getSettings } from '../lib/settings.ts';

interface CreateBody {
  characterId?: string | null;
  kind?: 'direct' | 'group';
  title?: string;
  metadata?: ChatMetadata;
  messages?: ChatMessage[];
}

interface SaveBody {
  revision?: number;
  baseRevision?: number;
  saveId?: string;
  title?: string;
  metadata?: ChatMetadata;
  order?: unknown[];
  upsert?: ChatMessage[];
}

function saveResponse(result: ChatSaveAckResult): Response {
  // The small acknowledgement, never the saved chat: the client already holds
  // everything it sent, so echoing the transcript back would only tax the request.
  if (result.kind === 'saved') return json(result.ack);
  if (result.kind === 'notFound') return notFound('Chat not found.');
  const conflict: StaleChatRevision = result.conflict;
  return json({ error: 'Chat changed elsewhere.', ...conflict }, { status: 409 });
}

function badRevision(revision: unknown): boolean {
  return typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0;
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
    if (body.kind === 'group') {
      if (!validateGroup(body.metadata?.group)) return errorResponse('Invalid group scene.');
    } else if (!body.characterId) return errorResponse('A characterId is required.');

    return json(
      store.createChat({
        characterId: body.characterId,
        kind: body.kind,
        title: body.title,
        metadata: {
          memoryMode: getSettings().memoryMode,
          nexus: { ...emptyNexus(), initialized: true },
          ...body.metadata,
        },
        messages: body.messages,
      }),
      { status: 201 },
    );
  }

  if (segments.length === 0) return null;

  // /api/chats/import
  if (segments[0] === 'import' && method === 'POST') {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return errorResponse('No file provided.');

    const characterId = form.get('characterId');

    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      return errorResponse('The file is not valid JSON.');
    }

    const exported = parseChatExport(raw);
    if (!exported) return errorResponse('The file is not a WackChatter chat export.');
    if (exported.kind !== 'group' && (typeof characterId !== 'string' || !characterId.trim()))
      return errorResponse('A characterId is required.');

    return json(
      store.createChat({
        characterId: exported.kind === 'group' ? null : String(characterId).trim(),
        ...exported,
        metadata: {
          ...exported.metadata,
          memoryMode:
            exported.metadata?.memoryMode === 'memories'
              ? 'nexus'
              : (exported.metadata?.memoryMode ?? getSettings().memoryMode),
          ...(exported.metadata?.memories?.length && !exported.metadata.nexus
            ? { nexus: migrateMemories(exported.metadata.memories, exported.messages) }
            : {}),
        },
      }),
      { status: 201 },
    );
  }

  const id = decodeURIComponent(segments[0]!);

  if (segments.length === 2 && segments[1] === 'nexus-index') {
    if (!store.getChat(id)) return notFound('Chat not found.');
    if (method === 'GET')
      return json({ model: NEXUS_MODEL_FINGERPRINT, entries: readNexusIndex(getDb(), id) });
    if (method === 'PUT') {
      const body = await readJson<{ entries?: unknown; model?: string }>(request);
      if (body?.model !== NEXUS_MODEL_FINGERPRINT)
        return errorResponse('Nexus model version changed. Reload the application.');
      if (
        !Array.isArray(body?.entries) ||
        body.entries.length > 64 ||
        !body.entries.every(validEmbedding)
      )
        return errorResponse('Expected up to 64 valid Nexus embeddings.');
      writeNexusIndex(getDb(), id, body.entries);
      return json({ ok: true });
    }
    return null;
  }

  // /api/chats/:id/export
  if (segments[1] === 'export' && method === 'GET') {
    const chat = store.getChat(id);
    if (!chat) return notFound('Chat not found.');

    const base = chat.title || 'chat';
    return new Response(JSON.stringify(chat, null, 4), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': contentDisposition(`${base}.json`),
      },
    });
  }

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

    /*
     * The queued save: an incremental write, not a whole-document replace.
     *
     * `order` + `upsert` describe the transcript delta (omitted for a metadata-only
     * save), `baseRevision` is the compare-and-swap the delta stands on, and `saveId`
     * makes a redelivery idempotent. The client computes the delta against the snapshot
     * the server last acknowledged, so a stale answer can only mean the server moved —
     * the client then retries once with the full document.
     */
    if (method === 'PUT') {
      const body = await readJson<SaveBody>(request);
      if (!body) return errorResponse('Request body is not valid JSON.');
      if (badRevision(body.revision) || badRevision(body.baseRevision)) {
        return errorResponse('Non-negative revision and baseRevision are required.');
      }
      if (typeof body.saveId !== 'string' || body.saveId.length === 0 || body.saveId.length > 128) {
        return errorResponse('A saveId is required.');
      }
      if (body.order !== undefined) {
        if (!Array.isArray(body.order) || !body.order.every((id) => typeof id === 'string')) {
          return errorResponse('order must be an array of message ids.');
        }
        const order = body.order as string[];
        if (new Set(order).size !== order.length) {
          return errorResponse('order contains a duplicate message id.');
        }
      }
      if (body.upsert !== undefined) {
        if (
          !Array.isArray(body.upsert) ||
          !body.upsert.every((m) => m && typeof m === 'object' && typeof m.id === 'string') ||
          body.order === undefined
        ) {
          return errorResponse('upsert must be an array of messages and requires order.');
        }
        const order = new Set(body.order as string[]);
        if (!(body.upsert as ChatMessage[]).every((m) => order.has(m.id))) {
          return errorResponse('Every upserted message must appear in order.');
        }
      }

      const input: ChatSaveInput = {
        revision: body.revision as number,
        baseRevision: body.baseRevision as number,
        saveId: body.saveId,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        ...(body.order !== undefined ? { order: body.order as string[] } : {}),
        ...(body.upsert !== undefined ? { upsert: body.upsert } : {}),
      };
      return saveResponse(store.saveChat(id, input));
    }

    if (method === 'PATCH') {
      const body = await readJson<{ revision?: number; title?: string; metadata?: ChatMetadata }>(
        request,
      );
      if (!body) return errorResponse('Request body is not valid JSON.');
      const revision = body.revision;
      if (badRevision(revision)) {
        return errorResponse('A non-negative revision is required.');
      }

      return saveResponse(
        store.updateChatMeta(id, {
          revision: revision as number,
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
