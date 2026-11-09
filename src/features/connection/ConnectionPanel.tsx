import type { ModelRef } from '@shared/models/slots.ts';
import type { Connection, ProviderId } from '@shared/providers/types.ts';
import { PROVIDERS } from '@shared/providers/types.ts';
import type { SettingsResponse } from '@shared/types/settings.ts';
import { useCallback, useRef, useState } from 'react';
import { Select } from '../../components/Select.tsx';
import { PlusIcon, TrashIcon } from '../../layout/icons.tsx';
import { settingsApi } from '../../lib/api.ts';
import { ModelPicker } from '../models/ModelPicker.tsx';
import {
  addRow,
  type HeaderRow,
  headersToRows,
  removeRow,
  rowsToHeaders,
  updateRow,
} from './headers.ts';
import './ConnectionPanel.css';

interface ConnectionPanelProps {
  settings: SettingsResponse | null;
  onChange: (settings: SettingsResponse) => void;
  /** Off where the chat model is picked elsewhere (the 3.0 Preset tool). */
  showChatModel?: boolean;
}

/**
 * The chat model, the saved connections, and the editor for one of them.
 *
 * A connection is an endpoint, not a choice of model: models are picked per feature
 * (`shared/models/slots.ts`), the chat's at the top here. Selecting a connection in the
 * list only opens it for editing — nothing about what generations run on moves.
 *
 * List mutations go through the server's per-connection endpoints and every async
 * result is checked against the connection that requested it, so nothing captured on
 * one connection can land on another.
 */
