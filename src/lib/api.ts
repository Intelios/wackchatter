/** Typed client for the local API. */

import type { StreamState } from '@shared/providers/sse.ts';
import {
  createSseParser,
  createStreamAccumulator,
  parseCompletion,
} from '@shared/providers/sse.ts';
import type {
  ChatCompletionBody,
  Connection,
  ProviderId,
  ProviderModel,
} from '@shared/providers/types.ts';
import type { CardDataV2, CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type {
  Chat,
  ChatBackupSummary,
  ChatMessage,
  ChatMetadata,
  ChatSaveSnapshot,
  ChatSummary,
  Persona,
  StaleChatRevision,
} from '@shared/types/chat.ts';
import type {
  CardStash,
  CocreatorSaveSnapshot,
  CocreatorSession,
  CocreatorSessionSummary,
  ExampleSelection,
  SessionModelSettings,
} from '@shared/types/cocreator.ts';
import type {
  BrowseResult,
  LocationInfo,
  LocationKind,
  LocationVerdict,
  SwitchResult,
} from '@shared/types/location.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { AppSettings, SettingsResponse } from '@shared/types/settings.ts';
import type { CharacterStats, StatsOverview } from '@shared/types/stats.ts';
import type { LorebookSummary, WorldInfoBook } from '@shared/types/worldinfo.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function staleRevisionFrom(error: unknown): StaleChatRevision | null {
  if (
    !(error instanceof ApiError) ||
    error.status !== 409 ||
    !error.body ||
    typeof error.body !== 'object'
  ) {
    return null;
  }
  const body = error.body as Partial<StaleChatRevision>;
  return body.code === 'stale_revision' && typeof body.currentRevision === 'number'
    ? { code: 'stale_revision', currentRevision: body.currentRevision }
    : null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);

  if (!response.ok) {
    // Errors come back as {error} JSON, but a crash upstream could return HTML.
    let message = `${response.status} ${response.statusText}`;
    let body: unknown = null;
    try {
      body = await response.json();
      if ((body as { error?: unknown } | null)?.error) {
        message = String((body as { error: unknown }).error);
      }
    } catch {
      /* keep the status line */
    }
    throw new ApiError(message, response.status, body);
  }

  return response.json() as Promise<T>;
}

export const characterApi = {
  list: () => request<CharacterSummary[]>('/characters'),

  get: (avatar: string) => request<CharacterDetail>(`/characters/${encodeURIComponent(avatar)}`),

  create: (name: string, folder = '') =>
    request<CharacterDetail>('/characters', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, folder }),
    }),

  update: (avatar: string, updates: Partial<CardDataV2>) =>
    request<CharacterDetail>(`/characters/${encodeURIComponent(avatar)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    }),

  /** Update with a new avatar image alongside the field changes. */
  updateWithImage: (avatar: string, updates: Partial<CardDataV2>, image: File) => {
    const form = new FormData();
    form.set('updates', JSON.stringify(updates));
    form.set('image', image);
    return request<CharacterDetail>(`/characters/${encodeURIComponent(avatar)}`, {
      method: 'PATCH',
      body: form,
    });
  },

  rename: (avatar: string, name: string) =>
    request<CharacterDetail>(`/characters/${encodeURIComponent(avatar)}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  remove: (avatar: string) =>
    request<{ ok: true }>(`/characters/${encodeURIComponent(avatar)}`, { method: 'DELETE' }),

  import: (file: File, folder = '') => {
    const form = new FormData();
    form.set('file', file);
    form.set('folder', folder);
    return request<CharacterDetail>('/characters/import', { method: 'POST', body: form });
  },

  /**
   * Move a card into a folder; '' is the top level.
   *
   * Separate from `rename` because it is a far smaller operation: the avatar filename is the
   * identity, so a move rewrites no references and the character's chats follow by themselves.
   */
  setFolder: (avatar: string, folder: string) =>
    request<{ avatar: string; folder: string }>(
      `/characters/${encodeURIComponent(avatar)}/folder`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder }),
      },
    ),

  /** Folders are real directories under data/characters, so these are directory operations. */
  folders: {
    list: () => request<string[]>('/characters/folders'),

    create: (path: string) =>
      request<{ path: string }>('/characters/folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      }),

    /** `to` is a full path, so this both renames a folder and moves it under a new parent. */
    rename: (from: string, to: string) =>
      request<{ path: string }>('/characters/folders/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from, to }),
      }),

    /** Cards inside are lifted to the top level, not deleted. */
    remove: (path: string) =>
      request<{ moved: number; skipped: string[]; removed: boolean }>(
        `/characters/folders/${encodeURIComponent(path)}`,
        { method: 'DELETE' },
      ),
  },

  imageUrl: (avatar: string, cacheKey?: number) =>
    `/api/characters/${encodeURIComponent(avatar)}/image${cacheKey ? `?v=${cacheKey}` : ''}`,

  exportUrl: (avatar: string, format: 'png' | 'json') =>
    `/api/characters/${encodeURIComponent(avatar)}/export?format=${format}`,
};

