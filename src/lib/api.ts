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
import type { Chat, ChatMessage, ChatMetadata, ChatSummary } from '@shared/types/chat.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { AppSettings, SettingsResponse } from '@shared/types/settings.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);

  if (!response.ok) {
    // Errors come back as {error} JSON, but a crash upstream could return HTML.
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      /* keep the status line */
    }
    throw new Error(message);
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

  remove: (id: string) =>
    request<{ ok: true }>(`/presets/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  import: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return request<PresetSummary>('/presets/import', { method: 'POST', body: form });
  },

  exportUrl: (id: string) => `/api/presets/${encodeURIComponent(id)}/export`,
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
  save: (id: string, chat: { title?: string; metadata?: ChatMetadata; messages: ChatMessage[] }) =>
    request<Chat>(`/chats/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chat),
    }),

  updateMeta: (id: string, updates: { title?: string; metadata?: ChatMetadata }) =>
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

  try {
    while (true) {
      const { done, value } = await reader.read();
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
    // An abort leaves the body open; releasing lets the connection tear down promptly.
    reader.cancel().catch(() => {});
  }

  const final = accumulator.snapshot();
  // A provider can report a failure inside an otherwise-successful stream.
  if (final.error) throw new Error(final.error);
  return final;
}
