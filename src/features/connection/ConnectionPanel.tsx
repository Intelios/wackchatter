import type { ConnectionSettings, ProviderId, ProviderModel } from '@shared/providers/types.ts';
import { PROVIDERS } from '@shared/providers/types.ts';
import type { SettingsResponse } from '@shared/types/settings.ts';
import { useCallback, useEffect, useState } from 'react';
import { settingsApi } from '../../lib/api.ts';
import { ModelCombobox } from './ModelCombobox.tsx';
import './ConnectionPanel.css';

interface ConnectionPanelProps {
  settings: SettingsResponse | null;
  onChange: (settings: SettingsResponse) => void;
}

export function ConnectionPanel({ settings, onChange }: ConnectionPanelProps) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [status, setStatus] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const connection = settings?.connection;
  const provider = connection?.provider ?? 'custom';
  const keyInfo = settings?.keys?.[provider];

  const patch = useCallback(
    async (updates: Partial<ConnectionSettings>) => {
      if (!connection) return;
      try {
        onChange(await settingsApi.save({ connection: { ...connection, ...updates } }));
        setStatus('');
      } catch (error) {
        setStatus((error as Error).message);
      }
    },
    [connection, onChange],
  );

  // The model list is only fetchable once there is an endpoint to ask.
  const loadModels = useCallback(async () => {
    if (!connection?.baseUrl) return;
    setBusy(true);
    try {
      setModels((await settingsApi.models()).models);
      setStatus('');
    } catch (error) {
      setModels([]);
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [connection?.baseUrl]);

  // Refresh on provider or endpoint change, not on every keystroke in the model box.
  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  async function saveKey() {
    setBusy(true);
    try {
      await settingsApi.setKey(provider, keyDraft || null);
      setKeyDraft('');
      // Re-read so the presence indicator reflects what the server actually stored.
      onChange(await settingsApi.get());
      setStatus(keyDraft ? 'Key saved' : 'Key cleared');
      await loadModels();
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!connection) return;
    setBusy(true);
    setStatus('Testing…');
    try {
      const result = await settingsApi.test(connection);
      setStatus(result.ok ? `Connected — ${result.models} models available` : result.error);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!connection) return <div className="wc-empty">Loading connection…</div>;

  return (
    <div className="connection">
      <label className="wc-label" htmlFor="wc-provider">
        Provider
      </label>
      <select
        id="wc-provider"
        className="wc-select"
        value={provider}
        onChange={(event) => {
          const next = event.target.value as ProviderId;
          // Switching provider also moves the endpoint to that provider's default,
          // since a base URL is meaningless across providers.
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
        placeholder={PROVIDERS[provider].defaultBaseUrl}
        onChange={(event) =>
          onChange({ ...settings!, connection: { ...connection, baseUrl: event.target.value } })
        }
        onBlur={(event) => void patch({ baseUrl: event.target.value })}
      />
      <p className="wc-hint">
        The base URL, without <code>/chat/completions</code>. Local servers work too.
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
        <button type="button" className="wc-button" onClick={() => void saveKey()} disabled={busy}>
          {keyDraft ? 'Save' : 'Clear'}
        </button>
      </div>
      <p className="wc-hint">
        Stored on this machine only, never sent to the browser and never written into a preset.{' '}
        {PROVIDERS[provider].requiresKey ? '' : 'Local endpoints usually need none.'}
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

      <label className="connection__check">
        <input
          type="checkbox"
          checked={connection.showReasoning !== false}
          onChange={(event) => void patch({ showReasoning: event.target.checked })}
        />
        <span>
          Show reasoning
          <span className="wc-hint">Ask reasoning models for their thinking text.</span>
        </span>
      </label>

      <label className="connection__check">
        <input
          type="checkbox"
          checked={Boolean(connection.reportUsage)}
          onChange={(event) => void patch({ reportUsage: event.target.checked })}
        />
        <span>
          Report real token usage
          <span className="wc-hint">
            Exact counts from the provider instead of our estimate. Some OpenAI-compatible proxies
            reject the request, so it is off by default.
          </span>
        </span>
      </label>

      <div className="connection__actions">
        <button type="button" className="wc-button" onClick={() => void test()} disabled={busy}>
          Test connection
        </button>
        {status ? <span className="connection__status">{status}</span> : null}
      </div>
    </div>
  );
}