export function ConnectionPanel({
  settings,
  onChange,
  showChatModel = true,
}: ConnectionPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const connections = settings?.connections ?? [];
  const chatModel = settings?.models.chat ?? null;
  // The entry being edited: the one picked in the list, else the chat model's, else the first.
  const connection =
    connections.find((entry) => entry.id === editingId) ??
    connections.find((entry) => entry.id === chatModel?.connectionId) ??
    connections[0] ??
    null;

  async function apply(op: () => Promise<SettingsResponse>) {
    setBusy(true);
    try {
      onChange(await op());
      setStatus('');
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function create(provider: ProviderId) {
    void apply(async () => {
      const next = await settingsApi.createConnection(provider);
      // The server appends; open the new entry for editing.
      setEditingId(next.connections.at(-1)?.id ?? null);
      return next;
    });
  }

  function pickChatModel(ref: ModelRef | null) {
    void apply(() => settingsApi.save({ models: { chat: ref } }));
  }

  if (!settings) return <div className="wc-empty">Loading connections…</div>;

  return (
    <div className="connection">
      {showChatModel ? (
        <>
          <label className="wc-label" htmlFor="wc-chat-model">
            Chat model
          </label>
          <ModelPicker
            id="wc-chat-model"
            label="Chat model"
            value={chatModel}
            onChange={pickChatModel}
          />
          <p className="wc-hint">
            Replies, recaps, impersonation and persona drafting run on this model. Summary, Nexus
            and the Co-Creators pick their own in their settings.
          </p>
        </>
      ) : null}

      <span className="wc-label">Connections</span>
      <div className="connection__list">
        {connections.map((entry) => {
          const isOpen = entry.id === connection?.id;
          return (
            <button
              type="button"
              key={entry.id}
              className="connection__item"
              data-active={isOpen || undefined}
              aria-pressed={isOpen}
              onClick={() => setEditingId(entry.id)}
            >
              <span className="connection__item-name">
                {entry.name}
                {entry.id === chatModel?.connectionId ? (
                  <span className="connection__badge">Chat</span>
                ) : null}
              </span>
              <span className="connection__item-summary">
                {PROVIDERS[entry.provider].label} · {entry.baseUrl}
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
      {status ? <span className="connection__status">{status}</span> : null}

      {connection ? (
        <ConnectionEditor
          key={connection.id}
          settings={settings}
          connection={connection}
          onChange={onChange}
          showTest
        />
      ) : (
        <p className="wc-hint">No connections yet — add one, then pick a chat model above.</p>
      )}
    </div>
  );
}

/**
 * The fields of one connection: name, provider, endpoint, key and custom headers, with
 * delete (two clicks) and, where asked, a test. Keyed by connection id at the call site,
 * so drafts never cross over.
 *
 * Every write goes through the server's per-connection endpoints and every async result is
 * checked against the connection that asked, so nothing captured on one can land on another.
 */
export function ConnectionEditor({
  settings,
  connection,
  onChange,
  showTest = false,
}: {
  settings: SettingsResponse;
  connection: Connection;
  onChange: (settings: SettingsResponse) => void;
  showTest?: boolean;
}) {
  const [status, setStatus] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() =>
    headersToRows(connection.headers),
  );
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const keyInfo = settings.keys[connection.id];

  // Which connection this editor shows. Async results compare against it before touching
  // state, so a slow save started on A cannot write into B's view.
  const connectionIdRef = useRef<string>(connection.id);
  connectionIdRef.current = connection.id;

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
      const id = connection.id;
      void apply(() => settingsApi.patchConnection(id, updates));
    },
    [connection.id, apply],
  );

  // Header rows are the editor's own state; the commit sends the whole record because
  // the patch replaces it — `{}` is what clears.
  const commitHeaders = useCallback(
    (rows: HeaderRow[]) => {
      const id = connection.id;
      void apply(() => settingsApi.patchConnection(id, { headers: rowsToHeaders(rows) }));
    },
    [connection.id, apply],
  );

  // Optimistic mirror of a keystroke so the field echoes locally; the commit on blur
  // goes through the endpoint. Display-only — never sent to the server as a list.
  function preview(updates: Partial<Connection>) {
    onChange({
      ...settings,
      connections: settings.connections.map((entry) =>
        entry.id === connection.id ? { ...entry, ...updates } : entry,
      ),
    });
  }

  async function saveKey() {
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
    } catch (error) {
      if (connectionIdRef.current !== forId) return;
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
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

  function remove() {
    const id = connection.id;
    void apply(() => settingsApi.removeConnection(id));
  }

  const idFor = (field: string) => `wc-connection-${field}-${connection.id}`;

  return (
    <div className="connection__editor">
      <label className="wc-label" htmlFor={idFor('name')}>
        Name
      </label>
      <input
        id={idFor('name')}
        className="wc-input"
        value={connection.name}
        onChange={(event) => preview({ name: event.target.value })}
        onBlur={(event) =>
          patch({ name: event.target.value.trim() || PROVIDERS[connection.provider].label })
        }
      />

      <label className="wc-label" htmlFor={idFor('provider')}>
        Provider
      </label>
      <Select
        id={idFor('provider')}
        label="Provider"
        value={connection.provider}
        options={Object.values(PROVIDERS).map((descriptor) => ({
          value: descriptor.id,
          label: descriptor.label,
          description: descriptor.defaultBaseUrl,
        }))}
        onChange={(next) => {
          // Switching provider also moves the endpoint to that provider's default,
          // since a base URL is meaningless across providers. The server drops the
          // stored key: it belongs to the old endpoint.
          void patch({ provider: next, baseUrl: PROVIDERS[next].defaultBaseUrl });
        }}
      />

      <label className="wc-label" htmlFor={idFor('url')}>
        Endpoint
      </label>
      <input
        id={idFor('url')}
        className="wc-input"
        value={connection.baseUrl}
        placeholder={PROVIDERS[connection.provider].defaultBaseUrl}
        onChange={(event) => preview({ baseUrl: event.target.value })}
        onBlur={(event) => void patch({ baseUrl: event.target.value })}
      />
      <p className="wc-hint">
        The base URL, without <code>/chat/completions</code>. Local servers work too. Changing the
        endpoint clears the stored key, which belongs to the old one.
      </p>

      <label className="wc-label" htmlFor={idFor('key')}>
        API key
      </label>
      <div className="connection__row">
        <input
          id={idFor('key')}
          className="wc-input"
          type="password"
          value={keyDraft}
          placeholder={keyInfo?.present ? `Stored — ends ${keyInfo.hint}` : 'Not set'}
          onChange={(event) => setKeyDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void saveKey();
          }}
        />
        <button type="button" className="wc-button" onClick={() => void saveKey()} disabled={busy}>
          {keyDraft ? 'Save' : 'Clear'}
        </button>
      </div>
      <p className="wc-hint">
        Stored on this machine only, never sent to the browser and never written into a preset.{' '}
        {PROVIDERS[connection.provider].requiresKey ? '' : 'Local endpoints usually need none.'}
      </p>

      <span className="wc-label">Custom headers</span>
      {headerRows.map((row) => (
        <div className="connection__header-row" key={row.id}>
          <input
            className="wc-input"
            value={row.name}
            placeholder="Header name"
            aria-label="Header name"
            onChange={(event) =>
              setHeaderRows((rows) => updateRow(rows, row.id, { name: event.target.value }))
            }
            onBlur={() => commitHeaders(headerRows)}
          />
          <input
            className="wc-input connection__header-value"
            value={row.value}
            placeholder="Value"
            aria-label="Header value"
            onChange={(event) =>
              setHeaderRows((rows) => updateRow(rows, row.id, { value: event.target.value }))
            }
            onBlur={() => commitHeaders(headerRows)}
          />
          <button
            type="button"
            className="wc-button wc-button--ghost"
            title="Remove header"
            onClick={() => {
              const next = removeRow(headerRows, row.id);
              setHeaderRows(next);
              commitHeaders(next);
            }}
          >
            <TrashIcon />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="wc-button connection__add-header"
        onClick={() => {
          const next = addRow(headerRows, crypto.randomUUID());
          setHeaderRows(next);
          commitHeaders(next);
        }}
      >
        <PlusIcon />
        Add header
      </button>
      <p className="wc-hint">
        Sent with every request, after ours — yours win. <code>{'{{key}}'}</code> in a value sends
        the stored API key, which stays on this machine; an empty value removes a header (e.g.{' '}
        <code>authorization</code>).
      </p>

      <div className="connection__actions">
        {showTest ? (
          <button type="button" className="wc-button" onClick={() => void test()} disabled={busy}>
            Test connection
          </button>
        ) : null}
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
    </div>
  );
}
