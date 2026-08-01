/** Typed client for the local API. */

import {
  createSseParser,
  createStreamAccumulator,
  parseCompletion,
} from '@shared/providers/sse.ts';
import type { StreamState } from '@shared/providers/sse.ts';
import type {
  ChatCompletionBody,
  ConnectionSettings,
  ProviderModel,
} from '@shared/providers/types.ts';
import type { CardDataV2, CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type {
  Chat,
  ChatMessage,
  ChatMetadata,
  ChatSaveSnapshot,
  ChatSummary,
  StaleChatRevision,
} from '@shared/types/chat.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
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

  create: (name: string) =>
    request<CharacterDetail>('/characters', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
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

  import: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return request<CharacterDetail>('/characters/import', { method: 'POST', body: form });
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

export const chatApi = {
  list: (characterId?: string) =>
    request<ChatSummary[]>(
      characterId ? `/chats?character=${encodeURIComponent(characterId)}` : '/chats',
    ),

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
};

export const settingsApi = {
  get: () => request<SettingsResponse>('/settings'),

  save: (patch: Partial<AppSettings>) =>
    request<SettingsResponse>('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  /** The key is written and never read back; only its presence is reported. */
  setKey: (provider: string, key: string | null) =>
    request<{ ok: true; present: boolean }>(`/settings/keys/${encodeURIComponent(provider)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    }),

  models: () => request<{ models: ProviderModel[] }>('/settings/models'),

  test: (connection: ConnectionSettings) =>
    request<{ ok: true; models: number } | { ok: false; error: string }>('/settings/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(connection),
    }),
};

export interface StreamHandlers {
  /** Called with the FULL accumulated state — never a delta. Assign, do not append. */
  onTick: (state: StreamState) => void;
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
): Promise<StreamState> {
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
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
    handlers.onFirstToken?.();
    handlers.onTick(state);
    return state;
  }

  const parser = createSseParser();
  const accumulator = createStreamAccumulator(seed);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sawToken = false;

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
        const state = accumulator.push(frame);
        if (!state) continue;

        if (!sawToken && state.content !== seed) {
          sawToken = true;
          handlers.onFirstToken?.();
        }
        handlers.onTick(state);
      }
    }

    for (const frame of parser.flush()) {
      const state = accumulator.push(frame);
      if (state) handlers.onTick(state);
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const final = accumulator.snapshot();
  // A provider can report a failure inside an otherwise-successful stream.
  if (final.error) throw new Error(final.error);
  return final;
}
