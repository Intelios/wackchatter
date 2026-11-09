/** Typed client for the local API. */

import type { ChatSaveBody } from '@shared/chat/save.ts';
import type { ModelSlots } from '@shared/models/slots.ts';
import type { Connection, ProviderId, ProviderModel } from '@shared/providers/types.ts';
import type {
  ArenaRound,
  RoundSide,
  Tournament,
  TournamentMatch,
  TournamentSize,
  TournamentStage,
  TournamentStatus,
  TournamentVerdict,
  TournamentWithMatches,
  Verdict,
} from '@shared/types/arena.ts';
import type { BackupPlan } from '@shared/types/backup.ts';
import type {
  CardDataV2,
  CharacterDetail,
  CharacterSummary,
  TavernCard,
  VersionedCharacter,
} from '@shared/types/card.ts';
import type {
  Chat,
  ChatBackupSummary,
  ChatMessage,
  ChatMetadata,
  ChatSaveAck,
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
import type {
  CreatePresetCocreatorSession,
  PatchPresetDraftRequest,
  PresetCocreatorSession,
  PresetCocreatorSessionSummary,
  PublishPresetDraftRequest,
  PublishPresetDraftResult,
  ReferencePresetRecord,
  ReferencePresetSummary,
  RenamePresetCocreatorSessionRequest,
  ReplacePresetDraftRequest,
  RestorePresetDraftRequest,
  SavePresetCocreatorDocument,
} from '@shared/types/preset-cocreator.ts';
import type { AppSettings, SettingsResponse } from '@shared/types/settings.ts';
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

async function requestResult<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T; response: Response }> {
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

  return { data: (await response.json()) as T, response };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await requestResult<T>(path, init)).data;
}

