/**
 * Character Co-Creator session CRUD + the session's working avatar.
 *
 * There is deliberately no `POST /:id/finish`. Finish is a client sequence over the existing
 * character endpoints — create the card, patch the stashed fields onto it, then record which
 * card the session produced. Putting the stash-to-card mapping here would move card assembly
 * into a server that otherwise never builds one.
 */

import { existsSync, unlinkSync } from 'node:fs';
import type { ChatMessage, StaleChatRevision } from '../../shared/types/chat.ts';
import type {
  CardStash,
  ExampleSelection,
  SessionModelSettings,
} from '../../shared/types/cocreator.ts';
import { type CocreatorSaveResult, cocreatorStore } from '../lib/cocreator.ts';
import { atomicWrite } from '../lib/fs.ts';
import { errorResponse, json, notFound, readJson } from '../lib/http.ts';
import { PATHS, safeJoin } from '../lib/paths.ts';

interface ReplaceBody {
  revision?: number;
  title?: string;
  stash?: CardStash;
  examples?: ExampleSelection;
  settings?: SessionModelSettings;
  messages?: ChatMessage[];
}

interface PatchBody {
  revision?: number;
  title?: string;
  stash?: CardStash;
  examples?: ExampleSelection;
  settings?: SessionModelSettings;
  avatar?: string | null;
  finishedAvatar?: string | null;
}

function saveResponse(result: CocreatorSaveResult): Response {
  if (result.kind === 'saved') return json(result.session);
  if (result.kind === 'notFound') return notFound('Session not found.');
  const conflict: StaleChatRevision = result.conflict;
  // The same body shape as a chat conflict, so `staleRevisionFrom` works unchanged.
  return json({ error: 'Session changed elsewhere.', ...conflict }, { status: 409 });
}

function badRevision(revision: unknown): boolean {
  return typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0;
}

/** One file per session, named by its id, so a forged id cannot escape the directory. */
function sessionAvatarPath(id: string): string | null {
  return safeJoin(PATHS.cocreatorAvatars, `${id}.png`);
}

export async function handleCocreatorRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;
  const store = cocreatorStore();

  // /api/cocreator
  if (segments.length === 0) {
    if (method === 'GET') return json(store.listSessions());
    if (method === 'POST') {
      const body = await readJson<{ title?: string }>(request);
      return json(store.createSession({ title: body?.title }), { status: 201 });
    }
    return null;
  }

  const id = decodeURIComponent(segments[0]!);

  // /api/cocreator/:id/avatar
  if (segments[1] === 'avatar') {
    const path = sessionAvatarPath(id);
    if (!path) return errorResponse('Invalid session id.');

    if (method === 'GET') {
      if (!store.getSession(id)) return notFound('Session not found.');
      if (!existsSync(path)) return notFound('Session has no avatar.');
      return new Response(Bun.file(path), {
        headers: {
          'content-type': 'image/png',
          // The filename is stable per session, so the client cache-busts the URL with the
          // session's modification time rather than us disabling caching outright.
          'cache-control': 'no-cache',
        },
      });
    }

    if (method === 'PUT') {
      const session = store.getSession(id);
      if (!session) return notFound('Session not found.');

      const form = await request.formData();
      const file = form.get('image');
      if (!(file instanceof File)) return errorResponse('No image provided.');

      const bytes = new Uint8Array(await file.arrayBuffer());
      // The filename is derived from the id, so this is idempotent — but the row still has
      // to learn the avatar exists, and that write needs a revision like any other.
      //
      // Claimed before the bytes land: a concurrent save can move the revision on between
      // the read above and this write, and a rejected patch that had already written the
      // file would leave artwork on disk that no session names.
      const result = store.patchSession(id, {
        revision: session.revision + 1,
        avatar: `${id}.png`,
      });
      if (result.kind !== 'saved') return saveResponse(result);

      await atomicWrite(path, bytes);
      return saveResponse(result);
    }

    if (method === 'DELETE') {
      const session = store.getSession(id);
      if (!session) return notFound('Session not found.');

      // Released before the file goes, for the same reason the upload claims it first: a
      // rejected patch that had already unlinked would leave the row naming artwork that
      // `GET /:id/avatar` can no longer serve.
      const result = store.patchSession(id, { revision: session.revision + 1, avatar: null });
      if (result.kind !== 'saved') return saveResponse(result);

      if (existsSync(path)) unlinkSync(path);
      return saveResponse(result);
    }

    return null;
  }

  // /api/cocreator/:id
  if (segments.length === 1) {
    if (method === 'GET') {
      const session = store.getSession(id);
      return session ? json(session) : notFound('Session not found.');
    }

    // Whole-session write, for the same reason chats have one: granular message endpoints
    // would add a family of client-and-server-disagree bugs to save a few milliseconds.
    if (method === 'PUT') {
      const body = await readJson<ReplaceBody>(request);
      if (!body) return errorResponse('Request body is not valid JSON.');
      if (!Array.isArray(body.messages)) return errorResponse('A messages array is required.');
      if (badRevision(body.revision)) {
        return errorResponse('A non-negative revision is required.');
      }

      return saveResponse(
        store.replaceSession(id, {
          revision: body.revision as number,
          title: body.title,
          stash: body.stash,
          examples: body.examples,
          settings: body.settings,
          messages: body.messages,
        }),
      );
    }

    if (method === 'PATCH') {
      const body = await readJson<PatchBody>(request);
      if (!body) return errorResponse('Request body is not valid JSON.');
      if (badRevision(body.revision)) {
        return errorResponse('A non-negative revision is required.');
      }

      return saveResponse(
        store.patchSession(id, {
          revision: body.revision as number,
          title: body.title,
          stash: body.stash,
          examples: body.examples,
          settings: body.settings,
          // Both keys are three-state — absent, null, or a value — so they are only
          // forwarded when the body actually carried them.
          ...(Object.hasOwn(body, 'avatar') ? { avatar: body.avatar } : {}),
          ...(Object.hasOwn(body, 'finishedAvatar') ? { finishedAvatar: body.finishedAvatar } : {}),
        }),
      );
    }

    if (method === 'DELETE') {
      if (!store.deleteSession(id)) return notFound('Session not found.');
      // The working avatar is only reachable through the session, so it goes with it or the
      // directory accumulates orphans nothing can name.
      const path = sessionAvatarPath(id);
      if (path && existsSync(path)) unlinkSync(path);
      return json({ ok: true });
    }
  }

  return null;
}
