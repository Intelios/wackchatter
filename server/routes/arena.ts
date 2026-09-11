/**
 * Model Arena round and tournament history.
 *
 * Rounds and matches are evidence: written once, never edited, no update endpoint. A
 * tournament *definition* is a plan, so it is the one thing here that may change — a name
 * and an active/abandoned flag. The generation itself does not come through here at all —
 * the browser drives every contender through `/api/generate` with a `connectionId` apiece,
 * so this only ever sees the finished comparison and the verdict.
 */

import type { RoundSide, TournamentSize, TournamentStage } from '../../shared/types/arena.ts';
import { tournamentStageMatches, tournamentStages } from '../../shared/types/arena.ts';
import { arenaStore, isVerdict } from '../lib/arena.ts';
import { errorResponse, json, notFound, readJson } from '../lib/http.ts';
import {
  isTournamentSize,
  isTournamentStatus,
  isTournamentVerdict,
  tournamentStore,
} from '../lib/tournaments.ts';

interface RecordBody {
  characterId?: unknown;
  probe?: unknown;
  left?: unknown;
  right?: unknown;
  verdict?: unknown;
}

interface TournamentBody {
  name?: unknown;
  size?: unknown;
  entrants?: unknown;
  stages?: unknown;
}

interface TournamentPatchBody {
  name?: unknown;
  status?: unknown;
}

interface MatchBody {
  stage?: unknown;
  matchIndex?: unknown;
  left?: unknown;
  right?: unknown;
  verdict?: unknown;
  rerolled?: unknown;
}

function isSide(value: unknown): value is RoundSide {
  if (!value || typeof value !== 'object') return false;
  const side = value as Record<string, unknown>;
  return typeof side.contenderId === 'string' && side.contenderId.trim().length > 0;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Entrants as supplied: exactly `size` distinct non-empty ids, in bracket-slot order. */
function isEntrants(value: unknown, size: TournamentSize): value is string[] {
  if (!Array.isArray(value) || value.length !== size) return false;
  const ids = value.filter((entry): entry is string => isNonBlank(entry));
  return ids.length === size && new Set(ids).size === size;
}

/**
 * The stage plan: one card and one cue per stage, all present at creation.
 *
 * The plan is fixed up front — a bracket whose later rounds ask a different question than
 * the one you set when you entered is a different tournament — so an unfinished stage is a
 * rejected create rather than something to fill in later.
 */
function isStages(value: unknown, size: TournamentSize): value is TournamentStage[] {
  if (!Array.isArray(value) || value.length !== tournamentStages(size)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const stage = entry as Record<string, unknown>;
    return isNonBlank(stage.characterId) && isNonBlank(stage.cue);
  });
}

export async function handleArenaRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/arena/tournaments...
  if (segments[0] === 'tournaments') return handleTournaments(request, segments, method);

  const store = arenaStore();

  // /api/arena/contenders/:id
  if (segments[0] === 'contenders' && segments.length === 2 && method === 'DELETE') {
    const id = decodeURIComponent(segments[1]!);
    const removed = store.deleteContender(id);
    return json({ ok: true, removed });
  }

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

async function handleTournaments(
  request: Request,
  segments: string[],
  method: string,
): Promise<Response | null> {
  const store = tournamentStore();

  // /api/arena/tournaments
  if (segments.length === 1) {
    if (method === 'GET') return json(store.listTournaments());

    if (method === 'POST') {
      const body = await readJson<TournamentBody>(request);
      if (!body) return errorResponse('Request body is not valid JSON.');
      if (!isNonBlank(body.name)) return errorResponse('A tournament name is required.');
      if (!isTournamentSize(body.size)) {
        return errorResponse('"size" must be 4, 8 or 16.');
      }
      if (!isEntrants(body.entrants, body.size)) {
        return errorResponse(`A tournament of ${body.size} needs ${body.size} distinct entrants.`);
      }
      if (!isStages(body.stages, body.size)) {
        return errorResponse(
          `Every one of the ${tournamentStages(body.size)} stages needs a card and a cue.`,
        );
      }

      return json(
        store.createTournament({
          name: body.name.trim(),
          size: body.size,
          entrants: body.entrants,
          stages: body.stages,
        }),
        { status: 201 },
      );
    }

    return null;
  }

  if (segments.length === 2) {
    const id = decodeURIComponent(segments[1]!);

    // Rename and/or abandon — the plan's only mutable fields. Not a match: matches are
    // evidence and have no update path anywhere.
    if (method === 'PATCH') {
      const body = await readJson<TournamentPatchBody>(request);
      if (!body) return errorResponse('Request body is not valid JSON.');
      if (body.name !== undefined && !isNonBlank(body.name)) {
        return errorResponse('A tournament name cannot be blank.');
      }
      if (body.status !== undefined && !isTournamentStatus(body.status)) {
        return errorResponse('"status" must be active or abandoned.');
      }

      const updated = store.updateTournament(id, {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      });
      if (!updated) return notFound('Tournament not found.');
      return json(updated);
    }

    if (method === 'DELETE') {
      if (!store.deleteTournament(id)) return notFound('Tournament not found.');
      return json({ ok: true });
    }

    return null;
  }

  // /api/arena/tournaments/:id/matches
  if (segments.length === 3 && segments[2] === 'matches' && method === 'POST') {
    const id = decodeURIComponent(segments[1]!);
    const tournament = store.getTournament(id);
    if (!tournament) return notFound('Tournament not found.');

    const body = await readJson<MatchBody>(request);
    if (!body) return errorResponse('Request body is not valid JSON.');
    if (!isIndex(body.stage) || body.stage < 0 || body.stage >= tournament.stages.length) {
      return errorResponse('"stage" is not a stage of this tournament.');
    }
    const perStage = tournamentStageMatches(tournament.size, body.stage);
    if (!isIndex(body.matchIndex) || body.matchIndex < 0 || body.matchIndex >= perStage) {
      return errorResponse('"matchIndex" is not a slot in this stage.');
    }
    if (!isSide(body.left) || !isSide(body.right)) {
      return errorResponse('Both sides must name a contender.');
    }
    if (body.left.contenderId === body.right.contenderId) {
      return errorResponse('A contender cannot fight itself.');
    }
    if (!isTournamentVerdict(body.verdict)) {
      return errorResponse('"verdict" must be left or right.');
    }

    const result = store.recordMatch({
      tournamentId: id,
      stage: body.stage,
      matchIndex: body.matchIndex,
      left: body.left,
      right: body.right,
      verdict: body.verdict,
      rerolled: body.rerolled === true,
    });

    if (!result.ok) {
      if (result.error === 'slot-taken') {
        return errorResponse('This match has already been recorded.', 409);
      }
      if (result.error === 'stage-missing') {
        return errorResponse('This stage has no card and cue in the plan.');
      }
      return notFound('Tournament not found.');
    }
    return json(result.match, { status: 201 });
  }

  return null;
}
