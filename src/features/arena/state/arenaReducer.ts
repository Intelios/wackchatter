/**
 * The Arena's run log.
 *
 * A *run* is one scene sent to several contenders at once. Runs stack: the Arena keeps
 * every comparison you have made this session so you can scroll back over how four models
 * handled five different probes, and nothing any of them wrote is ever fed into a later
 * run. The blind benchmark uses the same shape with exactly two entries and a log it clears
 * between rounds.
 *
 * Streaming text is deliberately absent from this state. It lives in a `StreamStore` per
 * column and reaches one leaf through `useSyncExternalStore`, exactly as the chat does —
 * so an in-flight run repaints thirty times a second without re-rendering the log above it.
 * Text arrives here only when an entry settles, which is also what lets an older run keep
 * showing its replies while a newer one is still writing.
 *
 * Every entry carries an `attempt` counter and every settling action names the attempt it
 * belongs to. Re-rolling one column while its previous request is still in flight is the
 * case that needs it: the abandoned request can still settle, and without the counter it
 * would overwrite the reply the user asked for with the one they rejected.
 */

export type EntryStatus = 'pending' | 'streaming' | 'done' | 'failed' | 'aborted';

export interface RunEntry {
  /** The pool contender this column is running. Also its index into the stream stores. */
  contenderId: string;
  /**
   * The contender's name, model and provider as they were when the run started.
   *
   * Snapshotted rather than resolved at render time: repointing a contender at a different
   * model must not relabel the replies the old one already wrote.
   */
  name: string;
  model: string;
  provider: string;
  status: EntryStatus;
  /** Which generation this column is on. Bumped by a per-column re-roll. */
  attempt: number;
  text: string;
  reasoning: string;
  error: string | null;
  /** Milliseconds to the first visible token, and to settling. Null until known. */
  firstTokenMs: number | null;
  elapsedMs: number | null;
  completionTokens: number | null;
}

export interface ArenaRun {
  id: string;
  /** The scene, kept per run so an older comparison still says what it was answering. */
  characterId: string;
  probe: string;
  startedAt: number;
  entries: RunEntry[];
}

export interface ArenaState {
  /** Oldest first. The Arena renders newest-last; the blind round keeps exactly one. */
  runs: ArenaRun[];
}

export const initialArenaState: ArenaState = { runs: [] };

export interface EntrySeed {
  contenderId: string;
  name: string;
  model: string;
  provider: string;
}

export type ArenaAction =
  | {
      type: 'run/started';
      runId: string;
      characterId: string;
      probe: string;
      at: number;
      entries: EntrySeed[];
      /** Drop every earlier run first. The blind round sets this; the Arena does not. */
      replace?: boolean;
    }
  | { type: 'entry/streaming'; runId: string; contenderId: string; attempt: number; ms: number }
  | {
      type: 'entry/settled';
      runId: string;
      contenderId: string;
      attempt: number;
      text: string;
      reasoning: string;
      /** What the provider said it served, when it said anything. */
      model?: string;
      completionTokens: number | null;
      ms: number;
    }
  | {
      type: 'entry/failed';
      runId: string;
      contenderId: string;
      attempt: number;
      message: string;
      text: string;
      reasoning: string;
      ms: number;
    }
  | {
      type: 'entry/aborted';
      runId: string;
      contenderId: string;
      attempt: number;
      text: string;
      reasoning: string;
      ms: number;
    }
  /** Re-roll one column. Bumps its attempt, which makes the old request's result inert. */
  | { type: 'entry/restarted'; runId: string; contenderId: string }
  | { type: 'run/removed'; runId: string }
  | { type: 'log/cleared' };

/** Whether every column has stopped, however it stopped. */
export function isRunSettled(run: ArenaRun): boolean {
  return run.entries.every((entry) => entry.status !== 'pending' && entry.status !== 'streaming');
}

/** Whether anything at all is still generating. */
export function isBusy(state: ArenaState): boolean {
  return state.runs.some((run) => !isRunSettled(run));
}

