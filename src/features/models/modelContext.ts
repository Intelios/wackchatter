/**
 * A model's context length, from its connection's catalogue. Fetched once per model and
 * endpoint for the session; a failed lookup is forgotten so the next run asks again, and
 * reads as unknown (`contextOrDefault` then picks a generous size).
 */

import { contextOrDefault } from '@shared/models/context.ts';
import type { ResolvedModel } from '@shared/providers/types.ts';
import { settingsApi } from '../../lib/api.ts';

const known = new Map<string, Promise<number | null>>();

export function modelContextLength(model: ResolvedModel): Promise<number | null> {
  const key = [model.id, model.provider, model.baseUrl, model.model].join('|');
  let pending = known.get(key);
  if (!pending) {
    pending = settingsApi
      .models(model.id)
      .then(({ models }) => models.find((entry) => entry.id === model.model)?.contextLength ?? null)
      .catch(() => {
        known.delete(key);
        return null;
      });
    known.set(key, pending);
  }
  return pending;
}

/** The context a request to `model` may fill. */
export async function resolveModelContext(model: ResolvedModel): Promise<number> {
  return contextOrDefault(await modelContextLength(model));
}
