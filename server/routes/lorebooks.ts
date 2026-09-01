/** Standalone lorebook CRUD + import/export. */

import type { WorldInfoBook } from '../../shared/types/worldinfo.ts';
import { contentDisposition, errorResponse, json, notFound, readJson } from '../lib/http.ts';
import {
  createLorebook,
  deleteLorebook,
  getLorebook,
  listLorebooks,
  renameLorebook,
  saveLorebook,
} from '../lib/lorebooks.ts';
import { cascadeLorebookDelete, cascadeLorebookRename } from '../lib/references.ts';

export async function handleLorebookRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/lorebooks
  if (segments.length === 0) {
    if (method === 'GET') return json(listLorebooks());

    if (method === 'POST') {
      const body = await readJson<{ name?: string; book?: WorldInfoBook }>(request);
      const summary = await createLorebook(body?.name ?? 'New Lorebook', body?.book);
      return json(summary, { status: 201 });
    }
    return null;
  }

  // /api/lorebooks/import
  if (segments[0] === 'import' && method === 'POST') {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return errorResponse('No file provided.');

    try {
      const raw = JSON.parse(await file.text()) as WorldInfoBook;
      const name = file.name.replace(/\.json$/i, '');
      return json(await createLorebook(name, raw), { status: 201 });
    } catch (error) {
      return errorResponse(`Import failed: ${(error as Error).message}`);
    }
  }

  const id = decodeURIComponent(segments[0]!);

  // /api/lorebooks/:id/export — ST's own format, so the file drops straight into ST.
  if (segments[1] === 'export' && method === 'GET') {
    const book = getLorebook(id);
    if (!book) return notFound('Lorebook not found.');

    const { originalData: _drop, ...rest } = book;
    return new Response(`${JSON.stringify({ ...rest, name: id }, null, 4)}\n`, {
      headers: {
        'content-type': 'application/json',
        'content-disposition': contentDisposition(`${id}.json`),
      },
    });
  }

  // /api/lorebooks/:id/rename — a file move, because the filename is the identity and
  // a character card links to a book by that name.
  if (segments[1] === 'rename' && method === 'POST') {
    const body = await readJson<{ name?: string }>(request);
    if (!body?.name) return errorResponse('A new name is required.');

    const summary = await renameLorebook(id, body.name, (newId) =>
      cascadeLorebookRename(id, newId),
    );
    if (!summary) return notFound('Lorebook not found.');
    return json(summary);
  }

  // /api/lorebooks/:id
  if (segments.length === 1) {
    if (method === 'GET') {
      const book = getLorebook(id);
      return book ? json(book) : notFound('Lorebook not found.');
    }

    if (method === 'PUT') {
      const book = await readJson<WorldInfoBook>(request);
      if (!book) return errorResponse('Request body is not valid JSON.');

      if (!(await saveLorebook(id, book))) return notFound('Lorebook not found.');
      return json({ ok: true });
    }

    if (method === 'DELETE') {
      if (
        !(await deleteLorebook(id, async () => {
          await cascadeLorebookDelete(id);
        }))
      ) {
        return notFound('Lorebook not found.');
      }
      return json({ ok: true });
    }
  }

  return null;
}
