/**
 * Character Co-Creator session storage.
 *
 * The same shape as `chats.ts` and for the same reasons: one whole-session write guarded by
 * a monotonic revision, and every message repaired through `shared/chat/message.ts` on the
 * way in, so an inconsistent row is impossible to store even if a client tries.
 *
 * Two deliberate differences from the chat store, both worth keeping:
 *
 *  - **A delete writes no backup.** A chat transcript is irreplaceable, which is why
 *    `deleteChat` fills the trash bin. A design session is a scratchpad whose product — the
 *    card — already exists on disk once Finish has run. Backing these up would fill
 *    `data/backups/` with working notes. Do not "fix" the asymmetry.
 *  - **No `name` column on messages.** A session has exactly two speakers, so the label is
 *    UI text rather than per-row data. `normalizeState` still wants one, so the reader
 *    supplies a constant and the writer drops it.
 */

import type { Database } from 'bun:sqlite';
import { fromChatMessage, normalizeState, toChatMessage } from '../../shared/chat/message.ts';
import { emptyStash, normalizeStash, stashedSlotCount } from '../../shared/cocreator/stash.ts';
import type { ChatMessage, StaleChatRevision } from '../../shared/types/chat.ts';
import {
  type CardStash,
  type CocreatorSession,
  type CocreatorSessionSummary,
  DEFAULT_EXAMPLE_FIELDS,
  type ExampleFields,
  type ExampleSelection,
  type SessionModelSettings,
} from '../../shared/types/cocreator.ts';
import { getDb } from './db.ts';

/**
 * The label rows are read back under.
 *
 * Not stored, and not the client's `DESIGNER_NAME` / `ASSISTANT_NAME` either — those are the
 * display strings. `normalizeState` requires a non-empty name; nothing downstream of the
 * store reads it, because the transcript renders from `is_user`.
 */
const ROW_NAME = 'message';

interface SessionRow {
  id: string;
  title: string;
  created: number;
  modified: number;
  revision: number;
  stash: string;
  examples: string;
  settings: string;
  avatar: string | null;
  finished_avatar: string | null;
}

interface MessageRow {
  id: string;
  position: number;
  is_user: number;
  swipe_id: number;
  swipes: string;
  swipe_info: string;
}

export type CocreatorSaveResult =
  | { kind: 'saved'; session: CocreatorSession }
  | { kind: 'notFound' }
  | { kind: 'stale'; conflict: StaleChatRevision };

export interface CocreatorPatch {
  revision: number;
  title?: string;
  stash?: CardStash;
  examples?: ExampleSelection;
  settings?: SessionModelSettings;
  /** Explicit null clears it; absent leaves it alone. */
  avatar?: string | null;
  finishedAvatar?: string | null;
}