export const characterApi = {
  list: () => request<CharacterSummary[]>('/characters'),

  get: (avatar: string) => request<CharacterDetail>(`/characters/${encodeURIComponent(avatar)}`),
  getVersioned: (avatar: string) =>
    request<VersionedCharacter>(`/characters/${encodeURIComponent(avatar)}/record`),

  createComplete: (card: TavernCard, folder: string, image: File | null) => {
    const form = new FormData();
    form.set('body', JSON.stringify({ card, folder }));
    if (image) form.set('image', image);
    return request<VersionedCharacter>('/characters', { method: 'POST', body: form });
  },

  saveVersioned: (
    avatar: string,
    updates: Partial<CardDataV2>,
    version: string,
    image?: File | null,
    name?: string,
  ) => {
    const form = new FormData();
    form.set('body', JSON.stringify({ updates, name, clearImage: image === null }));
    if (image) form.set('image', image);
    return request<VersionedCharacter>(`/characters/${encodeURIComponent(avatar)}/save`, {
      method: 'POST',
      headers: { 'if-match': `"${version}"` },
      body: form,
    });
  },

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

  getVersioned: async (id: string) => {
    const result = await requestResult<Preset>(`/presets/${encodeURIComponent(id)}`);
    return {
      preset: result.data,
      version: result.response.headers.get('x-preset-version') ?? '',
    };
  },

  save: (id: string, preset: Preset, expectedVersion?: string) =>
    request<{ ok: true; version: string }>(`/presets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(expectedVersion ? { 'if-match': `"${expectedVersion}"` } : {}),
      },
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

  // A full copy of the persona, linked to it by `variantOf` — the label is optional and
  // the server fills in "Variant"/"Variant 2"/… when blank.
  createVariant: (id: string, label?: string) =>
    request<Persona>(`/personas/${encodeURIComponent(id)}/variant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
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

  /**
   * The queued save: an incremental write carrying only what changed, acknowledged
   * with the row's new revision — never the transcript back. `ChatSaveQueue` builds
   * the body; see `shared/chat/save.ts` for the contract.
   */
  save: (chatId: string, body: ChatSaveBody, options?: Pick<RequestInit, 'keepalive'>) =>
    request<ChatSaveAck>(`/chats/${encodeURIComponent(chatId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...options,
    }),

  updateMeta: (
    id: string,
    updates: { revision: number; title?: string; metadata?: ChatMetadata },
  ) =>
    request<ChatSaveAck>(`/chats/${encodeURIComponent(id)}`, {
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

  /** `seedAvatar` is write-once: only creation records it, never a later save. */
  create: (
    title?: string,
    seedAvatar?: string,
    initial?: { stash: CardStash; sourceVersion: string },
  ) =>
    request<CocreatorSession>('/cocreator', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, seedAvatar: seedAvatar ?? null, ...initial }),
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

export const presetCocreatorApi = {
  list: () => request<PresetCocreatorSessionSummary[]>('/preset-cocreator/sessions'),

  get: (id: string) =>
    request<PresetCocreatorSession>(`/preset-cocreator/sessions/${encodeURIComponent(id)}`),

  create: (input: CreatePresetCocreatorSession) =>
    request<PresetCocreatorSession>('/preset-cocreator/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  rename: (id: string, input: RenamePresetCocreatorSessionRequest) =>
    request<PresetCocreatorSession>(`/preset-cocreator/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  saveDocument: (id: string, input: SavePresetCocreatorDocument) =>
    request<PresetCocreatorSession>(
      `/preset-cocreator/sessions/${encodeURIComponent(id)}/document`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),

  patchDraft: (id: string, input: PatchPresetDraftRequest) =>
    request<PresetCocreatorSession>(
      `/preset-cocreator/sessions/${encodeURIComponent(id)}/draft/patch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),

  replaceDraft: (id: string, input: ReplacePresetDraftRequest) =>
    request<PresetCocreatorSession>(
      `/preset-cocreator/sessions/${encodeURIComponent(id)}/draft/replace`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),

  restoreDraft: (id: string, input: RestorePresetDraftRequest) =>
    request<PresetCocreatorSession>(
      `/preset-cocreator/sessions/${encodeURIComponent(id)}/draft/restore`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),

  publish: (id: string, input: PublishPresetDraftRequest) =>
    request<PublishPresetDraftResult>(
      `/preset-cocreator/sessions/${encodeURIComponent(id)}/publish`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),

  remove: (id: string) =>
    request<{ ok: true }>(`/preset-cocreator/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

/** Read-only example presets for the Co-Creator assistant — never the live preset list. */
export const referencePresetApi = {
  list: () => request<ReferencePresetSummary[]>('/reference-presets'),

  get: (id: string) =>
    request<ReferencePresetRecord>(`/reference-presets/${encodeURIComponent(id)}`),

  import: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return request<ReferencePresetSummary>('/reference-presets/import', {
      method: 'POST',
      body: form,
    });
  },

  /** Copy one library preset's file into the reference folder, verbatim. */
  copyFromLibrary: (presetId: string) =>
    request<ReferencePresetSummary>('/reference-presets/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId }),
    }),

  remove: (id: string) =>
    request<{ ok: true }>(`/reference-presets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
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

  /**
   * Cannot touch the connection list — that mutates only through the endpoints below.
   * `models` merges per slot on the server, so send only the slots being changed.
   */
  save: (patch: Omit<Partial<AppSettings>, 'models'> & { models?: Partial<ModelSlots> }) =>
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

  /** One saved connection's model catalogue. */
  models: (connectionId: string) =>
    request<{ models: ProviderModel[] }>(
      `/settings/connections/${encodeURIComponent(connectionId)}/models`,
    ),

  /** The id must name a stored connection — the server uses it to pick the key. */
  test: (connection: Connection) =>
    request<{ ok: true; models: number } | { ok: false; error: string }>('/settings/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(connection),
    }),
};

export const libraryApi = {
  /**
   * What a backup would contain. Walked with the export's own exclusion rules, so the count
   * the button shows is the count the archive holds — and so the failures worth reporting
   * land somewhere the panel can render them, which a download itself never does.
   */
  check: (secrets: boolean) =>
    request<BackupPlan>(`/library/export/check${secrets ? '?secrets=1' : ''}`),

  /** An href, not a fetch: the archive streams to disk instead of through browser memory. */
  exportUrl: (secrets: boolean) => `/api/library/export${secrets ? '?secrets=1' : ''}`,
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

export interface VersionInfo {
  version: string;
  branch: string | null;
  revision: string | null;
  /** How far upstream is ahead, or null before the first background check lands. */
  commitsBehind: number | null;
}

export const versionApi = {
  get: () => request<VersionInfo>('/version'),
};

export const arenaApi = {
  /**
   * Every recorded round, oldest first.
   *
   * The whole history in one call, deliberately: the leaderboard is a *replay*, not an
   * aggregate, so it needs the rounds in order anyway — and a personal benchmark measures
   * in hundreds of rounds, not millions.
   */
  rounds: () => request<ArenaRound[]>('/arena/rounds'),

  /** Record one finished round. The server mints the id and the timestamp. */
  record: (round: {
    characterId: string;
    probe: string;
    left: RoundSide;
    right: RoundSide;
    verdict: Verdict;
  }) =>
    request<ArenaRound>('/arena/rounds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(round),
    }),

  remove: (id: string) =>
    request<{ ok: true }>(`/arena/rounds/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Delete all rounds for one contender. Guarded by a two-click confirm in the UI. */
  deleteContender: (id: string) =>
    request<{ ok: true; removed: number }>(`/arena/contenders/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  /** Empty the history. Guarded by a two-click confirm in the panel, not here. */
  clear: () => request<{ ok: true; removed: number }>('/arena/rounds', { method: 'DELETE' }),
};

export const tournamentApi = {
  /**
   * Every tournament with the matches played in it, oldest first.
   *
   * One call, because no reader wants the definition without the evidence — the bracket and
   * the career ladder are both replays of the matches, and the plan alone says nothing about
   * who is still in it.
   */
  list: () => request<TournamentWithMatches[]>('/arena/tournaments'),

  /** Create a bracket. `entrants` is in bracket-slot order, already seeded by the caller. */
  create: (input: {
    name: string;
    size: TournamentSize;
    entrants: string[];
    stages: TournamentStage[];
  }) =>
    request<Tournament>('/arena/tournaments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  /** Rename and/or abandon — a plan's only mutable fields. */
  update: (id: string, patch: { name?: string; status?: TournamentStatus }) =>
    request<Tournament>(`/arena/tournaments/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  /** Delete a tournament and every match in it. Guarded by a two-click confirm in the UI. */
  remove: (id: string) =>
    request<{ ok: true }>(`/arena/tournaments/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * Record one decided match.
   *
   * The card and cue are not sent: the server reads them from the stage plan, so a match
   * cannot claim a question the tournament never posed. `verdict` is left or right only —
   * a dead heat is re-rolled and judged before it ever gets here.
   */
  recordMatch: (
    id: string,
    match: {
      stage: number;
      matchIndex: number;
      left: RoundSide;
      right: RoundSide;
      verdict: TournamentVerdict;
      rerolled: boolean;
    },
  ) =>
    request<TournamentMatch>(`/arena/tournaments/${encodeURIComponent(id)}/matches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(match),
    }),
};
