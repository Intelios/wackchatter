/** Typed client for the local API. */

import type { CardDataV2, CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';

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
