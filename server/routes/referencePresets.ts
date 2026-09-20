/** Reference preset routes — the read-only example folder the Preset Co-Creator reads. */

import { errorResponse, json, notFound } from '../lib/http.ts';
import {
  deleteReferencePreset,
  getReferencePreset,
  importReferencePreset,
  listReferencePresets,
} from '../lib/referencePresets.ts';

export async function handleReferencePresetRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/reference-presets
  if (segments.length === 0 && method === 'GET') {
    return json(listReferencePresets());
  }

  // /api/reference-presets/import
  if (segments[0] === 'import' && method === 'POST') {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return errorResponse('No file provided.');

    try {
      return json(await importReferencePreset(await file.text(), file.name), {
        status: 201,
      });
    } catch (error) {
      return errorResponse(`Import failed: ${(error as Error).message}`);
    }
  }

  if (segments.length === 0) return null;
  const id = decodeURIComponent(segments[0]!);

  // /api/reference-presets/:id
  if (segments.length === 1) {
    if (method === 'GET') {
      try {
        const record = getReferencePreset(id);
        return record ? json(record) : notFound('Reference preset not found.');
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }

    if (method === 'DELETE') {
      const deleted = await deleteReferencePreset(id);
      return deleted ? json({ ok: true }) : notFound('Reference preset not found.');
    }
  }

  return null;
}
