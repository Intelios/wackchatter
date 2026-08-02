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
import { errorResponse, handle, notFound } from './lib/http.ts';
import { PROJECT_ROOT, ensureDataDirs } from './lib/paths.ts';
import { ensureDefaultPreset } from './lib/presets.ts';
import { handleBackgroundRoute } from './routes/backgrounds.ts';
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Reject requests whose Host or Origin header points somewhere other than loopback.
 * Binding to 127.0.0.1 is the real guard; this is defence in depth against DNS
 * rebinding and browser-based cross-site requests that reach us over loopback.
 */
function forbiddenOrigin(request: Request): boolean {
  const host = request.headers.get('host');
  if (host && !LOOPBACK_HOSTS.has(host.replace(/:\d+$/, ''))) return true;

  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return !LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return true;
  }
}

ensureDataDirs();
await ensureDefaultPreset();

type RouteHandler = (request: Request, segments: string[]) => Promise<Response | null>;

const API_ROUTES: Record<string, RouteHandler> = {
  backgrounds: handleBackgroundRoute,
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
    // Vite puts a content hash in every filename under /assets, so these are safe to keep
    // forever: a changed file is a changed URL. Anything else gets revalidated.
    const immutable = url.pathname.startsWith('/assets/');
    return new Response(Bun.file(requested), {
      headers: {
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    });
  }

  const index = join(DIST_DIR, 'index.html');
  if (!existsSync(index)) {
    return new Response('Frontend not built. Run `bun run build`.', { status: 503 });
  }
  /*
   * Never cached, and this is load-bearing rather than tidy.
   *
   * index.html is the only unhashed file, and it is what names the hashed bundles. Served
   * with no cache-control and no validator, it falls to Chrome's heuristic caching — so a
   * rebuild lands on disk, the server restarts, and the browser still runs the previous
   * build out of its own cache, bundles and all, with nothing to revalidate against. The
   * app looks unchanged and the rebuild looks broken.
   */
  return new Response(Bun.file(index), {
    headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' },
  });
}

const server = Bun.serve({
  // Loopback only. The API is unauthenticated, so it must never be reachable from
  // other hosts. Remote access would need explicit opt-in plus authentication.
  hostname: '127.0.0.1',
  port: PORT,
  // Generation can be slow; the default 10s idle timeout would cut streams off.
  idleTimeout: 255,
  fetch(request) {
    const url = new URL(request.url);
    return handle(() => {
      if (url.pathname.startsWith('/api')) {
        if (forbiddenOrigin(request)) {
          return errorResponse('Cross-origin requests are not allowed.', 403);
        }
        return serveApi(request, url);
      }
      return serveStatic(url);
    });
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
