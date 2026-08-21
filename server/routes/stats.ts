/**
 * Library statistics. Read-only, aggregated in SQL — see server/lib/stats.ts for why the
 * counting does not happen in the browser.
 */

import { json } from '../lib/http.ts';
import { statsStore } from '../lib/stats.ts';

export async function handleStatsRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/stats
  if (segments.length === 0 && method === 'GET') {
    return json(statsStore().overview());
  }

  // /api/stats/characters/<avatar>
  //
  // A card with no chats is not a 404: the stats for "nothing yet" are a real answer, and
  // the client would otherwise have to special-case a card it can see in its own library.
  if (segments.length === 2 && segments[0] === 'characters' && method === 'GET') {
    return json(statsStore().forCharacter(decodeURIComponent(segments[1]!)));
  }

  return null;
}
