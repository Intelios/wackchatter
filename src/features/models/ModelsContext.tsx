/**
 * What every model picker needs and no feature should have to thread: the saved
 * connections, the recent picks, each connection's model catalogue, and a way to record a
 * pick as recent.
 *
 * Catalogues are fetched when a picker opens, once per connection endpoint, and kept for the
 * session: a model list changes on the scale of weeks, and refetching on every open would
 * make the picker wait on the network each time. Editing a connection's provider or URL
 * drops its entry, since the old list describes a different server. A picker can force a
 * refresh.
 */

import { type ModelRef, pushRecentModel } from '@shared/models/slots.ts';
import type { Connection } from '@shared/providers/types.ts';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { settingsApi } from '../../lib/api.ts';
import type { Catalogs } from './pickerLogic.ts';

export interface ModelsContextValue {
  connections: readonly Connection[];
  recentModels: readonly ModelRef[];
  /** The chat slot, so a slot that follows chat can say which model that is. */
  chatModel: ModelRef | null;
  catalogs: Catalogs;
  /** Fetch every connection's catalogue not already held; `force` refetches them all. */
  loadCatalogs: (force?: boolean) => void;
  /** Put a pick at the head of the recents. */
  rememberModel: (ref: ModelRef) => void;
}

const ModelsContext = createContext<ModelsContextValue | null>(null);

export function useModels(): ModelsContextValue {
  const value = useContext(ModelsContext);
  if (!value) throw new Error('useModels needs a ModelsProvider above it.');
  return value;
}

/** What makes a fetched catalogue stale: a different server behind the same connection. */
function endpointKey(connection: Connection): string {
  return `${connection.provider}|${connection.baseUrl}`;
}

export function ModelsProvider({
  connections,
  recentModels,
  chatModel,
  onRecentModels,
  children,
}: {
  connections: readonly Connection[];
  recentModels: readonly ModelRef[];
  chatModel: ModelRef | null;
  /** Persist the new recents. */
  onRecentModels: (next: ModelRef[]) => void;
  children: ReactNode;
}) {
  const [catalogs, setCatalogs] = useState<Catalogs>({});
  /** The endpoint each held catalogue was fetched from. */
  const fetchedFrom = useRef(new Map<string, string>());

  // Drop catalogues whose connection was deleted or now points somewhere else.
  useEffect(() => {
    const stale: string[] = [];
    for (const [id, key] of fetchedFrom.current) {
      const connection = connections.find((entry) => entry.id === id);
      if (!connection || endpointKey(connection) !== key) stale.push(id);
    }
    if (!stale.length) return;
    for (const id of stale) fetchedFrom.current.delete(id);
    setCatalogs((current) => {
      const next = { ...current };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [connections]);

  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;

  const loadCatalogs = useCallback((force = false) => {
    for (const connection of connectionsRef.current) {
      const key = endpointKey(connection);
      if (!force && fetchedFrom.current.get(connection.id) === key) continue;
      fetchedFrom.current.set(connection.id, key);
      setCatalogs((current) => ({ ...current, [connection.id]: { status: 'loading' } }));
      settingsApi
        .models(connection.id)
        .then(({ models }) => {
          if (fetchedFrom.current.get(connection.id) !== key) return;
          setCatalogs((current) => ({ ...current, [connection.id]: { status: 'ready', models } }));
        })
        .catch((error: unknown) => {
          if (fetchedFrom.current.get(connection.id) !== key) return;
          setCatalogs((current) => ({
            ...current,
            [connection.id]: { status: 'error', error: (error as Error).message },
          }));
        });
    }
  }, []);

  // Read through a ref so a pick made from a stale render still builds on the latest list.
  const recentRef = useRef(recentModels);
  recentRef.current = recentModels;
  const rememberModel = useCallback(
    (ref: ModelRef) => {
      const next = pushRecentModel(recentRef.current, ref);
      recentRef.current = next;
      onRecentModels(next);
    },
    [onRecentModels],
  );

  const value = useMemo(
    () => ({ connections, recentModels, chatModel, catalogs, loadCatalogs, rememberModel }),
    [connections, recentModels, chatModel, catalogs, loadCatalogs, rememberModel],
  );
  return <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>;
}