/**
 * Apply a change to one entry, ignoring it unless the run, the column and the attempt all
 * match. A late callback from an abandoned request lands here and does nothing, which is
 * the point: inert, not merely harmless.
 */
function updateEntry(
  state: ArenaState,
  runId: string,
  contenderId: string,
  attempt: number | null,
  change: (entry: RunEntry) => RunEntry,
): ArenaState {
  const index = state.runs.findIndex((run) => run.id === runId);
  if (index === -1) return state;

  const run = state.runs[index]!;
  const entryIndex = run.entries.findIndex((entry) => entry.contenderId === contenderId);
  if (entryIndex === -1) return state;

  const entry = run.entries[entryIndex]!;
  if (attempt !== null && entry.attempt !== attempt) return state;

  const entries = [...run.entries];
  entries[entryIndex] = change(entry);

  const runs = [...state.runs];
  runs[index] = { ...run, entries };
  return { ...state, runs };
}

function newEntry(seed: EntrySeed): RunEntry {
  return {
    contenderId: seed.contenderId,
    name: seed.name,
    model: seed.model,
    provider: seed.provider,
    status: 'pending',
    attempt: 0,
    text: '',
    reasoning: '',
    error: null,
    firstTokenMs: null,
    elapsedMs: null,
    completionTokens: null,
  };
}

export function arenaReducer(state: ArenaState, action: ArenaAction): ArenaState {
  switch (action.type) {
    case 'run/started': {
      // A duplicate id would give two runs one set of stream stores. Refuse rather than
      // append: the caller minted the id, so this is a bug, not a race.
      if (state.runs.some((run) => run.id === action.runId)) return state;

      const run: ArenaRun = {
        id: action.runId,
        characterId: action.characterId,
        probe: action.probe,
        startedAt: action.at,
        entries: action.entries.map(newEntry),
      };

      return { ...state, runs: action.replace ? [run] : [...state.runs, run] };
    }

    case 'entry/streaming':
      return updateEntry(state, action.runId, action.contenderId, action.attempt, (entry) =>
        // Only from pending: a second first-token callback must not reopen a settled column.
        entry.status === 'pending'
          ? { ...entry, status: 'streaming', firstTokenMs: action.ms }
          : entry,
      );

    case 'entry/settled':
      return updateEntry(state, action.runId, action.contenderId, action.attempt, (entry) => ({
        ...entry,
        status: 'done',
        text: action.text,
        reasoning: action.reasoning,
        // The served model when the provider named one — on OpenRouter that is how a
        // routed request reveals which upstream actually answered.
        model: action.model?.trim() ? action.model : entry.model,
        completionTokens: action.completionTokens,
        elapsedMs: action.ms,
        error: null,
      }));

    case 'entry/failed':
      return updateEntry(state, action.runId, action.contenderId, action.attempt, (entry) => ({
        ...entry,
        status: 'failed',
        // Whatever arrived before the failure is kept — a truncated reply is still evidence
        // about the model, and throwing it away would hide where it broke.
        text: action.text,
        reasoning: action.reasoning,
        error: action.message,
        elapsedMs: action.ms,
      }));

    case 'entry/aborted':
      return updateEntry(state, action.runId, action.contenderId, action.attempt, (entry) => ({
        ...entry,
        status: 'aborted',
        text: action.text,
        reasoning: action.reasoning,
        elapsedMs: action.ms,
      }));

    case 'entry/restarted':
      return updateEntry(state, action.runId, action.contenderId, null, (entry) => ({
        ...entry,
        status: 'pending',
        attempt: entry.attempt + 1,
        text: '',
        reasoning: '',
        error: null,
        firstTokenMs: null,
        elapsedMs: null,
        completionTokens: null,
      }));

    case 'run/removed':
      return { ...state, runs: state.runs.filter((run) => run.id !== action.runId) };

    case 'log/cleared':
      return initialArenaState;

    default:
      return state;
  }
}