export const presetApi = {
  list: () => request<PresetSummary[]>('/presets'),

  get: (id: string) => request<Preset>(`/presets/${encodeURIComponent(id)}`),

  save: (id: string, preset: Preset) =>
    request<{ ok: true }>(`/presets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(preset),
    }),

  rename: (id: string, name: string) =>
    request<PresetSummary>(`/presets/${encodeURIComponent(id)}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  duplicate: (id: string, preset?: Preset) =>
    request<PresetSummary>(`/presets/${encodeURIComponent(id)}/duplicate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preset }),
    }),

  remove: (id: string) =>
    request<{ ok: true }>(`/presets/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  import: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return request<PresetSummary>('/presets/import', { method: 'POST', body: form });
  },

  exportUrl: (id: string) => `/api/presets/${encodeURIComponent(id)}/export`,
};

export const lorebookApi = {
  list: () => request<LorebookSummary[]>('/lorebooks'),

  get: (id: string) => request<WorldInfoBook>(`/lorebooks/${encodeURIComponent(id)}`),

  create: (name: string, book?: WorldInfoBook) =>
    request<LorebookSummary>('/lorebooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, book }),
    }),

  save: (id: string, book: WorldInfoBook) =>
    request<{ ok: true }>(`/lorebooks/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(book),
    }),

  /** A file move on the server: the filename is what a card's `extensions.world` names. */
  rename: (id: string, name: string) =>
    request<LorebookSummary>(`/lorebooks/${encodeURIComponent(id)}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  remove: (id: string) =>
    request<{ ok: true }>(`/lorebooks/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  import: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return request<LorebookSummary>('/lorebooks/import', { method: 'POST', body: form });
  },

  exportUrl: (id: string) => `/api/lorebooks/${encodeURIComponent(id)}/export`,
};

/** The book embedded in a character card, edited one entry at a time. */
export const characterBookApi = {
  addEntry: (avatar: string) =>
    request<{ detail: CharacterDetail; uid: number }>(
      `/characters/${encodeURIComponent(avatar)}/book/entries`,
      { method: 'POST' },
    ),

  saveEntry: (avatar: string, uid: number, entry: unknown) =>
    request<CharacterDetail>(`/characters/${encodeURIComponent(avatar)}/book/entries/${uid}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
    }),

  removeEntry: (avatar: string, uid: number) =>
    request<CharacterDetail>(`/characters/${encodeURIComponent(avatar)}/book/entries/${uid}`, {
      method: 'DELETE',
    }),

  saveBook: (avatar: string, fields: Record<string, unknown>) =>
    request<CharacterDetail>(`/characters/${encodeURIComponent(avatar)}/book`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    }),

  removeBook: (avatar: string) =>
    request<CharacterDetail>(`/characters/${encodeURIComponent(avatar)}/book`, {
      method: 'DELETE',
    }),
};

