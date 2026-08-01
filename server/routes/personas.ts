/** Persona CRUD + avatar upload. */

import { existsSync } from 'node:fs';
import type { Persona } from '../../shared/types/chat.ts';
import { errorResponse, json, notFound, readJson } from '../lib/http.ts';
import {
  avatarContentType,
  avatarPath,
  createPersona,
  deletePersona,
  getPersona,
  listPersonas,
  savePersona,
  setPersonaAvatar,
} from '../lib/personas.ts';

export async function handlePersonaRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/personas
  if (segments.length === 0) {
    if (method === 'GET') return json(listPersonas());

    if (method === 'POST') {
      const body = await readJson<{ name?: string }>(request);
      return json(await createPersona(body?.name ?? 'You'), { status: 201 });
    }
    return null;
  }

  const id = decodeURIComponent(segments[0]!);

  // /api/personas/:id/avatar
  if (segments[1] === 'avatar') {
    if (method === 'GET') {
      const persona = getPersona(id);
      if (!persona?.avatar) return notFound('Persona has no avatar.');

      const path = avatarPath(persona.avatar);
      if (!path || !existsSync(path)) return notFound('Avatar file is missing.');

      return new Response(Bun.file(path), {
        headers: {
          'content-type': avatarContentType(persona.avatar),
          // Filenames are stable per persona, so the URL is cache-busted by the client
          // appending the modification time rather than by a no-store header here.
          'cache-control': 'no-cache',
        },
      });
    }

    if (method === 'POST') {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) return errorResponse('No file provided.');

      try {
        return json(await setPersonaAvatar(id, file));
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
  }

  // /api/personas/:id
  if (segments.length === 1) {
    if (method === 'GET') {
      const persona = getPersona(id);
      return persona ? json(persona) : notFound('Persona not found.');
    }

    if (method === 'PATCH' || method === 'PUT') {
      if (!getPersona(id)) return notFound('Persona not found.');

      const patch = await readJson<Partial<Persona>>(request);
      if (!patch) return errorResponse('Request body is not valid JSON.');

      return json(await savePersona(id, patch));
    }

    if (method === 'DELETE') {
      return deletePersona(id) ? json({ ok: true }) : notFound('Persona not found.');
    }
  }

  return null;
}