export interface CocreatorStore {
  listSessions(): CocreatorSessionSummary[];
  getSession(id: string): CocreatorSession | null;
  createSession(input: { title?: string }): CocreatorSession;
  /** Whole-session write: the only path that changes messages. */
  replaceSession(
    id: string,
    input: {
      revision: number;
      title?: string;
      stash?: CardStash;
      examples?: ExampleSelection;
      settings?: SessionModelSettings;
      finishedAvatar?: string | null;
      messages: ChatMessage[];
    },
  ): CocreatorSaveResult;
  /** Metadata-only write. Never touches the transcript. */
  patchSession(id: string, patch: CocreatorPatch): CocreatorSaveResult;
  /**
   * Write the avatar column without touching the revision counter.
   *
   * The avatar routes are the column's only writer, and `replaceSession` preserves whatever
   * is there (`commit` writes `existing.avatar`), so the two write families commute — there
   * is nothing for a revision to arbitrate. Minting one here anyway used to collide with the
   * client's own next revision whenever artwork landed while a debounced save was in flight,
   * and the client's Finish flush then died on a 409 it had no way to rebase from. The same
   * reasoning as `reassignExampleCard`'s deliberately missing bump, minus the "repair"
   * qualifier: this is a user edit, but one the revision counter cannot see on either side.
   */
  setSessionAvatar(id: string, avatar: string | null): CocreatorSession | null;
  deleteSession(id: string): boolean;
  /**
   * Repoint (or drop, for a null) an attached example card across every session.
   *
   * Sessions hold avatar filenames, so a character rename strands them exactly as it would
   * strand a chat's `character_id` — hence the same cascade, and for the same reason the
   * chat store's `reassignCharacter` exists. Returns how many sessions changed.
   */
  reassignExampleCard(oldAvatar: string, newAvatar: string | null): number;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Repair an examples selection: unknown keys dropped, missing toggles defaulted. */
export function normalizeExamples(raw: unknown): ExampleSelection {
  const value = (raw ?? {}) as Partial<ExampleSelection>;
  const cards = Array.isArray(value.cards)
    ? value.cards.filter((card): card is string => typeof card === 'string' && card.length > 0)
    : [];
  const stored = (value.fields ?? {}) as Partial<ExampleFields>;
  const fields = { ...DEFAULT_EXAMPLE_FIELDS } as ExampleFields;
  for (const key of Object.keys(DEFAULT_EXAMPLE_FIELDS) as (keyof ExampleFields)[]) {
    if (typeof stored[key] === 'boolean') fields[key] = stored[key];
  }
  // De-duplicated: attaching the same card twice would double its tokens for nothing.
  return { cards: [...new Set(cards)], fields };
}

/**
 * Repair per-session model overrides.
 *
 * Absence is meaningful — it means "follow the app setting" — so a key is only kept when it
 * is actually present and of the right type. Writing a null for a missing key would silently
 * pin the session to today's default.
 */
export function normalizeSessionSettings(raw: unknown): SessionModelSettings {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw as Record<string, unknown>;
  const settings: SessionModelSettings = {};
  if (typeof value.connectionId === 'string' || value.connectionId === null) {
    settings.connectionId = value.connectionId as string | null;
  }
  if (typeof value.presetId === 'string' || value.presetId === null) {
    settings.presetId = value.presetId as string | null;
  }
  if (typeof value.systemPrompt === 'string' && value.systemPrompt.trim()) {
    settings.systemPrompt = value.systemPrompt;
  }
  if (typeof value.analysisPrompt === 'string' && value.analysisPrompt.trim()) {
    settings.analysisPrompt = value.analysisPrompt;
  }
  const modelOverride = value.modelOverride;
  if (
    modelOverride &&
    typeof modelOverride === 'object' &&
    typeof (modelOverride as Record<string, unknown>).connectionId === 'string' &&
    typeof (modelOverride as Record<string, unknown>).model === 'string' &&
    ((modelOverride as Record<string, unknown>).connectionId as string).trim() &&
    ((modelOverride as Record<string, unknown>).model as string).trim()
  ) {
    settings.modelOverride = {
      connectionId: (modelOverride as Record<string, unknown>).connectionId as string,
      model: ((modelOverride as Record<string, unknown>).model as string).trim(),
    };
  }
  return settings;
}

function rowToMessage(row: MessageRow): ChatMessage {
  return toChatMessage(
    normalizeState({
      id: row.id,
      name: ROW_NAME,
      is_user: row.is_user === 1,
      is_system: false,
      swipes: parseJson<string[]>(row.swipes, ['']),
      swipe_id: row.swipe_id,
      swipe_info: parseJson(row.swipe_info, []),
    }),
  );
}

export function createCocreatorStore(database: Database): CocreatorStore {
  const statements = {
    insertSession: database.query(
      `INSERT INTO cocreator_sessions
         (id, title, created, modified, revision, stash, examples, settings, avatar, finished_avatar)
       VALUES ($id, $title, $created, $modified, $revision, $stash, $examples, $settings, NULL, NULL)`,
    ),
    selectSession: database.query<SessionRow, [string]>(
      'SELECT * FROM cocreator_sessions WHERE id = ?',
    ),
    updateSession: database.query(
      `UPDATE cocreator_sessions
          SET title = $title, stash = $stash, examples = $examples, settings = $settings,
              avatar = $avatar, finished_avatar = $finishedAvatar,
              modified = $modified, revision = $revision
        WHERE id = $id`,
    ),
    deleteSession: database.query('DELETE FROM cocreator_sessions WHERE id = ?'),

    selectMessages: database.query<MessageRow, [string]>(
      'SELECT * FROM cocreator_messages WHERE session_id = ? ORDER BY position ASC',
    ),
    deleteMessages: database.query('DELETE FROM cocreator_messages WHERE session_id = ?'),
    selectAllExamples: database.query<{ id: string; examples: string }, []>(
      'SELECT id, examples FROM cocreator_sessions',
    ),
    updateExamples: database.query(
      'UPDATE cocreator_sessions SET examples = $examples WHERE id = $id',
    ),
    insertMessage: database.query(
      `INSERT INTO cocreator_messages
         (session_id, id, position, is_user, swipe_id, swipes, swipe_info)
       VALUES ($sessionId, $id, $position, $isUser, $swipeId, $swipes, $swipeInfo)`,
    ),
  };

  // The current swipe's text as the preview, taken live rather than denormalised into a
  // column that could disagree with the message it summarises — same as the chat store.
  const listAll = database.query<
    Omit<CocreatorSessionSummary, 'stashedSlots'> & {
      lastMessage: string | null;
      stash: string;
    },
    []
  >(`
    SELECT s.id, s.title, s.created, s.modified, s.avatar,
      s.finished_avatar AS finishedAvatar, s.stash,
      (SELECT COUNT(*) FROM cocreator_messages m WHERE m.session_id = s.id) AS messageCount,
      (SELECT substr(json_extract(m.swipes, '$[' || m.swipe_id || ']'), 1, 200)
         FROM cocreator_messages m WHERE m.session_id = s.id
        ORDER BY m.position DESC LIMIT 1) AS lastMessage
    FROM cocreator_sessions s
    ORDER BY s.modified DESC`);

  function writeMessages(sessionId: string, messages: ChatMessage[]): void {
    statements.deleteMessages.run(sessionId);

    messages.forEach((message, position) => {
      // Repair on the way in, so the row can only ever hold a consistent message.
      const state = fromChatMessage(message);
      statements.insertMessage.run({
        $sessionId: sessionId,
        $id: state.id,
        $position: position,
        $isUser: state.is_user ? 1 : 0,
        $swipeId: state.swipe_id,
        $swipes: JSON.stringify(state.swipes),
        $swipeInfo: JSON.stringify(state.swipe_info),
      });
    });
  }

  function readSession(id: string): CocreatorSession | null {
    const row = statements.selectSession.get(id);
    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      created: row.created,
      modified: row.modified,
      revision: row.revision,
      stash: normalizeStash(parseJson<unknown>(row.stash, null)),
      examples: normalizeExamples(parseJson<unknown>(row.examples, null)),
      settings: normalizeSessionSettings(parseJson<unknown>(row.settings, null)),
      avatar: row.avatar,
      finishedAvatar: row.finished_avatar,
      messages: statements.selectMessages.all(id).map(rowToMessage),
    };
  }

