/**
 * What the model picker lists, as pure functions so the rules are testable without a DOM.
 *
 * One list across every connection: models are what you pick, and the connection is a label
 * beside each one. Recent picks head it, then every connection's catalogue under the
 * connection's name. A typed id is always offered too, because a local or OpenAI-compatible
 * server may not list its models at all.
 */

import { type ModelRef, sameModelRef } from '@shared/models/slots.ts';
import type { Connection, ProviderModel } from '@shared/providers/types.ts';

export type CatalogEntry =
  | { status: 'loading' }
  | { status: 'ready'; models: ProviderModel[] }
  | { status: 'error'; error: string };

export type Catalogs = Readonly<Record<string, CatalogEntry | undefined>>;

export interface PickerOption {
  /** Stable across renders: `connectionId` + model id + the section it sits in. */
  key: string;
  ref: ModelRef;
  name: string;
  connectionName: string;
  hint: string;
}

export interface PickerSection {
  key: string;
  title: string;
  options: PickerOption[];
  /** Shown instead of options: loading, a failed fetch, an endpoint that lists nothing. */
  note?: string;
}

/** The catalogue's display name for a ref, or its raw id when the catalogue lacks it. */
export function modelName(ref: ModelRef, catalogs: Catalogs): string {
  const entry = catalogs[ref.connectionId];
  const match =
    entry?.status === 'ready' ? entry.models.find((model) => model.id === ref.modelId) : null;
  return match?.name ?? ref.modelId;
}

/** "Model · Connection" — or a note that the connection is gone. */
export function describeRef(
  ref: ModelRef,
  connections: readonly Connection[],
  catalogs: Catalogs,
): { name: string; connectionName: string | null } {
  const connection = connections.find((entry) => entry.id === ref.connectionId);
  return { name: modelName(ref, catalogs), connectionName: connection?.name ?? null };
}

export function formatHint(model: ProviderModel | undefined): string {
  if (!model) return '';
  const parts: string[] = [];
  if (model.contextLength) parts.push(`${Math.round(model.contextLength / 1000)}k ctx`);
  if (model.promptPrice !== undefined) {
    const perM = model.promptPrice * 1_000_000;
    parts.push(perM === 0 ? 'free' : `$${perM < 0.01 ? '<0.01' : perM.toFixed(2)}/M`);
  }
  return parts.join(' · ');
}

function matches(query: string, ...fields: string[]): boolean {
  if (!query) return true;
  // Every word must appear somewhere, so "sonnet openrouter" finds Sonnet on OpenRouter.
  const haystack = fields.join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

/**
 * The picker's sections for a query. Recent picks first (skipping any whose connection was
 * deleted), then one section per connection, then — when something was typed — the typed id
 * offered on each connection that does not already list it under exactly that id.
 */
export function pickerSections(options: {
  connections: readonly Connection[];
  recent: readonly ModelRef[];
  catalogs: Catalogs;
  query: string;
}): PickerSection[] {
  const query = options.query.trim();
  const sections: PickerSection[] = [];
  const byId = new Map(options.connections.map((connection) => [connection.id, connection]));
  const listed = (ref: ModelRef) => {
    const entry = options.catalogs[ref.connectionId];
    return entry?.status === 'ready'
      ? entry.models.find((model) => model.id === ref.modelId)
      : undefined;
  };

  const recent = options.recent.flatMap((ref): PickerOption[] => {
    const connection = byId.get(ref.connectionId);
    if (!connection) return [];
    const name = modelName(ref, options.catalogs);
    if (!matches(query, name, ref.modelId, connection.name)) return [];
    return [
      {
        key: `recent:${ref.connectionId}:${ref.modelId}`,
        ref,
        name,
        connectionName: connection.name,
        hint: formatHint(listed(ref)),
      },
    ];
  });
  if (recent.length) sections.push({ key: 'recent', title: 'Recent', options: recent });

  for (const connection of options.connections) {
    const entry = options.catalogs[connection.id];
    if (entry?.status !== 'ready') {
      // Only worth a line when nothing is being searched for: a search shows what matched.
      if (!query) {
        sections.push({
          key: connection.id,
          title: connection.name,
          options: [],
          note:
            entry?.status === 'error' ? `Could not list models: ${entry.error}` : 'Loading models…',
        });
      }
      continue;
    }
    const models = entry.models.filter((model) =>
      matches(query, model.name, model.id, connection.name),
    );
    if (!models.length) {
      if (!query) {
        sections.push({
          key: connection.id,
          title: connection.name,
          options: [],
          note: 'This endpoint lists no models. Type a model id above.',
        });
      }
      continue;
    }
    sections.push({
      key: connection.id,
      title: connection.name,
      options: models.map((model) => ({
        key: `${connection.id}:${model.id}`,
        ref: { connectionId: connection.id, modelId: model.id },
        name: model.name,
        connectionName: connection.name,
        hint: formatHint(model),
      })),
    });
  }

  if (query && !/\s/.test(query)) {
    const typed = options.connections.flatMap((connection): PickerOption[] => {
      const ref = { connectionId: connection.id, modelId: query };
      if (listed(ref)) return [];
      return [
        {
          key: `typed:${connection.id}`,
          ref,
          name: query,
          connectionName: connection.name,
          hint: 'Use this id',
        },
      ];
    });
    if (typed.length) sections.push({ key: 'typed', title: 'Model id', options: typed });
  }

  return sections;
}

/** Whether `option` is the current pick — used to mark it in the list. */
export function isCurrent(option: PickerOption, value: ModelRef | null | undefined): boolean {
  return sameModelRef(option.ref, value ?? null);
}
