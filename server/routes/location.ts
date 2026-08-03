/**
 * Where the user's library lives.
 *
 * A group of its own rather than part of /api/settings, because the data location is not an
 * app setting: settings.json lives inside the directory this moves. Folding it into that
 * document would imply it round-trips with the rest, and invite someone to PUT it.
 */

import { type Dirent, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LocationInfo, LocationKind } from '../../shared/types/location.ts';
import { errorResponse, json, readJson } from '../lib/http.ts';
import { inspectLocation, locationWarnings, resolveDataDir } from '../lib/location.ts';
import { DEFAULT_DATA_DIR, PATHS } from '../lib/paths.ts';
import { canBrowse, chooseFolder } from '../lib/picker.ts';
import { degradedReason, RelocateError, switchDataDir } from '../lib/relocate.ts';

/** Total bytes and file count under `dir`. Opt-in, because a big gallery is not free to walk. */
function measure(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (current: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          bytes += statSync(full).size;
          files += 1;
        } catch {
          // Vanished mid-walk. A size estimate is not worth failing over.
        }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

function describe(withSize: boolean): LocationInfo {
  const resolved = resolveDataDir();
  return {
    root: PATHS.root,
    source: resolved.source,
    envLocked: resolved.source === 'env',
    defaultRoot: DEFAULT_DATA_DIR,
    unreachable: resolved.unreachable,
    reason: resolved.reason,
    warnings: locationWarnings(PATHS.root),
    canBrowse: canBrowse(),
    needsRestart: degradedReason(),
    size: withSize ? measure(PATHS.root) : null,
  };
}

export async function handleLocationRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/location
  if (segments.length === 0) {
    if (method === 'GET') {
      const url = new URL(request.url);
      return json(describe(url.searchParams.get('size') === '1'));
    }

    if (method === 'POST') {
      const body = await readJson<{ path?: string; expect?: LocationKind }>(request);
      if (!body?.path || typeof body.path !== 'string') {
        return errorResponse('A folder path is required.');
      }
      if (body.expect !== 'empty' && body.expect !== 'library') {
        return errorResponse('Check the folder before moving to it.');
      }

      try {
        const result = await switchDataDir(body.path, body.expect);
        return json({ ...result, reload: true });
      } catch (error) {
        if (error instanceof RelocateError) return errorResponse(error.message, error.status);
        throw error;
      }
    }

    return null;
  }

  // /api/location/inspect — read-only, so it stays available even when the folder is pinned.
  if (segments[0] === 'inspect' && method === 'POST') {
    const body = await readJson<{ path?: string }>(request);
    if (typeof body?.path !== 'string') return errorResponse('A folder path is required.');
    return json(inspectLocation(body.path));
  }

  // /api/location/browse — takes no body on purpose. See lib/picker.ts.
  if (segments[0] === 'browse' && method === 'POST') {
    return json(await chooseFolder());
  }

  return null;
}
