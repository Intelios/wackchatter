/**
 * WackChatter server.
 *
 * Deliberately thin: files, database and a streaming proxy. Prompt assembly happens in
 * the browser (see shared/prompt), so the server never needs to know what a preset means.
 *
 * Dev:  vite on 5173 proxies /api here.
 * Prod: this process serves dist/ and /api on one port.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { handle, notFound } from './lib/http.ts';
import { PROJECT_ROOT, ensureDataDirs } from './lib/paths.ts';
import { ensureDefaultPreset } from './lib/presets.ts';
import { handleCharacterRoute } from './routes/characters.ts';
import { handleChatRoute } from './routes/chats.ts';
import { handleGenerateRoute } from './routes/generate.ts';
import { handleLorebookRoute } from './routes/lorebooks.ts';
import { handlePersonaRoute } from './routes/personas.ts';
import { handlePresetRoute } from './routes/presets.ts';
import { handleSettingsRoute } from './routes/settings.ts';

const PORT = Number(process.env.WC_PORT ?? 8787);
const IS_PROD = process.env.NODE_ENV === 'production';
const DIST_DIR = join(PROJECT_ROOT, 'dist');

ensureDataDirs();
await ensureDefaultPreset();

type RouteHandler = (request: Request, segments: string[]) => Promise<Response | null>;

const API_ROUTES: Record<string, RouteHandler> = {
  characters: handleCharacterRoute,
  presets: handlePresetRoute,
  lorebooks: handleLorebookRoute,
  personas: handlePersonaRoute,
  chats: handleChatRoute,
  generate: handleGenerateRoute,
  settings: handleSettingsRoute,
};

async function serveApi(request: Request, url: URL): Promise<Response> {
  const parts = url.pathname
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean);
  const [group, ...segments] = parts;

  if (!group) return notFound('No API route specified.');

  const route = API_ROUTES[group];
  if (!route) return notFound(`Unknown API route "/${group}".`);

  const response = await route(request, segments);
  return response ?? notFound(`No handler for ${request.method} ${url.pathname}.`);
}

/** Serve the built frontend, falling back to index.html so client routing works. */
async function serveStatic(url: URL): Promise<Response> {
  if (!IS_PROD) {
    return new Response(
      'WackChatter API is running.\n\nStart the frontend with `bun run dev:client` ' +
        'and open http://localhost:5173\n',
      { headers: { 'content-type': 'text/plain' } },
    );
  }

  const requested = join(DIST_DIR, url.pathname);
  if (url.pathname !== '/' && existsSync(requested)) {
    return new Response(Bun.file(requested));
  }

  const index = join(DIST_DIR, 'index.html');
  if (!existsSync(index)) {
    return new Response('Frontend not built. Run `bun run build`.', { status: 503 });
  }
  return new Response(Bun.file(index), { headers: { 'content-type': 'text/html' } });
}

const server = Bun.serve({
  port: PORT,
  // Generation can be slow; the default 10s idle timeout would cut streams off.
  idleTimeout: 255,
  fetch(request) {
    const url = new URL(request.url);
    return handle(() =>
      url.pathname.startsWith('/api') ? serveApi(request, url) : serveStatic(url),
    );
  },
});

const appUrl = IS_PROD ? `http://localhost:${server.port}` : 'http://localhost:5173';
console.log(`  WackChatter API   http://localhost:${server.port}`);
console.log(`  App               ${appUrl}`);

if (IS_PROD && process.env.WC_NO_OPEN !== '1') {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  Bun.spawn([opener, appUrl], { stdout: 'ignore', stderr: 'ignore' });
}
