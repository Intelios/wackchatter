/** Preset CRUD + import/export. */

import { serializePreset } from '../../shared/prompt/preset-io.ts';
import type { Preset } from '../../shared/types/preset.ts';
import { errorResponse, json, notFound, readJson } from '../lib/http.ts';
import { deletePreset, getPreset, importPreset, listPresets, savePreset } from '../lib/presets.ts';

export async function handlePresetRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/presets
  if (segments.length === 0 && method === 'GET') {
    return json(listPresets());
  }

  // /api/presets/import
  if (segments[0] === 'import' && method === 'POST') {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return errorResponse('No file provided.');

    try {
      const raw = JSON.parse(await file.text());
      return json(await importPreset(raw, file.name), { status: 201 });
    } catch (error) {
      return errorResponse(`Import failed: ${(error as Error).message}`);
    }
  }

  if (segments.length === 0) return null;
  const id = decodeURIComponent(segments[0]!);

  // /api/presets/:id/export
  if (segments[1] === 'export' && method === 'GET') {
    const preset = getPreset(id);
    if (!preset) return notFound('Preset not found.');

    return new Response(serializePreset(preset), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="${id.replace(/[^\w\-. ]/g, '')}.json"`,
      },
    });
  }

  // /api/presets/:id
  if (segments.length === 1) {
    if (method === 'GET') {
      const preset = getPreset(id);
      return preset ? json(preset) : notFound('Preset not found.');
    }

    if (method === 'PUT') {
      const preset = await readJson<Preset>(request);
      if (!preset) return errorResponse('Request body is not valid JSON.');

      await savePreset(id, preset);
      return json({ ok: true });
    }

    if (method === 'DELETE') {
      return deletePreset(id) ? json({ ok: true }) : notFound('Preset not found.');
    }
  }

  return null;
}
