import { validateGroup } from '../../shared/types/group.ts';
import { groupStore } from '../lib/groups.ts';
import { errorResponse, json, notFound, readJson } from '../lib/http.ts';

export async function handleGroupRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const store = groupStore();
  if (!segments.length && request.method === 'GET') return json(store.list());
  if (!segments.length && request.method === 'POST') {
    const body = await readJson(request);
    if (!validateGroup(body))
      return errorResponse('A group needs two distinct characters and valid settings.');
    return json(store.create(body), { status: 201 });
  }
  if (segments.length !== 1) return null;
  const id = decodeURIComponent(segments[0]!);
  if (request.method === 'GET')
    return store.get(id) ? json(store.get(id)) : notFound('Group not found.');
  if (request.method === 'DELETE')
    return store.remove(id) ? json({ ok: true }) : notFound('Group not found.');
  if (request.method === 'PUT') {
    const body = await readJson<{ revision: number; config: unknown }>(request);
    if (!body || !Number.isInteger(body.revision) || !validateGroup(body.config))
      return errorResponse('Invalid group configuration.');
    if (!store.get(id)) return notFound('Group not found.');
    const saved = store.save(id, body.revision, body.config);
    return saved
      ? json(saved)
      : errorResponse('Group changed elsewhere. Reload before saving.', 409);
  }
  return null;
}
