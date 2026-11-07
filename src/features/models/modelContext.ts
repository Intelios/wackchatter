/**
 * A model's context length, from its connection's catalogue. Fetched once per model and
 * endpoint for the session; a failed lookup is forgotten so the next run asks again, and
 * reads as unknown (`contextOrDefault` then picks a generous size).
 */

import { contextOrDefault } from '@shared/models/context.ts';
import type { ProviderModel, ResolvedModel } from '@shared/providers/types.ts';
import { settingsApi } from '../../lib/api.ts';

const known = new Map<string, Promise<ProviderModel | null>>();

/**
 * One model's catalogue entry, from its connection's list. Only that connection is asked,
 * once per endpoint and model; a failed lookup is forgotten so the next one asks again.
 */
export function modelCatalogueEntry(
  model: Pick<ResolvedModel, 'id' | 'model'> & Partial<Pick<ResolvedModel, 'provider' | 'baseUrl'>>,
): Promise<ProviderModel | null> {
  const key = [model.id, model.provider, model.baseUrl, model.model].join('|');
  let pending = known.get(key);
  if (!pending) {
    pending = settingsApi
      .models(model.id)
      .then(({ models }) => models.find((entry) => entry.id === model.model) ?? null)
      .catch(() => {
        known.delete(key);
        return null;
      });
    known.set(key, pending);
  }
  return pending;
}

export async function modelContextLength(model: ResolvedModel): Promise<number | null> {
  return (await modelCatalogueEntry(model))?.contextLength ?? null;
}

/** The context a request to `model` may fill. */
export async function resolveModelContext(model: ResolvedModel): Promise<number> {
  return contextOrDefault(await modelContextLength(model));
}
