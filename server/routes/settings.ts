/** App settings, API keys, the connection list and the model catalogue. */

import type { Connection } from '../../shared/providers/types.ts';
import { isProviderId } from '../../shared/providers/types.ts';
import { listModels, testConnection } from '../lib/generate.ts';
import { errorResponse, json, notFound, readJson } from '../lib/http.ts';
import { describeKeys, pruneApiKeys, setApiKey } from '../lib/secrets.ts';
import {
  type AppSettings,
  addConnection,
  deleteConnectionEntry,
  getSettings,
  patchConnectionEntry,
  sameEndpoint,
  saveSettings,
} from '../lib/settings.ts';

/** Settings plus key *presence*. The key values themselves never appear in a response. */
function withKeys(settings: AppSettings) {
  return {
    ...settings,
    keys: describeKeys(settings.connections.map((connection) => connection.id)),
  };
}

export async function handleSettingsRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/settings
  if (segments.length === 0) {
    if (method === 'GET') return json(withKeys(getSettings()));

    // The connection list cannot change through this route — `mergeSettings` pins it.
    // List mutations go through the per-connection endpoints below, so a stale tab or
    // a malformed body can never delete connections (and with them, their keys).
    if (method === 'PUT') {
      const patch = await readJson<Partial<AppSettings>>(request);
      if (!patch) return errorResponse('Request body is not valid JSON.');
      return json(withKeys(saveSettings(patch)));
    }

    return null;
  }

  // /api/settings/connections — create. Id and name are minted server-side.
  if (segments[0] === 'connections' && segments.length === 1 && method === 'POST') {
    const body = await readJson<{ provider?: unknown }>(request);
    if (!body) return errorResponse('Request body is not valid JSON.');
    const provider = isProviderId(body.provider) ? body.provider : 'custom';
    return json(withKeys(addConnection(provider)));
  }

  // /api/settings/connections/:id/models — catalogue without activating the connection.
  if (
    segments[0] === 'connections' &&
    segments.length === 3 &&
    segments[2] === 'models' &&
    method === 'GET'
  ) {
    const id = decodeURIComponent(segments[1] ?? '');
    const connection = getSettings().connections.find((entry) => entry.id === id);
    if (!connection) return notFound(`Unknown connection "${id}".`);
    try {
      return json({ models: await listModels(connection) });
    } catch (error) {
      return errorResponse((error as Error).message, 502);
    }
  }

  // /api/settings/connections/:id — edit or delete one entry.
  if (segments[0] === 'connections' && segments.length === 2) {
    const id = decodeURIComponent(segments[1] ?? '');

    if (method === 'PATCH') {
      const patch = await readJson<Record<string, unknown>>(request);
      if (!patch) return errorResponse('Request body is not valid JSON.');

      const before = getSettings().connections.find((connection) => connection.id === id);
      if (!before) return notFound(`Unknown connection "${id}".`);

      const saved = patchConnectionEntry(id, patch);
      if (!saved) return notFound(`Unknown connection "${id}".`);

      // The key belongs to the endpoint, not the entry: a provider or base-URL change
      // moves the connection somewhere the old key was never meant for, so it is
      // dropped rather than sent there.
      const after = saved.connections.find((connection) => connection.id === id);
      if (after && !sameEndpoint(before, after)) setApiKey(id, null);

      return json(withKeys(saved));
    }

    if (method === 'DELETE') {
      const saved = deleteConnectionEntry(id);
      if (!saved) return notFound(`Unknown connection "${id}".`);

      // The deleted connection takes its key with it. The prune also sweeps orphans
      // (a key left under a legacy provider id, say); it is safe here because the id
      // list is server-derived, never client-supplied.
      setApiKey(id, null);
      pruneApiKeys(saved.connections.map((connection) => connection.id));

      return json(withKeys(saved));
    }

    return null;
  }

  // /api/settings/keys/:connectionId
  if (segments[0] === 'keys' && method === 'PUT') {
    const connectionId = segments[1] ? decodeURIComponent(segments[1]) : '';
    if (!getSettings().connections.some((connection) => connection.id === connectionId)) {
      return notFound(`Unknown connection "${connectionId}".`);
    }

    const body = await readJson<{ key?: string | null }>(request);
    if (!body) return errorResponse('Request body is not valid JSON.');

    setApiKey(connectionId, body.key ?? null);
    return json({ ok: true, present: Boolean(body.key?.trim()) });
  }

  // /api/settings/models — the catalogue of the active connection.
  if (segments[0] === 'models' && method === 'GET') {
    try {
      return json({ models: await listModels() });
    } catch (error) {
      return errorResponse((error as Error).message, 502);
    }
  }

  // /api/settings/test — the one place a client-supplied URL is accepted, and only to
  // fetch a model list with it. The id must name a stored connection, and the stored
  // key is attached ONLY when the submitted endpoint is the stored one: a real id
  // paired with a forged baseUrl must not receive that connection's Authorization
  // header. A changed endpoint is probed keyless — its key was dropped when it moved.
  if (segments[0] === 'test' && method === 'POST') {
    const connection = await readJson<Connection>(request);
    if (!connection?.baseUrl) return errorResponse('A baseUrl is required.');
    if (!isProviderId(connection.provider)) return errorResponse('Unknown provider.');

    const stored = getSettings().connections.find((entry) => entry.id === connection.id);
    if (!stored) return errorResponse('Unknown connection.');

    return json(await testConnection(connection, sameEndpoint(stored, connection)));
  }

  return null;
}
