/** Background gallery: list, upload, serve, delete, and import from a local ST install. */

import { existsSync } from 'node:fs';
import {
  backgroundPath,
  deleteBackground,
  importFromSillyTavern,
  listBackgrounds,
  saveBackground,
} from '../lib/backgrounds.ts';
import { errorResponse, json, notFound } from '../lib/http.ts';
import { contentTypeFor } from '../lib/images.ts';

export async function handleBackgroundRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/backgrounds
  if (segments.length === 0) {
    if (method === 'GET') return json(listBackgrounds());

    if (method === 'POST') {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) return errorResponse('No file provided.');

      try {
        return json(await saveBackground(file), { status: 201 });
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
    return null;
  }

  // Checked before the :name branch. No stored background can be named exactly "import"
  // — every one carries an image extension — but the ordering should be deliberate
  // rather than an accident of what filenames happen to be legal.
  if (segments[0] === 'import' && segments.length === 1) {
    if (method !== 'POST') return null;
    try {
      return json(importFromSillyTavern());
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }

  // /api/backgrounds/:name
  if (segments.length === 1) {
    const name = decodeURIComponent(segments[0]!);

    if (method === 'GET') {
      const path = backgroundPath(name);
      if (!path || !existsSync(path)) return notFound('Background not found.');

      return new Response(Bun.file(path), {
        headers: {
          'content-type': contentTypeFor(name),
          // Cache-busted by the client appending the modification time, matching how
          // persona avatars are served.
          'cache-control': 'no-cache',
        },
      });
    }

    if (method === 'DELETE') {
      try {
        deleteBackground(name);
        return json({ ok: true });
      } catch (error) {
        return notFound((error as Error).message);
      }
    }
  }

  return null;
}
