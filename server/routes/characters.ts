/** Character CRUD + import/export. */

import type { CardDataV2 } from '../../shared/types/card.ts';
import { stripPrivateFields } from '../lib/card.ts';
import { writeCard } from '../lib/card.ts';
import {
  createBlankCard,
  createCharacter,
  deleteCharacter,
  getCharacter,
  getCharacterImage,
  importCharacter,
  listCharacters,
  renameCharacter,
  updateCharacter,
} from '../lib/characters.ts';
import { errorResponse, json, notFound, readJson } from '../lib/http.ts';

export async function handleCharacterRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/characters
  if (segments.length === 0) {
    if (method === 'GET') return json(listCharacters());

    if (method === 'POST') {
      const body = await readJson<{ name?: string }>(request);
      const name = body?.name?.trim();
      if (!name) return errorResponse('A character name is required.');
      return json(createCharacter(createBlankCard(name)), { status: 201 });
    }
    return null;
  }

  // /api/characters/import
  if (segments[0] === 'import' && method === 'POST') {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return errorResponse('No file provided.');

    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      return json(importCharacter(bytes, file.name), { status: 201 });
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }

  const avatar = decodeURIComponent(segments[0]!);

  // /api/characters/:avatar/image
  if (segments[1] === 'image' && method === 'GET') {
    const image = getCharacterImage(avatar);
    if (!image) return notFound('Character image not found.');
    return new Response(image, {
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
    const base = detail.name.replace(/[^\w\-. ]/g, '') || 'character';

    if (format === 'json') {
      return new Response(JSON.stringify(exported, null, 4), {
        headers: {
          'content-type': 'application/json',
          'content-disposition': `attachment; filename="${base}.json"`,
        },
      });
    }

    const image = getCharacterImage(avatar)!;
    return new Response(writeCard(image, exported), {
      headers: {
        'content-type': 'image/png',
        'content-disposition': `attachment; filename="${base}.png"`,
      },
    });
  }

  // /api/characters/:avatar/rename
  if (segments[1] === 'rename' && method === 'POST') {
    const body = await readJson<{ name?: string }>(request);
    const name = body?.name?.trim();
    if (!name) return errorResponse('A new name is required.');

    const renamed = renameCharacter(avatar, name);
    return renamed ? json(renamed) : notFound('Character not found.');
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
        const updated = updateCharacter(avatar, updates, image);
        return updated ? json(updated) : notFound('Character not found.');
      }

      const updates = await readJson<Partial<CardDataV2>>(request);
      if (!updates) return errorResponse('Request body is not valid JSON.');

      const updated = updateCharacter(avatar, updates);
      return updated ? json(updated) : notFound('Character not found.');
    }

    if (method === 'DELETE') {
      return deleteCharacter(avatar) ? json({ ok: true }) : notFound('Character not found.');
    }
  }

  return null;
}
