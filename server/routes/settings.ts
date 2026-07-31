/** App settings, API keys and the model catalogue. */

import type { ConnectionSettings } from '../../shared/providers/types.ts';
import { isProviderId } from '../../shared/providers/types.ts';
import { listModels, testConnection } from '../lib/generate.ts';
import { errorResponse, json, notFound, readJson } from '../lib/http.ts';
import { describeKeys, setApiKey } from '../lib/secrets.ts';
import { type AppSettings, getSettings, saveSettings } from '../lib/settings.ts';

/** Settings plus key *presence*. The key values themselves never appear in a response. */
function withKeys(settings: AppSettings) {
  return { ...settings, keys: describeKeys() };
}

export async function handleSettingsRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/settings
  if (segments.length === 0) {
    if (method === 'GET') return json(withKeys(getSettings()));

    if (method === 'PUT') {
      const patch = await readJson<Partial<AppSettings>>(request);
      if (!patch) return errorResponse('Request body is not valid JSON.');
      return json(withKeys(saveSettings(patch)));
    }

    return null;
  }

  // /api/settings/keys/:provider
  if (segments[0] === 'keys' && method === 'PUT') {
    const provider = segments[1] ? decodeURIComponent(segments[1]) : '';
    if (!isProviderId(provider)) return notFound(`Unknown provider "${provider}".`);

    const body = await readJson<{ key?: string | null }>(request);
    if (!body) return errorResponse('Request body is not valid JSON.');

    setApiKey(provider, body.key ?? null);
    return json({ ok: true, present: Boolean(body.key?.trim()) });
  }

  // /api/settings/models
  if (segments[0] === 'models' && method === 'GET') {
    try {
      return json({ models: await listModels() });
    } catch (error) {
      return errorResponse((error as Error).message, 502);
    }
  }

  // /api/settings/test — the one place a client-supplied URL is accepted, and only to
  // fetch a model list with it.
  if (segments[0] === 'test' && method === 'POST') {
    const connection = await readJson<ConnectionSettings>(request);
    if (!connection?.baseUrl) return errorResponse('A baseUrl is required.');
    if (!isProviderId(connection.provider)) return errorResponse('Unknown provider.');

    return json(await testConnection(connection));
  }

  return null;
}
