/**
 * Model Arena round history.
 *
 * Four operations and no update: a round is evidence, and evidence you can edit is not
 * evidence. The generation itself does not come through here at all — the browser drives
 * both contenders through `/api/generate` with a `connectionId` apiece, so this only ever
 * sees the finished comparison and the verdict.
 */

import type { RoundSide } from '../../shared/types/arena.ts';
import { arenaStore, isVerdict } from '../lib/arena.ts';
import { errorResponse, json, notFound, readJson } from '../lib/http.ts';

interface RecordBody {
  characterId?: unknown;
  probe?: unknown;
  left?: unknown;
  right?: unknown;
  verdict?: unknown;
}

function isSide(value: unknown): value is RoundSide {
  if (!value || typeof value !== 'object') return false;
  const side = value as Record<string, unknown>;
  return typeof side.contenderId === 'string' && side.contenderId.trim().length > 0;
}

export async function handleArenaRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;
  const store = arenaStore();

  if (segments[0] !== 'rounds') return null;

  // /api/arena/rounds
  if (segments.length === 1) {
    if (method === 'GET') return json(store.listRounds());

    if (method === 'POST') {
      const body = await readJson<RecordBody>(request);
      if (!body) return errorResponse('Request body is not valid JSON.');
      if (typeof body.characterId !== 'string' || !body.characterId.trim()) {
        return errorResponse('A characterId is required.');
      }
      if (!isSide(body.left) || !isSide(body.right)) {
        return errorResponse('Both sides must name a contender.');
      }
      if (!isVerdict(body.verdict)) {
        return errorResponse('"verdict" must be one of left, right, tie or bad.');
      }

      return json(
        store.recordRound({
          characterId: body.characterId,
          probe: typeof body.probe === 'string' ? body.probe : '',
          left: body.left,
          right: body.right,
          verdict: body.verdict,
        }),
        { status: 201 },
      );
    }

    // Emptying the whole history. Guarded by a two-click confirm in the UI rather than a
    // query parameter here — the panel is where the user can see what they are discarding.
    if (method === 'DELETE') return json({ ok: true, removed: store.clearRounds() });

    return null;
  }

  // /api/arena/rounds/:id
  if (segments.length === 2 && method === 'DELETE') {
    const id = decodeURIComponent(segments[1]!);
    if (!store.deleteRound(id)) return notFound('Round not found.');
    return json({ ok: true });
  }

  return null;
}
