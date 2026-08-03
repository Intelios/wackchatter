import type { Connection, ProviderId, ProviderModel } from '@shared/providers/types.ts';
import { PROVIDERS } from '@shared/providers/types.ts';
import type { SettingsResponse } from '@shared/types/settings.ts';
import { activeConnection } from '@shared/types/settings.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { settingsApi } from '../../lib/api.ts';
import { ModelCombobox } from './ModelCombobox.tsx';
import './ConnectionPanel.css';

interface ConnectionPanelProps {
  settings: SettingsResponse | null;
  onChange: (settings: SettingsResponse) => void;
}

/**
 * The saved connections and the editor for the active one.
 *
 * Selecting a connection activates it — the same model as persona selection — so the
 * entry being edited is always the one generations use. The ready-gate in the chat
 * keeps an unconfigured activation from sending anything.
 *
 * List mutations go through the server's per-connection endpoints and every async
 * result is checked against the connection that requested it, so nothing captured on
 * one connection can land on another.
 */
export function ConnectionPanel({ settings, onChange }: ConnectionPanelProps) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [status, setStatus] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const connections = settings?.connections ?? [];
  const connection = settings ? activeConnection(settings) : null;
  const keyInfo = connection ? settings?.keys[connection.id] : undefined;

  // Which connection the panel shows right now. Async results compare against this
  // before touching state, so a slow load/test/save started on A cannot write into
  // B's view after the user switches.
  const connectionIdRef = useRef<string | null>(null);
  connectionIdRef.current = connection?.id ?? null;

  // Drafts and confirms belong to one connection; a switch must not carry them over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connection?.id is the trigger
  useEffect(() => {
    setKeyDraft('');
    setStatus('');
    setConfirmDelete(false);
  }, [connection?.id]);

  const apply = useCallback(
    async (op: () => Promise<SettingsResponse>) => {
      try {
        onChange(await op());
        setStatus('');
      } catch (error) {
        setStatus((error as Error).message);
      }
    },
    [onChange],
  );

  const patch = useCallback(
    (updates: Partial<Connection>) => {
      if (!connection) return;
      const id = connection.id;
      void apply(() => settingsApi.patchConnection(id, updates));
    },
    [connection, apply],
  );

  // Optimistic mirror of a keystroke so the field echoes locally; the commit on blur
  // goes through the endpoint. Display-only — never sent to the server as a list.
  function preview(updates: Partial<Connection>) {
    if (!settings || !connection) return;
    onChange({
      ...settings,
      connections: settings.connections.map((entry) =>
        entry.id === connection.id ? { ...entry, ...updates } : entry,
      ),
    });
  }

  // The model list is only fetchable once there is an endpoint to ask. The server lists
  // the active connection's catalogue, which is the one being edited here.
  const loadModels = useCallback(async () => {
    if (!connection?.baseUrl) return;
    const forId = connection.id;
    setBusy(true);
    try {
      const result = (await settingsApi.models()).models;
      if (connectionIdRef.current !== forId) return;
      setModels(result);
      setStatus('');
    } catch (error) {
      if (connectionIdRef.current !== forId) return;
      setModels([]);
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [connection?.baseUrl, connection?.id]);

  // Refresh on connection, provider or endpoint change — not on every keystroke in the
  // model box. Clearing first keeps the previous catalogue out of a new connection. The
  // id and provider are triggers in their own right: the server lists the active
  // connection's catalogue, so both can change the result without the baseUrl moving.
  // biome-ignore lint/correctness/useExhaustiveDependencies: id and provider are triggers
  useEffect(() => {
    setModels([]);
    void loadModels();
  }, [loadModels, connection?.id, connection?.provider]);

  async function saveKey() {
    if (!connection) return;
    const forId = connection.id;
    setBusy(true);
    try {
      await settingsApi.setKey(forId, keyDraft || null);
      // Re-read so the presence indicator reflects what the server actually stored.
      const fresh = await settingsApi.get();
      onChange(fresh);
      if (connectionIdRef.current !== forId) return;
      setKeyDraft('');
      setStatus(keyDraft ? 'Key saved' : 'Key cleared');
      await loadModels();
    } catch (error) {
      if (connectionIdRef.current !== forId) return;
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!connection) return;
    const forId = connection.id;
    setBusy(true);
    setStatus('Testing…');
    try {
      const result = await settingsApi.test(connection);
      if (connectionIdRef.current !== forId) return;
      setStatus(result.ok ? `Connected — ${result.models} models available` : result.error);
    } catch (error) {
      if (connectionIdRef.current !== forId) return;
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function create(provider: ProviderId) {
    void apply(() => settingsApi.createConnection(provider));
  }

  function remove() {
    if (!connection) return;
    const id = connection.id;
    void apply(() => settingsApi.removeConnection(id));
  }

  if (!settings) return <div className="wc-empty">Loading connections…</div>;

  return (
    <div className="connection">
      <div className="connection__list">
        {connections.map((entry) => {
          const isActive = entry.id === connection?.id;
          return (
            <button
              type="button"
              key={entry.id}
              className="connection__item"
              data-active={isActive || undefined}
              aria-pressed={isActive}
              onClick={() => {
                if (!isActive) void apply(() => settingsApi.save({ connectionId: entry.id }));
              }}
            >
              <span className="connection__item-name">
                {entry.name}
                {isActive ? <span className="connection__badge">Active</span> : null}
              </span>
              <span className="connection__item-summary">
                {PROVIDERS[entry.provider].label} · {entry.model || entry.baseUrl}
                {settings.keys[entry.id]?.present ? ' · key set' : ''}
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="wc-button connection__new"
        onClick={() => create('custom')}
        disabled={busy}
      >
        New connection
      </button>

      {connection ? (
        <>
          <label className="wc-label" htmlFor="wc-connection-name">
            Name
          </label>
          <input
            id="wc-connection-name"
            className="wc-input"
            value={connection.name}
            onChange={(event) => preview({ name: event.target.value })}
            onBlur={(event) =>
              patch({ name: event.target.value.trim() || PROVIDERS[connection.provider].label })
            }
          />

          <label className="wc-label" htmlFor="wc-provider">
            Provider
          </label>
          <select
            id="wc-provider"
            className="wc-select"
            value={connection.provider}
            onChange={(event) => {
              const next = event.target.value as ProviderId;
              // Switching provider also moves the endpoint to that provider's default,
              // since a base URL is meaningless across providers. The server drops the
              // stored key: it belongs to the old endpoint.
              void patch({ provider: next, baseUrl: PROVIDERS[next].defaultBaseUrl, model: '' });
            }}
          >
            {Object.values(PROVIDERS).map((descriptor) => (
              <option key={descriptor.id} value={descriptor.id}>
                {descriptor.label}
              </option>
            ))}
          </select>

          <label className="wc-label" htmlFor="wc-base-url">
            Endpoint
          </label>
          <input
            id="wc-base-url"
            className="wc-input"
            value={connection.baseUrl}
            placeholder={PROVIDERS[connection.provider].defaultBaseUrl}
            onChange={(event) => preview({ baseUrl: event.target.value })}
            onBlur={(event) => void patch({ baseUrl: event.target.value })}
          />
          <p className="wc-hint">
            The base URL, without <code>/chat/completions</code>. Local servers work too. Changing
            the endpoint clears the stored key, which belongs to the old one.
          </p>

          <label className="wc-label" htmlFor="wc-api-key">
            API key
          </label>
          <div className="connection__row">
            <input
              id="wc-api-key"
              className="wc-input"
              type="password"
              value={keyDraft}
              placeholder={keyInfo?.present ? `Stored — ends ${keyInfo.hint}` : 'Not set'}
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveKey();
              }}
            />
            <button
              type="button"
              className="wc-button"
              onClick={() => void saveKey()}
              disabled={busy}
            >
              {keyDraft ? 'Save' : 'Clear'}
            </button>
          </div>
          <p className="wc-hint">
            Stored on this machine only, never sent to the browser and never written into a preset.{' '}
            {PROVIDERS[connection.provider].requiresKey ? '' : 'Local endpoints usually need none.'}
          </p>

          <label className="wc-label" htmlFor="wc-model">
            Model
          </label>
          <div className="connection__row">
            <ModelCombobox
              models={models}
              value={connection.model}
              onCommit={(model) => void patch({ model })}
              disabled={!connection.baseUrl}
              disabledReason="Set an endpoint first"
            />
            <button
              type="button"
              className="wc-button"
              onClick={() => void loadModels()}
              disabled={busy}
              title="Refresh the model list"
            >
              Refresh
            </button>
          </div>

          <div className="connection__actions">
            <button type="button" className="wc-button" onClick={() => void test()} disabled={busy}>
              Test connection
            </button>
            {/* Two-click confirm in place — destructive, but never a blocking dialog. */}
            <button
              type="button"
              className="wc-button wc-button--ghost wc-button--danger"
              onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
              disabled={busy}
            >
              {confirmDelete ? 'Click again to delete' : 'Delete'}
            </button>
            {status ? <span className="connection__status">{status}</span> : null}
          </div>
        </>
      ) : (
        <p className="wc-hint">No connections yet — add one to start chatting.</p>
      )}
    </div>
  );
}