export const personaApi = {
  list: () => request<Persona[]>('/personas'),

  create: (name: string) =>
    request<Persona>('/personas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  save: (id: string, patch: Partial<Persona>) =>
    request<Persona>(`/personas/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  remove: (id: string) =>
    request<{ ok: true }>(`/personas/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  uploadAvatar: (id: string, file: File) => {
    const form = new FormData();
    form.set('file', file);
    return request<Persona>(`/personas/${encodeURIComponent(id)}/avatar`, {
      method: 'POST',
      body: form,
    });
  },

  // The filename is stable per persona, so a replaced avatar would keep showing the old
  // image without a cache-busting parameter.
  avatarUrl: (id: string, version?: string | number) =>
    `/api/personas/${encodeURIComponent(id)}/avatar${version ? `?v=${version}` : ''}`,
};

export interface BackgroundSummary {
  name: string;
  size: number;
  modified: number;
}

export const backgroundApi = {
  list: () => request<BackgroundSummary[]>('/backgrounds'),

  upload: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return request<BackgroundSummary>('/backgrounds', { method: 'POST', body: form });
  },

  remove: (name: string) =>
    request<{ ok: true }>(`/backgrounds/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  importFromSillyTavern: () =>
    request<{ imported: string[]; skipped: string[]; source: string }>('/backgrounds/import', {
      method: 'POST',
    }),

  /**
   * Always go through here rather than interpolating a name into `url(...)` — sanitiseFilename
   * permits parentheses, so "sunset (2).jpg" would break a raw CSS url token.
   */
  url: (name: string, version?: string | number) =>
    `/api/backgrounds/${encodeURIComponent(name)}${version ? `?v=${version}` : ''}`,
};

export const chatApi = {
  list: (characterId?: string) =>
    request<ChatSummary[]>(
      characterId ? `/chats?character=${encodeURIComponent(characterId)}` : '/chats',
    ),

  recent: (limit: number) => request<ChatSummary[]>(`/chats?limit=${limit}`),

  get: (id: string) => request<Chat>(`/chats/${encodeURIComponent(id)}`),

  create: (input: {
    characterId: string;
    title?: string;
    metadata?: ChatMetadata;
    messages?: ChatMessage[];
  }) =>
    request<Chat>('/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  /** Whole-chat write — the only path that changes messages. */
  save: (snapshot: ChatSaveSnapshot, options?: Pick<RequestInit, 'keepalive'>) =>
    request<Chat>(`/chats/${encodeURIComponent(snapshot.chatId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
      ...options,
    }),

  updateMeta: (
    id: string,
    updates: { revision: number; title?: string; metadata?: ChatMetadata },
  ) =>
    request<Chat>(`/chats/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    }),

  remove: (id: string) =>
    request<{ ok: true }>(`/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  branch: (id: string, afterMessageId: string, title?: string) =>
    request<Chat>(`/chats/${encodeURIComponent(id)}/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ afterMessageId, title }),
    }),

  /** Whole-chat download in our own format; `import` is its counterpart. */
  exportUrl: (id: string) => `/api/chats/${encodeURIComponent(id)}/export`,

  import: (file: File, characterId: string) => {
    const form = new FormData();
    form.set('file', file);
    form.set('characterId', characterId);
    return request<Chat>('/chats/import', { method: 'POST', body: form });
  },
};

export const cocreatorApi = {
  list: () => request<CocreatorSessionSummary[]>('/cocreator'),

  get: (id: string) => request<CocreatorSession>(`/cocreator/${encodeURIComponent(id)}`),

  create: (title?: string) =>
    request<CocreatorSession>('/cocreator', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }),

  /** Whole-session write — the only path that changes messages. */
  save: (snapshot: CocreatorSaveSnapshot, options?: Pick<RequestInit, 'keepalive'>) =>
    request<CocreatorSession>(`/cocreator/${encodeURIComponent(snapshot.sessionId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
      ...options,
    }),

  /** Metadata-only write. Never touches the transcript. */
  patch: (
    id: string,
    updates: {
      revision: number;
      title?: string;
      stash?: CardStash;
      examples?: ExampleSelection;
      settings?: SessionModelSettings;
      avatar?: string | null;
      finishedAvatar?: string | null;
    },
  ) =>
    request<CocreatorSession>(`/cocreator/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    }),

  remove: (id: string) =>
    request<{ ok: true }>(`/cocreator/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  setAvatar: (id: string, image: File) => {
    const form = new FormData();
    form.set('image', image);
    return request<CocreatorSession>(`/cocreator/${encodeURIComponent(id)}/avatar`, {
      method: 'PUT',
      body: form,
    });
  },

  clearAvatar: (id: string) =>
    request<CocreatorSession>(`/cocreator/${encodeURIComponent(id)}/avatar`, { method: 'DELETE' }),

  /** `cacheKey` is the session's `modified`, since the filename is stable per session. */
  avatarUrl: (id: string, cacheKey?: number) =>
    `/api/cocreator/${encodeURIComponent(id)}/avatar${cacheKey ? `?v=${cacheKey}` : ''}`,
};

export const backupApi = {
  list: (characterId?: string) =>
    request<ChatBackupSummary[]>(
      characterId ? `/backups?character=${encodeURIComponent(characterId)}` : '/backups',
    ),

  /** Recreate the chat and move it out of the bin. */
  restore: (backupId: string) =>
    request<Chat>(`/backups/${encodeURIComponent(backupId)}/restore`, { method: 'POST' }),

  /** Permanently empty this slot of the bin. */
  remove: (backupId: string) =>
    request<{ ok: true }>(`/backups/${encodeURIComponent(backupId)}`, { method: 'DELETE' }),

  /** Permanently empty all slots of the bin, optionally filtered by character. */
  removeAll: (characterId?: string) =>
    request<{ ok: true; deleted: number }>(
      characterId ? `/backups?character=${encodeURIComponent(characterId)}` : '/backups',
      { method: 'DELETE' },
    ),
};

export const settingsApi = {
  get: () => request<SettingsResponse>('/settings'),

  /** Cannot touch the connection list — that mutates only through the endpoints below. */
  save: (patch: Partial<AppSettings>) =>
    request<SettingsResponse>('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  /** Id and name are minted server-side, so concurrent creates cannot collide. */
  createConnection: (provider?: ProviderId) =>
    request<SettingsResponse>('/settings/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    }),

  patchConnection: (id: string, patch: Partial<Connection>) =>
    request<SettingsResponse>(`/settings/connections/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  /** The server deletes the connection's stored key along with it. */
  removeConnection: (id: string) =>
    request<SettingsResponse>(`/settings/connections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  /** The key is written and never read back; only its presence is reported. */
  setKey: (connectionId: string, key: string | null) =>
    request<{ ok: true; present: boolean }>(`/settings/keys/${encodeURIComponent(connectionId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    }),

  models: (connectionId?: string) =>
    request<{ models: ProviderModel[] }>(
      connectionId
        ? `/settings/connections/${encodeURIComponent(connectionId)}/models`
        : '/settings/models',
    ),

  /** The id must name a stored connection — the server uses it to pick the key. */
  test: (connection: Connection) =>
    request<{ ok: true; models: number } | { ok: false; error: string }>('/settings/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(connection),
    }),
};

export const locationApi = {
  /** `withSize` walks the whole library, so the panel renders first and fills it in after. */
  get: (withSize = false) => request<LocationInfo>(`/location${withSize ? '?size=1' : ''}`),

  inspect: (path: string) =>
    request<LocationVerdict>('/location/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }),

  /**
   * `expect` is the classification the user was actually shown. The server re-checks it and
   * refuses if the folder changed in between, so the confirm means what it said.
   */
  move: (path: string, expect: LocationKind) =>
    request<SwitchResult>('/location', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, expect }),
    }),

  /** Opens a native folder dialog on the machine running the server. Sends no path. */
  browse: () => request<BrowseResult>('/location/browse', { method: 'POST' }),
};

export interface StreamHandlers {
  /** Called with the FULL accumulated state — never a delta. Assign, do not append. */
  onTick: (state: StreamState) => void;
  /** Called when the first user-visible content or reasoning arrives. */
  onFirstToken?: () => void;
}

/**
 * POST a request and consume the response, streamed or not.
 *
 * This deliberately sits beside `request<T>` rather than inside it: `request` always
 * parses JSON, which a stream cannot survive. It uses fetch + a reader rather than
 * EventSource, which can neither POST nor set headers.
 *
 * @param seed Existing text to build on, for `continue`.
 */
export async function streamGenerate(
  body: ChatCompletionBody,
  signal: AbortSignal,
  handlers: StreamHandlers,
  seed = '',
  connectionId?: string,
): Promise<StreamState> {
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body, ...(connectionId ? { connectionId } : {}) }),
    signal,
  });

  if (!response.ok || !response.body) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const failure = (await response.json()) as { error?: string };
      if (failure?.error) message = failure.error;
    } catch {
      /* keep the status line */
    }
    throw new Error(message);
  }

  // The server mirrors the upstream content-type, so this is how we learn which we got.
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const state = parseCompletion(await response.json(), seed);
    // A provider can report a failure inside an otherwise-200 body, same as a stream.
    if (state.error) throw new Error(state.error);
    handlers.onFirstToken?.();
    handlers.onTick(state);
    return state;
  }

  const parser = createSseParser();
  const accumulator = createStreamAccumulator(seed);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sawToken = false;

  const publish = (state: StreamState | null) => {
    if (!state) return;
    // Thinking models commonly emit reasoning for a long time before ordinary content.
    // That is visible stream output too: leaving the chat in "connecting" hides the
    // StreamingText leaf, even though its store is receiving every reasoning delta.
    if (!sawToken && (state.content !== seed || state.reasoning)) {
      sawToken = true;
      handlers.onFirstToken?.();
    }
    handlers.onTick(state);
  };

  const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
  const aborted = new Promise<never>((_, reject) => {
    const fire = () => reject(abortError());
    if (signal.aborted) {
      fire();
      return;
    }
    signal.addEventListener('abort', fire, { once: true });
  });
  aborted.catch(() => {});

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;

      // stream: true keeps multi-byte characters split across chunks intact.
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        publish(accumulator.push(frame));
      }
    }

    for (const frame of parser.flush()) {
      publish(accumulator.push(frame));
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const final = accumulator.snapshot();
  // A provider can report a failure inside an otherwise-successful stream.
  if (final.error) throw new Error(final.error);
  return final;
}

export interface VersionInfo {
  version: string;
  branch: string | null;
  revision: string | null;
}

export const versionApi = {
  get: () => request<VersionInfo>('/version'),
};

export const statsApi = {
  /** The whole library. Aggregated server-side — see server/lib/stats.ts. */
  overview: () => request<StatsOverview>('/stats'),

  /** One card. A card with no chats answers with zeros rather than a 404. */
  character: (avatar: string) =>
    request<CharacterStats>(`/stats/characters/${encodeURIComponent(avatar)}`),
};
