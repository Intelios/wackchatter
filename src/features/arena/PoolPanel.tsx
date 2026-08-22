/**
 * Setting up what the Arena draws from: contenders, cards, probes, and the shared prompt.
 *
 * Two conventions do a lot of work here. Contenders and probes follow the persona rule —
 * the id is opaque and stable, the name is editable — because recorded rounds key on the
 * id, and a rename must never orphan a rating. And nothing is ever silently dropped: a
 * contender whose connection was deleted stays in the list, disabled, with the reason on
 * its own row, because the alternative is a pool that quietly shrinks when you tidy your
 * connections and a leaderboard whose labels change with it.
 */

import type { Connection, ProviderModel } from '@shared/providers/types.ts';
import type { ArenaProbe, ArenaSettings, Contender } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import { useCallback, useEffect, useState } from 'react';
import { PlusIcon, TrashIcon } from '../../layout/icons.tsx';
import { settingsApi } from '../../lib/api.ts';
import { ModelCombobox } from '../connection/ModelCombobox.tsx';
import type { ResolvedContender } from './contenders.ts';

interface PoolPanelProps {
  settings: ArenaSettings;
  onSettingsChange: (patch: Partial<ArenaSettings>) => void;
  resolved: readonly ResolvedContender[];
  connections: readonly Connection[];
  characters: readonly CharacterSummary[];
  personas: readonly Persona[];
  presets: readonly PresetSummary[];
  activePresetId: string | null;
  roundCount: number;
  onClearHistory: () => void;
}

