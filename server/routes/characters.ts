/** Character CRUD + import/export. */

import type { CardDataV2 } from '../../shared/types/card.ts';
import type { WorldInfoEntry } from '../../shared/types/worldinfo.ts';
import { stripPrivateFields, writeCard } from '../lib/card.ts';
import {
  addBookEntry,
  createBlankCard,
  createCharacter,
  deleteBook,
  deleteBookEntry,
  deleteCharacter,
  getCharacter,
  getCharacterImage,
  importCharacter,
  listCharacters,
  renameCharacter,
  updateBook,
  updateBookEntry,
  updateCharacter,
} from '../lib/characters.ts';
import {
  createFolder,
  deleteFolder,
  listFolders,
  moveCharacterToFolder,
  renameFolder,
} from '../lib/folders.ts';
import { contentDisposition, errorResponse, json, notFound, readJson } from '../lib/http.ts';
import { cascadeCharacterDelete, cascadeCharacterRename } from '../lib/references.ts';

export async function handleCharacterRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/characters
  if (segments.length === 0) {
    if (method === 'GET') return json(listCharacters());

    if (method === 'POST') {
      const body = await readJson<{ name?: string; folder?: string }>(request);
      const name = body?.name?.trim();
      if (!name) return errorResponse('A character name is required.');
      return json(await createCharacter(createBlankCard(name), undefined, body?.folder ?? ''), {
        status: 201,
      });
    }
    return null;
  }

  // /api/characters/import
  if (segments[0] === 'import' && method === 'POST') {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return errorResponse('No file provided.');

    const folder = form.get('folder');
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      return json(
        await importCharacter(bytes, file.name, typeof folder === 'string' ? folder : ''),
        { status: 201 },
      );
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }

  /*
   * /api/characters/folders...
   *
   * Above the :avatar decode, for the same reason `import` is: a literal segment has to be
   * claimed before anything treats it as an identity.
   *
   * A folder path contains slashes, so it travels as one percent-encoded segment exactly as
   * :avatar does — encodeURIComponent('a/b') survives URL parsing intact and decodes back.
   */
  if (segments[0] === 'folders') {
    if (segments.length === 1) {
      if (method === 'GET') return json(listFolders());

      if (method === 'POST') {
        const body = await readJson<{ path?: string }>(request);
        const created = createFolder(body?.path ?? '');
        if (!created) return errorResponse('That folder name cannot be used.');
        return json({ path: created }, { status: 201 });
      }
      return null;
    }

    // /api/characters/folders/rename — POST-gated, so a folder actually named "rename"
    // is still deletable through the branch below.
    if (segments[1] === 'rename' && segments.length === 2 && method === 'POST') {
      const body = await readJson<{ from?: string; to?: string }>(request);
      if (!body?.from || !body?.to) {
        return errorResponse('Both the current and the new folder path are required.');
      }
      try {
        const renamed = await renameFolder(body.from, body.to);
        return renamed === null ? notFound('Folder not found.') : json({ path: renamed });
      } catch (error) {
        return errorResponse((error as Error).message, 409);
      }
    }

    // /api/characters/folders/:path
    if (segments.length === 2 && method === 'DELETE') {
      const removed = await deleteFolder(decodeURIComponent(segments[1]!));
      return removed ? json(removed) : notFound('Folder not found.');
    }

    return null;
  }

  const avatar = decodeURIComponent(segments[0]!);

  // /api/characters/:avatar/image
  if (segments[1] === 'image' && method === 'GET') {
    const image = getCharacterImage(avatar);
    if (!image) return notFound('Character image not found.');
    return new Response(new Uint8Array(image), {
      headers: {
        'content-type': 'image/png',
        // The filename is stable but contents change on edit, so revalidate.
        'cache-control': 'no-cache',
      },
    });
  }

  // /api/characters/:avatar/export?format=png|json
  if (segments[1] === 'export' && method === 'GET') {
    const detail = getCharacter(avatar);
    if (!detail) return notFound('Character not found.');

    const format = new URL(request.url).searchParams.get('format') ?? 'png';
    const exported = stripPrivateFields(detail.card);
    const base = detail.name || 'character';

    if (format === 'json') {
      return new Response(JSON.stringify(exported, null, 4), {
        headers: {
          'content-type': 'application/json',
          'content-disposition': contentDisposition(`${base}.json`),
          // The URL is stable but the card changes on every edit, and a download has no
          // validator to revalidate against, so it must never be served from cache.
          'cache-control': 'no-store',
        },
      });
    }

    const image = getCharacterImage(avatar)!;
    return new Response(new Uint8Array(writeCard(image, exported)), {
      headers: {
        'content-type': 'image/png',
        'content-disposition': contentDisposition(`${base}.png`),
        // The URL is stable but the card changes on every edit, and a download has no
        // validator to revalidate against, so it must never be served from cache.
        'cache-control': 'no-store',
      },
    });
  }

  // /api/characters/:avatar/book/...
  //
  // Per-entry rather than a whole-book PUT, so the server always mutates the book as
  // stored rather than accepting one the client assembled. See mutateBook.
  if (segments[1] === 'book') {
    // /api/characters/:avatar/book/entries
    if (segments[2] === 'entries' && segments.length === 3 && method === 'POST') {
      const created = await addBookEntry(avatar);
      return created ? json(created, { status: 201 }) : notFound('Character not found.');
    }

    // /api/characters/:avatar/book/entries/:uid
    if (segments[2] === 'entries' && segments.length === 4) {
      const uid = Number(segments[3]);
      if (!Number.isInteger(uid)) return errorResponse('Entry id must be an integer.');

      if (method === 'PUT') {
        const patch = await readJson<Partial<WorldInfoEntry>>(request);
        if (!patch) return errorResponse('Request body is not valid JSON.');

        const updated = await updateBookEntry(avatar, uid, patch);
        return updated ? json(updated) : notFound('Character or entry not found.');
      }

      if (method === 'DELETE') {
        const updated = await deleteBookEntry(avatar, uid);
        return updated ? json(updated) : notFound('Character or entry not found.');
      }
    }

    // /api/characters/:avatar/book
    if (segments.length === 2) {
      if (method === 'PUT') {
        const fields = await readJson<Parameters<typeof updateBook>[1]>(request);
        if (!fields) return errorResponse('Request body is not valid JSON.');

        const updated = await updateBook(avatar, fields);
        return updated ? json(updated) : notFound('Character not found.');
      }

      if (method === 'DELETE') {
        const updated = await deleteBook(avatar);
        return updated ? json(updated) : notFound('Character has no lorebook.');
      }
    }

    return null;
  }

  /*
   * /api/characters/:avatar/folder
   *
   * Beside rename, and deliberately unlike it: a rename changes the identity and needs the
   * full cascade, while a move changes only where the file sits. Nothing else refers to a
   * card's folder, so there is nothing to keep in step.
   */
  if (segments[1] === 'folder' && method === 'POST') {
    const body = await readJson<{ folder?: string }>(request);
    if (typeof body?.folder !== 'string') return errorResponse('A destination folder is required.');

    try {
      const moved = await moveCharacterToFolder(avatar, body.folder);
      return moved === null ? notFound('Character not found.') : json({ avatar, folder: moved });
    } catch (error) {
      return errorResponse((error as Error).message, 409);
    }
  }

  // /api/characters/:avatar/rename
  if (segments[1] === 'rename' && method === 'POST') {
    const body = await readJson<{ name?: string }>(request);
    const name = body?.name?.trim();
    if (!name) return errorResponse('A new name is required.');

    const renamed = await renameCharacter(avatar, name, async (newAvatar) =>
      cascadeCharacterRename(avatar, newAvatar),
    );
    if (!renamed) return notFound('Character not found.');
    return json(renamed);
  }

  // /api/characters/:avatar
  if (segments.length === 1) {
    if (method === 'GET') {
      const detail = getCharacter(avatar);
      return detail ? json(detail) : notFound('Character not found.');
    }

    if (method === 'PATCH') {
      const contentType = request.headers.get('content-type') ?? '';

      // Multipart when an avatar image accompanies the edit.
      if (contentType.includes('multipart/form-data')) {
        const form = await request.formData();
        const rawUpdates = form.get('updates');
        const file = form.get('image');

        let updates: Partial<CardDataV2> = {};
        if (typeof rawUpdates === 'string') {
          try {
            updates = JSON.parse(rawUpdates);
          } catch {
            return errorResponse('The "updates" field is not valid JSON.');
          }
        }

        const image = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : undefined;
        const updated = await updateCharacter(avatar, updates, image);
        return updated ? json(updated) : notFound('Character not found.');
      }

      const updates = await readJson<Partial<CardDataV2>>(request);
      if (!updates) return errorResponse('Request body is not valid JSON.');

      const updated = await updateCharacter(avatar, updates);
      return updated ? json(updated) : notFound('Character not found.');
    }

    if (method === 'DELETE') {
      if (!(await deleteCharacter(avatar, async () => cascadeCharacterDelete(avatar)))) {
        return notFound('Character not found.');
      }
      return json({ ok: true });
    }
  }

  return null;
}