  function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => toChatMessage(fromChatMessage(message)));
  }

  /** Write the merged session row. Callers have already resolved the revision race. */
  function commit(
    id: string,
    next: Omit<CocreatorSession, 'messages' | 'created' | 'modified'>,
  ): void {
    statements.updateSession.run({
      $id: id,
      $title: next.title,
      $stash: JSON.stringify(next.stash),
      $examples: JSON.stringify(next.examples),
      $settings: JSON.stringify(next.settings),
      $avatar: next.avatar,
      $finishedAvatar: next.finishedAvatar,
      $modified: Date.now(),
      $revision: next.revision,
    });
  }

  /**
   * The revision race, resolved identically for both write paths.
   *
   * Three branches, matching the chat store: below the stored revision is always stale; at it
   * is stale unless the content is byte-identical, which makes a duplicate retry idempotent
   * rather than an error; above it wins.
   */
  function checkRevision(
    existing: CocreatorSession,
    revision: number,
    identical: () => boolean,
  ): CocreatorSaveResult | null {
    if (revision < existing.revision) {
      return {
        kind: 'stale',
        conflict: { code: 'stale_revision', currentRevision: existing.revision },
      };
    }
    if (revision === existing.revision) {
      if (identical()) return { kind: 'saved', session: existing };
      return {
        kind: 'stale',
        conflict: { code: 'stale_revision', currentRevision: existing.revision },
      };
    }
    return null;
  }

  const saveWholeSession = database.transaction(
    (
      id: string,
      input: {
        revision: number;
        title?: string;
        stash?: CardStash;
        examples?: ExampleSelection;
        settings?: SessionModelSettings;
        finishedAvatar?: string | null;
        messages: ChatMessage[];
      },
    ): CocreatorSaveResult => {
      const existing = readSession(id);
      if (!existing) return { kind: 'notFound' };

      const title = input.title?.trim() || existing.title;
      const stash = input.stash ? normalizeStash(input.stash) : existing.stash;
      const examples = input.examples ? normalizeExamples(input.examples) : existing.examples;
      const settings = input.settings
        ? normalizeSessionSettings(input.settings)
        : existing.settings;
      const messages = normalizeMessages(input.messages);
      // Absent means "keep what is there" — a whole-session save that predates the field, or
      // one the client has no reason to change, must not clear the recording.
      const finishedAvatar =
        input.finishedAvatar === undefined ? existing.finishedAvatar : input.finishedAvatar;

      const conflict = checkRevision(
        existing,
        input.revision,
        () =>
          title === existing.title &&
          finishedAvatar === existing.finishedAvatar &&
          JSON.stringify(stash) === JSON.stringify(existing.stash) &&
          JSON.stringify(examples) === JSON.stringify(existing.examples) &&
          JSON.stringify(settings) === JSON.stringify(existing.settings) &&
          JSON.stringify(messages) === JSON.stringify(existing.messages),
      );
      if (conflict) return conflict;

      commit(id, {
        id,
        title,
        revision: input.revision,
        stash,
        examples,
        settings,
        avatar: existing.avatar,
        finishedAvatar,
      });
      writeMessages(id, messages);
      return { kind: 'saved', session: readSession(id)! };
    },
  );

  const savePatch = database.transaction(
    (id: string, patch: CocreatorPatch): CocreatorSaveResult => {
      const existing = readSession(id);
      if (!existing) return { kind: 'notFound' };

      const title = patch.title?.trim() || existing.title;
      const stash = patch.stash ? normalizeStash(patch.stash) : existing.stash;
      const examples = patch.examples ? normalizeExamples(patch.examples) : existing.examples;
      const settings = patch.settings
        ? normalizeSessionSettings(patch.settings)
        : existing.settings;
      // Explicit null clears; absent leaves alone. `undefined` and `null` mean different
      // things here, so neither may be collapsed into the other.
      const avatar = patch.avatar === undefined ? existing.avatar : patch.avatar;
      const finishedAvatar =
        patch.finishedAvatar === undefined ? existing.finishedAvatar : patch.finishedAvatar;

      const conflict = checkRevision(
        existing,
        patch.revision,
        () =>
          title === existing.title &&
          avatar === existing.avatar &&
          finishedAvatar === existing.finishedAvatar &&
          JSON.stringify(stash) === JSON.stringify(existing.stash) &&
          JSON.stringify(examples) === JSON.stringify(existing.examples) &&
          JSON.stringify(settings) === JSON.stringify(existing.settings),
      );
      if (conflict) return conflict;

      commit(id, {
        id,
        title,
        revision: patch.revision,
        stash,
        examples,
        settings,
        avatar,
        finishedAvatar,
      });
      return { kind: 'saved', session: readSession(id)! };
    },
  );

  /*
   * Deliberately no revision bump, matching `chatStore().reassignCharacter`: this is a
   * repair of a reference the user never edited, not a change to their session, and
   * bumping would 409 every client that happens to have the session open.
   */
  const reassignExampleCard = database.transaction(
    (oldAvatar: string, newAvatar: string | null): number => {
      let changed = 0;
      for (const row of statements.selectAllExamples.all()) {
        const examples = normalizeExamples(parseJson<unknown>(row.examples, null));
        if (!examples.cards.includes(oldAvatar)) continue;
        const cards =
          newAvatar === null
            ? examples.cards.filter((card) => card !== oldAvatar)
            : // De-duplicated: a rename onto a name already attached must not list it twice.
              [...new Set(examples.cards.map((card) => (card === oldAvatar ? newAvatar : card)))];
        statements.updateExamples.run({
          $id: row.id,
          $examples: JSON.stringify({ ...examples, cards }),
        });
        changed += 1;
      }
      return changed;
    },
  );

  /** The avatar write behind the upload/clear routes. See the interface for the discipline. */
  const setSessionAvatar = database.transaction(
    (id: string, avatar: string | null): CocreatorSession | null => {
      const existing = readSession(id);
      if (!existing) return null;

      statements.updateSession.run({
        $id: id,
        $title: existing.title,
        $stash: JSON.stringify(existing.stash),
        $examples: JSON.stringify(existing.examples),
        $settings: JSON.stringify(existing.settings),
        $avatar: avatar,
        $finishedAvatar: existing.finishedAvatar,
        $modified: Date.now(),
        $revision: existing.revision,
      });
      return readSession(id);
    },
  );

  return {
    listSessions(): CocreatorSessionSummary[] {
      return listAll.all().map((row) => {
        const { stash, ...rest } = row;
        return {
          ...rest,
          // json_extract returns null for an empty session; the summary promises a string.
          lastMessage: rest.lastMessage ?? '',
          stashedSlots: stashedSlotCount(normalizeStash(parseJson<unknown>(stash, null))),
        };
      });
    },

    getSession: readSession,

    createSession(input): CocreatorSession {
      const now = Date.now();
      const id = crypto.randomUUID();

      statements.insertSession.run({
        $id: id,
        $title: input.title?.trim() || 'Untitled session',
        $created: now,
        $modified: now,
        $revision: 0,
        $stash: JSON.stringify(emptyStash()),
        $examples: JSON.stringify({ cards: [], fields: { ...DEFAULT_EXAMPLE_FIELDS } }),
        $settings: '{}',
      });

      return readSession(id)!;
    },

    replaceSession(id, input): CocreatorSaveResult {
      return saveWholeSession(id, input);
    },

    patchSession(id, patch): CocreatorSaveResult {
      return savePatch(id, patch);
    },

    setSessionAvatar,

    deleteSession(id): boolean {
      // No backup, deliberately — see the file header. Messages go with it via
      // ON DELETE CASCADE, which only fires because openDatabase sets foreign_keys on the
      // connection.
      return statements.deleteSession.run(id).changes > 0;
    },

    reassignExampleCard,
  };
}

let store: CocreatorStore | null = null;

/** The application session store. Tests build their own against an in-memory database. */
export function cocreatorStore(): CocreatorStore {
  if (!store) store = createCocreatorStore(getDb());
  return store;
}

/**
 * Drop the memoized store, so the next call rebuilds it against the current data directory.
 *
 * It holds prepared statements bound to one connection, so `quiesce()` must call this
 * *before* `closeDatabase()` — the same ordering, and the same reason, as `resetChatStore`.
 */
export function resetCocreatorStore(): void {
  store = null;
}