export function PoolPanel({
  settings,
  onSettingsChange,
  resolved,
  connections,
  characters,
  personas,
  presets,
  activePresetId,
  roundCount,
  onClearHistory,
}: PoolPanelProps) {
  const [models, setModels] = useState<Record<string, ProviderModel[]>>({});
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    if (!confirmingClear) return;
    const timer = setTimeout(() => setConfirmingClear(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingClear]);

  /*
   * Model catalogues, fetched once per connection that a contender actually points at.
   *
   * Lazily and per connection rather than for all of them up front: a pool of six
   * contenders on one endpoint should cost one request, and an endpoint nobody is using
   * should cost none.
   */
  const wanted = [...new Set(settings.contenders.map((entry) => entry.connectionId))].filter(
    (id) => id && connections.some((connection) => connection.id === id),
  );
  const wantedKey = wanted.join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: wantedKey stands in for wanted
  useEffect(() => {
    let cancelled = false;
    for (const id of wanted) {
      if (models[id]) continue;
      void settingsApi
        .models(id)
        .then((result) => {
          if (!cancelled) setModels((current) => ({ ...current, [id]: result.models }));
        })
        .catch(() => {
          // An endpoint that will not list its models is not an error worth a banner: the
          // combobox accepts a typed model id, which is the whole reason it is a combobox.
          if (!cancelled) setModels((current) => ({ ...current, [id]: [] }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [wantedKey, models]);

  const patchContender = useCallback(
    (id: string, patch: Partial<Contender>) => {
      onSettingsChange({
        contenders: settings.contenders.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry,
        ),
      });
    },
    [onSettingsChange, settings.contenders],
  );

  const addContender = useCallback(() => {
    const connection = connections[0];
    onSettingsChange({
      contenders: [
        ...settings.contenders,
        {
          id: crypto.randomUUID(),
          name: '',
          connectionId: connection?.id ?? '',
          // Empty follows the connection's own model, which is the right default: it makes
          // "benchmark what I normally use" a one-click entry.
          model: '',
          enabled: true,
        },
      ],
    });
  }, [connections, onSettingsChange, settings.contenders]);

  const removeContender = useCallback(
    (id: string) => {
      // Rounds are NOT touched. A contender's history outlives it — see `replayRatings`.
      onSettingsChange({
        contenders: settings.contenders.filter((entry) => entry.id !== id),
      });
    },
    [onSettingsChange, settings.contenders],
  );

  const patchProbe = useCallback(
    (id: string, text: string) => {
      onSettingsChange({
        probes: settings.probes.map((entry) => (entry.id === id ? { ...entry, text } : entry)),
      });
    },
    [onSettingsChange, settings.probes],
  );

  const addProbe = useCallback(
    (text = '') => {
      const probe: ArenaProbe = { id: crypto.randomUUID(), text };
      onSettingsChange({ probes: [...settings.probes, probe] });
    },
    [onSettingsChange, settings.probes],
  );

  const toggleCard = useCallback(
    (avatar: string) => {
      const pool = settings.cardPool.includes(avatar)
        ? settings.cardPool.filter((entry) => entry !== avatar)
        : [...settings.cardPool, avatar];
      onSettingsChange({ cardPool: pool });
    },
    [onSettingsChange, settings.cardPool],
  );

  const everyCard = settings.cardPool.length === 0;

  return (
    <div className="arena-pool">
      <section className="arena-pool__section">
        <header className="arena-pool__head">
          <h2>Contenders</h2>
          <button type="button" className="wc-button" onClick={addContender}>
            <PlusIcon />
            Add contender
          </button>
        </header>
        <p className="wc-hint">
          An endpoint plus a model. One connection can hold as many contenders as you like — leave
          the model blank to use the connection's own.
        </p>

        {resolved.length === 0 ? (
          <p className="wc-empty">No contenders yet. Add two to start comparing.</p>
        ) : null}

        {resolved.map(({ contender, connection, unavailableReason }) => (
          <div
            key={contender.id}
            className="arena-contender"
            data-unavailable={unavailableReason !== null}
          >
            <input
              className="wc-input arena-contender__name"
              value={contender.name}
              placeholder="Name it (optional)"
              aria-label="Contender name"
              onChange={(event) => patchContender(contender.id, { name: event.target.value })}
            />

            <select
              className="wc-select"
              value={contender.connectionId}
              aria-label="Connection"
              onChange={(event) =>
                // The model belongs to the endpoint it was chosen against, so moving the
                // contender drops it rather than pointing a stale id at a new server.
                patchContender(contender.id, { connectionId: event.target.value, model: '' })
              }
            >
              <option value="">Choose a connection…</option>
              {connections.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>

            <div className="arena-contender__model">
              <ModelCombobox
                models={models[contender.connectionId] ?? []}
                value={contender.model}
                onCommit={(model) => patchContender(contender.id, { model })}
                disabled={!contender.connectionId}
                disabledReason="Choose a connection first"
              />
            </div>

            <label className="arena-contender__enabled">
              <input
                type="checkbox"
                checked={contender.enabled}
                onChange={(event) =>
                  patchContender(contender.id, { enabled: event.target.checked })
                }
              />
              <span>In blind draw</span>
            </label>

            <button
              type="button"
              className="wc-button wc-button--ghost wc-button--danger"
              onClick={() => removeContender(contender.id)}
              title="Remove from the pool. Its recorded rounds are kept."
              aria-label={`Remove ${contender.name || 'contender'}`}
            >
              <TrashIcon />
            </button>

            {unavailableReason ? (
              <p className="arena-contender__reason">{unavailableReason}</p>
            ) : connection ? (
              <p className="arena-contender__resolved">
                {connection.name} · {connection.model}
              </p>
            ) : null}
          </div>
        ))}
      </section>

      <section className="arena-pool__section">
        <header className="arena-pool__head">
          <h2>Probes</h2>
          <button type="button" className="wc-button" onClick={() => addProbe()}>
            <PlusIcon />
            Add probe
          </button>
        </header>
        <p className="wc-hint">
          What the user says. A blind round draws one at random, so write the kinds of turn you
          actually send. Macros work: <code>{'{{char}}'}</code>, <code>{'{{user}}'}</code>.
        </p>

        {settings.probes.length === 0 ? (
          <div className="arena-pool__empty">
            <p className="wc-empty">
              No probes yet — a blind round has nothing to ask. Add your own, or start from one of
              these.
            </p>
            <div className="arena-pool__suggestions">
              {SUGGESTED_PROBES.map((text) => (
                <button
                  key={text}
                  type="button"
                  className="wc-button wc-button--ghost"
                  onClick={() => addProbe(text)}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {settings.probes.map((probe, index) => (
          <div key={probe.id} className="arena-probe">
            <textarea
              className="wc-textarea"
              value={probe.text}
              rows={2}
              aria-label={`Probe ${index + 1}`}
              onChange={(event) => patchProbe(probe.id, event.target.value)}
            />
            <button
              type="button"
              className="wc-button wc-button--ghost wc-button--danger"
              onClick={() =>
                onSettingsChange({
                  probes: settings.probes.filter((entry) => entry.id !== probe.id),
                })
              }
              aria-label={`Remove probe ${index + 1}`}
            >
              <TrashIcon />
            </button>
          </div>
        ))}
      </section>

      <section className="arena-pool__section">
        <header className="arena-pool__head">
          <h2>Cards</h2>
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => onSettingsChange({ cardPool: [] })}
            disabled={everyCard}
            title={everyCard ? 'Already using every card' : 'Draw from the whole library again'}
          >
            Use every card
          </button>
        </header>
        <p className="wc-hint">
          {everyCard
            ? 'Blind rounds draw from your whole library.'
            : `Blind rounds draw from these ${settings.cardPool.length}.`}
        </p>

        <div className="arena-cards">
          {characters.map((character) => (
            <label key={character.avatar} className="arena-cards__item">
              <input
                type="checkbox"
                checked={everyCard || settings.cardPool.includes(character.avatar)}
                onChange={() => toggleCard(character.avatar)}
              />
              <span>{character.name}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="arena-pool__section">
        <h2>Round setup</h2>
        <p className="wc-hint">
          Both sides of a round always share these, which is what makes the comparison about the
          model rather than the setup.
        </p>

        <div className="arena-pool__row">
          <label className="wc-label" htmlFor="arena-preset">
            Preset
          </label>
          <select
            id="arena-preset"
            className="wc-select"
            value={settings.presetId ?? ''}
            onChange={(event) => onSettingsChange({ presetId: event.target.value || null })}
          >
            <option value="">
              Active preset
              {activePresetId
                ? ` (${presets.find((entry) => entry.id === activePresetId)?.name ?? activePresetId})`
                : ''}
            </option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </div>

        <div className="arena-pool__row">
          <label className="wc-label" htmlFor="arena-persona">
            Persona
          </label>
          <select
            id="arena-persona"
            className="wc-select"
            value={settings.personaId ?? ''}
            onChange={(event) => onSettingsChange({ personaId: event.target.value || null })}
          >
            <option value="">No persona</option>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
        </div>
        <p className="wc-hint">
          Pinned here rather than following the app's current persona: a benchmark whose prompts
          change when you switch persona elsewhere is not measuring models.
        </p>

        <label className="arena-pool__check">
          <input
            type="checkbox"
            checked={settings.holdBlindUntilComplete}
            onChange={(event) => onSettingsChange({ holdBlindUntilComplete: event.target.checked })}
          />
          <span>Hold blind replies until both finish</span>
        </label>
        <p className="wc-hint">
          On by default. Token rate gives a model away as surely as its name — a local model and a
          hosted one are told apart by cadence alone.
        </p>
      </section>

      <section className="arena-pool__section">
        <h2>History</h2>
        <p className="wc-hint">
          {roundCount === 0
            ? 'No blind rounds recorded yet.'
            : `${roundCount} blind ${roundCount === 1 ? 'round' : 'rounds'} recorded. The leaderboard is replayed from them, so clearing this resets every rating.`}
        </p>
        <button
          type="button"
          className="wc-button wc-button--ghost wc-button--danger"
          data-confirming={confirmingClear}
          disabled={roundCount === 0}
          onClick={() => {
            if (!confirmingClear) {
              setConfirmingClear(true);
              return;
            }
            setConfirmingClear(false);
            onClearHistory();
          }}
          onBlur={() => setConfirmingClear(false)}
        >
          <TrashIcon />
          {confirmingClear ? 'Click again to erase every round' : 'Clear benchmark history'}
        </button>
      </section>
    </div>
  );
}

/**
 * Starter probes, offered only while the pool is empty.
 *
 * Offered, not bundled: they are inserted by a click and become the user's own, so the
 * default really is an empty list — the same line quick commands and regex scripts hold.
 * Without them a first-time blind round is a wall with no obvious next step.
 */
const SUGGESTED_PROBES = [
  '*I step through the door and stop.* So you’re the one they warned me about.',
  'Tell me what you actually want. No hedging.',
  '*I say nothing, and wait for {{char}} to break the silence.*',
  'Something is wrong here. What are you not telling me?',
];
