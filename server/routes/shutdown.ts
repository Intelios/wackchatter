/**
 * Graceful shutdown endpoint.
 *
 * POST /api/shutdown tears down memoised stores, checkpoints and closes the database,
 * replies 200 so the caller knows it landed, then exits. The same quiesce() path that
 * data relocation uses — one list of stores to maintain, not two.
 */

import { json } from '../lib/http.ts';
import { quiesce } from '../lib/relocate.ts';

export async function handleShutdownRoute(
  request: Request,
  _segments: string[],
): Promise<Response | null> {
  if (request.method !== 'POST') return null;

  quiesce();

  const response = json({ ok: true });

  // Let the response flush before the process exits. Bun handles setImmediate like Node.
  setImmediate(() => process.exit(0));

  return response;
}
