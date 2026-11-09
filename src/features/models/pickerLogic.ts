/**
 * What the model picker lists, as pure functions so the rules are testable without a DOM.
 *
 * One list across every connection: models are what you pick, and the connection is a label
 * beside each one. Favourites head it, then recent picks, then every connection's catalogue
 * under the connection's name, each a group that folds shut and stays that way. A typed id is always offered too, because a local or OpenAI-compatible
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
  /** Starred: it also sits in Favourites. */
  favorite: boolean;
}

export interface PickerSection {
  /** Also the key its open/closed state is remembered under. */
  key: string;
  title: string;
  options: PickerOption[];
  /** Sub-groups under this one — a large catalogue split by model vendor. */
  groups?: PickerSection[];
  /** Shown instead of options: loading, a failed fetch, an endpoint that lists nothing. */
  note?: string;
  /** Whether the heading can fold the group away. Never while searching. */
  collapsible: boolean;
  open: boolean;
  /** Models inside, sub-groups included, for the folded heading. */
  count: number;
}

/**
 * A catalogue at least this big, whose ids are mostly `vendor/model` (OpenRouter's), is split
 * into one sub-group per vendor. Smaller lists read fine flat.
 */
export const VENDOR_SPLIT_MIN = 40;

/** Group keys, which are also what `AppSettings.modelPickerGroups` remembers. */
export const groupKey = {
  recent: 'recent',
  connection: (connectionId: string) => `conn:${connectionId}`,
  vendor: (connectionId: string, vendor: string) => `vendor:${connectionId}:${vendor}`,
};

