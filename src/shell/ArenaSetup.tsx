/**
 * Setup: what every Benchmark round draws from, on its own page. The cards as portraits you
 * click in or out of the draw, the cues as a list you edit in place (each can sit out
 * without being deleted), and the rest (preset, persona, holding the writing) as one row.
 *
 * An empty card pool means every character. Switching one off from there writes out the
 * rest explicitly, so the draw only changes by the card you clicked.
 */

import type { ArenaSettings } from '@shared/types/arena.ts';
import { activeProbes } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import { useMemo, useState } from 'react';
import { Popover } from '../components/Popover.tsx';
import type { ArenaController } from '../features/arena/useArena.ts';
import { characterApi } from '../lib/api.ts';
import { Switch, useArm } from './controls.tsx';
import { Icon } from './icons.tsx';

export function ArenaSetup({
  arena,
  characters,
  presets,
  personas,
  onSettingsChange,
}: {
  arena: ArenaController;
  characters: readonly CharacterSummary[];
  presets: readonly PresetSummary[];
  personas: readonly Persona[];
  onSettingsChange: (patch: Partial<ArenaSettings>) => void;
}) {
  const { settings } = arena;
  const arm = useArm();
  const [query, setQuery] = useState('');
  const [newCue, setNewCue] = useState('');

  const pool = settings.cardPool;
  const everyone = pool.length === 0;
  const inDraw = (avatar: string) => everyone || pool.includes(avatar);
  const known = useMemo(() => new Set(characters.map((c) => c.avatar)), [characters]);
  const gone = pool.filter((id) => !known.has(id));

  // In the draw first, then the rest; both alphabetical. The search narrows both.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = characters.filter((c) => !q || c.name.toLowerCase().includes(q));
    return [...list].sort((a, b) => {
      const ai = everyone || pool.includes(a.avatar) ? 0 : 1;
      const bi = everyone || pool.includes(b.avatar) ? 0 : 1;
      return ai - bi || a.name.localeCompare(b.name);
    });
  }, [characters, query, everyone, pool]);

  const toggleCard = (avatar: string) => {
    if (everyone) {
      onSettingsChange({ cardPool: characters.map((c) => c.avatar).filter((a) => a !== avatar) });
    } else if (pool.includes(avatar)) {
      onSettingsChange({ cardPool: pool.filter((a) => a !== avatar) });
    } else {
      onSettingsChange({ cardPool: [...pool, avatar] });
    }
  };

  const drawCount = everyone ? characters.length : pool.filter((id) => known.has(id)).length;
  const cueCount = activeProbes(settings.probes).length;
  const probes = settings.probes;
  const setProbe = (id: string, patch: Partial<(typeof probes)[number]>) =>
    onSettingsChange({ probes: probes.map((p) => (p.id === id ? { ...p, ...patch } : p)) });

  const presetId = settings.presetId ?? arena.presetId;
  const presetName = presets.find((p) => p.id === presetId)?.name ?? 'The chat preset';
  const personaName = personas.find((p) => p.id === settings.personaId)?.name ?? 'None';

  return (
    <div className="w3-ar-board w3-ar-setpage">
      <header className="w3-ar-head">
        <div className="w3-ar-head__t">
          <h1>Setup</h1>
          <p>
            {drawCount} {drawCount === 1 ? 'card' : 'cards'} · {cueCount}{' '}
            {cueCount === 1 ? 'cue' : 'cues'} · what every Benchmark round draws from
          </p>
        </div>
      </header>

      <div className="w3-ar-setopts">
        <Choice
          label="Preset"
          value={presetName}
          options={presets.map((p) => ({ id: p.id, name: p.name }))}
          current={presetId ?? ''}
          onPick={(id) => onSettingsChange({ presetId: id })}
        />
        <Choice
          label="Persona"
          value={personaName}
          options={[{ id: '', name: 'None' }, ...personas.map((p) => ({ id: p.id, name: p.name }))]}
          current={settings.personaId ?? ''}
          onPick={(id) => onSettingsChange({ personaId: id || null })}
        />
        <span
          className="w3-ar-setopt"
          title="How fast text arrives can give a model away, so blind replies show once both are done."
        >
          <small>Hold the writing</small>
          <Switch
            on={settings.holdBlindUntilComplete}
            label="Hold the replies until both finish"
            onChange={(on) => onSettingsChange({ holdBlindUntilComplete: on })}
          />
        </span>
        <span className="w3-ar-gap" />
        <button
          type="button"
          className="w3-st-ghost w3-st-ghost--sm"
          data-armed={arm.armed === 'clear' ? '' : undefined}
          disabled={arena.rounds.length === 0}
          title={`${arena.rounds.length} blind rounds recorded`}
          onClick={() => arm.press('clear', arena.clearHistory)}
        >
          {arm.armed === 'clear' ? 'Erase every round?' : 'Erase all rounds'}
        </button>
      </div>

      <div className="w3-ar-setcols">
        <section className="w3-ar-setsec">
          <div className="w3-ar-setsec__h">
            <h2>Cards</h2>
            <small>
              {everyone ? 'Every character is in' : `${drawCount} of ${characters.length} in`} ·
              click to switch
            </small>
          </div>
          <label className="w3-ar-find">
            <Icon name="search" size="sm" />
            <input
              value={query}
              placeholder="Find a character"
              aria-label="Find a character"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {gone.length ? (
            <p className="w3-ar-setgone">
              {gone.length} {gone.length === 1 ? 'card in the draw is' : 'cards in the draw are'}{' '}
              gone from the library.
              <button
                type="button"
                onClick={() => onSettingsChange({ cardPool: pool.filter((id) => known.has(id)) })}
              >
                Take {gone.length === 1 ? 'it' : 'them'} out
              </button>
            </p>
          ) : null}
          <div className="w3-ar-cards">
            {shown.map((c) => {
              const on = inDraw(c.avatar);
              return (
                <button
                  key={c.avatar}
                  type="button"
                  className="w3-ar-card"
                  aria-pressed={on}
                  title={on ? `Take ${c.name} out of the draw` : `Put ${c.name} in the draw`}
                  onClick={() => toggleCard(c.avatar)}
                >
                  <img src={characterApi.imageUrl(c.avatar, c.modified)} alt="" loading="lazy" />
                  <span className="w3-ar-card__tick">
                    <Icon name="check" size="xs" />
                  </span>
                  <b>{c.name}</b>
                </button>
              );
            })}
            {shown.length === 0 ? <p className="w3-ar-faint">No character by that name.</p> : null}
          </div>
        </section>

        <section className="w3-ar-setsec">
          <div className="w3-ar-setsec__h">
            <h2>Cues</h2>
            <small>
              {cueCount} in use · {'{{char}}'} and {'{{user}}'} fill in
            </small>
          </div>
          <div className="w3-ar-cuelist">
            {probes.map((probe, index) => (
              <div
                key={probe.id}
                className="w3-ar-cuerow"
                data-off={probe.enabled === false ? '' : undefined}
              >
                <span className="w3-ar-cuerow__n">{String(index + 1).padStart(2, '0')}</span>
                <textarea
                  value={probe.text}
                  aria-label={`Cue ${index + 1}`}
                  rows={Math.min(5, Math.max(1, Math.ceil(probe.text.length / 46)))}
                  onChange={(event) => setProbe(probe.id, { text: event.target.value })}
                />
                <Switch
                  on={probe.enabled !== false}
                  label={`Use cue ${index + 1}`}
                  onChange={(on) => setProbe(probe.id, { enabled: on ? undefined : false })}
                />
                <button
                  type="button"
                  className="w3-ar-iconbtn"
                  data-armed={arm.armed === probe.id ? '' : undefined}
                  title={arm.armed === probe.id ? 'Click again to delete' : 'Delete this cue'}
                  onClick={() =>
                    arm.press(probe.id, () =>
                      onSettingsChange({ probes: probes.filter((p) => p.id !== probe.id) }),
                    )
                  }
                >
                  <Icon name={arm.armed === probe.id ? 'trash' : 'close'} size="xs" />
                </button>
              </div>
            ))}
            <form
              className="w3-ar-cuerow w3-ar-cuerow--add"
              onSubmit={(event) => {
                event.preventDefault();
                if (!newCue.trim()) return;
                onSettingsChange({
                  probes: [...probes, { id: crypto.randomUUID(), text: newCue.trim() }],
                });
                setNewCue('');
              }}
            >
              <span className="w3-ar-cuerow__n">
                <Icon name="plus" size="xs" />
              </span>
              <input
                value={newCue}
                placeholder="Add a cue. Macros like {{char}} work."
                aria-label="New cue"
                onChange={(event) => setNewCue(event.target.value)}
              />
              <button
                type="submit"
                className="w3-st-ghost w3-st-ghost--sm"
                disabled={!newCue.trim()}
              >
                Add
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}