/** Open unless toggled shut: recents and connections. Vendor groups start folded. */
function defaultOpen(key: string): boolean {
  return !key.startsWith('vendor:');
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

/** `anthropic` from `anthropic/claude…`, ignoring OpenRouter's `~` alias marker. */
function vendorOf(id: string): string | null {
  const slash = id.indexOf('/');
  if (slash <= 0) return null;
  return id.slice(0, slash).replace(/^~/, '') || null;
}

/** "Anthropic" from OpenRouter's "Anthropic: Claude …" naming, when the name has it. */
function namedVendor(name: string): string | null {
  return /^([^:]{1,40}):\s/.exec(name)?.[1]?.trim() || null;
}

/**
 * Splits a big `vendor/model` catalogue by vendor, or null when it should stay flat.
 *
 * Grouped by the vendor's display name rather than the id prefix: OpenRouter lists one
 * vendor under several prefixes (`meta` and `meta-llama`, `~anthropic` aliases), and a
 * name's "Anthropic:" prefix is what a person reads. The most common spelling titles it.
 */
function splitByVendor(
  models: readonly ProviderModel[],
): { vendor: string; title: string; models: ProviderModel[] }[] | null {
  if (models.length < VENDOR_SPLIT_MIN) return null;
  const prefixed = models.filter((model) => vendorOf(model.id)).length;
  if (prefixed < models.length * 0.8) return null;

  type Group = { titles: Map<string, number>; models: ProviderModel[] };
  const groups = new Map<string, Group>();
  for (const model of models) {
    const label = namedVendor(model.name) ?? vendorOf(model.id) ?? 'Other';
    const vendor = label.toLowerCase();
    const group: Group = groups.get(vendor) ?? { titles: new Map(), models: [] };
    group.titles.set(label, (group.titles.get(label) ?? 0) + 1);
    group.models.push(model);
    groups.set(vendor, group);
  }
  return [...groups]
    .map(([vendor, group]) => ({
      vendor,
      title: [...group.titles].sort((a, b) => b[1] - a[1])[0]![0],
      models: group.models,
    }))
    .sort((a, b) =>
      a.vendor === 'other' ? 1 : b.vendor === 'other' ? -1 : a.title.localeCompare(b.title),
    );
}

/**
 * The picker's sections for a query: Favourites, then recent picks (skipping any whose
 * connection was deleted), then one section per connection — a big `vendor/model` catalogue
 * split into vendor sub-groups — then, when something was typed, the typed id offered on
 * each connection that does not already list it under exactly that id.
 *
 * Groups fold open or shut by `groups` (only toggled ones are stored; see `defaultOpen`).
 * Searching flattens and opens everything, because a search is for seeing every match.
 */
export function pickerSections(options: {
  connections: readonly Connection[];
  recent: readonly ModelRef[];
  favorites?: readonly ModelRef[];
  groups?: Readonly<Record<string, boolean>>;
  catalogs: Catalogs;
  query: string;
}): PickerSection[] {
  const query = options.query.trim();
  const favorites = options.favorites ?? [];
  const sections: PickerSection[] = [];
  const byId = new Map(options.connections.map((connection) => [connection.id, connection]));
  const listed = (ref: ModelRef) => {
    const entry = options.catalogs[ref.connectionId];
    return entry?.status === 'ready'
      ? entry.models.find((model) => model.id === ref.modelId)
      : undefined;
  };
  const isFavorite = (ref: ModelRef) => favorites.some((entry) => sameModelRef(entry, ref));
  const fold = (key: string) => {
    if (query) return { collapsible: false, open: true };
    return { collapsible: true, open: options.groups?.[key] ?? defaultOpen(key) };
  };

  const fromRefs = (prefix: string, refs: readonly ModelRef[]) =>
    refs.flatMap((ref): PickerOption[] => {
      const connection = byId.get(ref.connectionId);
      if (!connection) return [];
      const name = modelName(ref, options.catalogs);
      if (!matches(query, name, ref.modelId, connection.name)) return [];
      return [
        {
          key: `${prefix}:${ref.connectionId}:${ref.modelId}`,
          ref,
          name,
          connectionName: connection.name,
          hint: formatHint(listed(ref)),
          favorite: isFavorite(ref),
        },
      ];
    });

  const starred = fromRefs('favorite', favorites);
  if (starred.length) {
    // Never folds: the point of a favourite is that it is always one click away.
    sections.push({
      key: 'favorites',
      title: 'Favourites',
      options: starred,
      collapsible: false,
      open: true,
      count: starred.length,
    });
  }

  const recent = fromRefs('recent', options.recent);
  if (recent.length) {
    sections.push({
      key: groupKey.recent,
      title: 'Recent',
      options: recent,
      ...fold(groupKey.recent),
      count: recent.length,
    });
  }

  for (const connection of options.connections) {
    const key = groupKey.connection(connection.id);
    const entry = options.catalogs[connection.id];
    const noteSection = (note: string): PickerSection => ({
      key,
      title: connection.name,
      options: [],
      note,
      collapsible: false,
      open: true,
      count: 0,
    });
    if (entry?.status !== 'ready') {
      // Only worth a line when nothing is being searched for: a search shows what matched.
      if (!query) {
        sections.push(
          noteSection(
            entry?.status === 'error' ? `Could not list models: ${entry.error}` : 'Loading models…',
          ),
        );
      }
      continue;
    }
    const models = entry.models.filter((model) =>
      matches(query, model.name, model.id, connection.name),
    );
    if (!models.length) {
      if (!query)
        sections.push(noteSection('This endpoint lists no models. Type a model id above.'));
      continue;
    }
    const toOption = (model: ProviderModel): PickerOption => {
      const ref = { connectionId: connection.id, modelId: model.id };
      return {
        key: `${connection.id}:${model.id}`,
        ref,
        name: model.name,
        connectionName: connection.name,
        hint: formatHint(model),
        favorite: isFavorite(ref),
      };
    };
    const vendors = query ? null : splitByVendor(models);
    sections.push({
      key,
      title: connection.name,
      options: vendors ? [] : models.map(toOption),
      groups: vendors?.map((vendor) => {
        const vendorKey = groupKey.vendor(connection.id, vendor.vendor);
        return {
          key: vendorKey,
          title: vendor.title,
          options: vendor.models.map(toOption),
          ...fold(vendorKey),
          count: vendor.models.length,
        };
      }),
      ...fold(key),
      count: models.length,
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
          favorite: isFavorite(ref),
        },
      ];
    });
    if (typed.length) {
      sections.push({
        key: 'typed',
        title: 'Model id',
        options: typed,
        collapsible: false,
        open: true,
        count: typed.length,
      });
    }
  }

  return sections;
}

/** Whether `option` is the current pick — used to mark it in the list. */
export function isCurrent(option: PickerOption, value: ModelRef | null | undefined): boolean {
  return sameModelRef(option.ref, value ?? null);
}