/** One setting as a pill showing its value; a click lists the choices. */
function Choice({
  label,
  value,
  options,
  current,
  onPick,
}: {
  label: string;
  value: string;
  options: { id: string; name: string }[];
  current: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const list = options.filter((o) => o.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Popover
      label={label}
      icon={null}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
      placement="bottom-start"
      role="dialog"
      popupClassName="w3-ar-cardpop"
      renderTrigger={(trigger) => (
        <button
          {...trigger}
          type="button"
          className="w3-ar-setopt"
          onClick={() => setOpen((o) => !o)}
        >
          <small>{label}</small>
          <b>{value}</b>
          <Icon name="chevronDown" size="xs" />
        </button>
      )}
    >
      <div className="w3-ar-cardpop__body">
        {options.length > 8 ? (
          <input
            value={query}
            placeholder={`Find a ${label.toLowerCase()}`}
            aria-label={`Find a ${label.toLowerCase()}`}
            // biome-ignore lint/a11y/noAutofocus: opened to type into
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
        <div className="w3-ar-cardpop__list">
          {list.map((o) => (
            <button
              key={o.id || 'none'}
              type="button"
              aria-pressed={o.id === current}
              onClick={() => {
                onPick(o.id);
                setOpen(false);
              }}
            >
              {o.name}
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
}
