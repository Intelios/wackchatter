/**
 * Character → Persona: boiling a card down to the ~100-token identity blurb you play as.
 *
 * Takes over the persona panel in two steps — pick a card, then edit the draft — the way the
 * persona editor already takes it over, rather than appending below the roster.
 *
 * **Nothing reaches disk until Save.** A failed roll, a cancelled roll or a back button
 * leaves no persona behind, which is what makes it safe to hand a model the pen at all.
 */

import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { MacroVariableMap } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TextField } from '../../components/Field.tsx';
import { SearchIcon } from '../../layout/icons.tsx';
import { characterApi, personaApi } from '../../lib/api.ts';
import { fetchPngFile } from '../../lib/imageFile.ts';
import { matchesQuery, visibleTagsOf } from '../character/characterTree.ts';
import './PersonaConverter.css';
import { appendTake, editTake, stepTake, type Take } from './takes.ts';
import { usePersonaDerive } from './usePersonaDerive.ts';

/** A real library is hundreds of cards; the list is a means of finding one, not of browsing. */
const MAX_PICKER_ROWS = 60;
/** Above this the description is costing more than a persona should, every single request. */
const LONG_DESCRIPTION_TOKENS = 200;

interface PersonaConverterProps {
  characters: CharacterSummary[];
  hiddenTags: readonly string[];
  connection: Connection | null;
  preset: Preset | null;
  globalVariables: MacroVariableMap;
  countTokens: TokenCounter;
  /** Leave the converter without saving. */
  onClose: () => void;
  /** A persona was created — refresh the roster and open it in the editor. */
  onSaved: (id: string) => void;
}

export function PersonaConverter({
  characters,
  hiddenTags,
  connection,
  preset,
  globalVariables,
  countTokens,
  onClose,
  onSaved,
}: PersonaConverterProps) {
  const [card, setCard] = useState<CharacterSummary | null>(null);
  const [query, setQuery] = useState('');
  const [takes, setTakes] = useState<Take[]>([]);
  const [index, setIndex] = useState(0);
  const [confirmChange, setConfirmChange] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * The persona created by a Save whose later steps failed.
   *
   * Without it a retry would mint a second persona and leave the first one named but empty.
   * `finishSession` has the same exposure and accepts it; here it costs one ref.
   */
  const savedId = useRef<string | null>(null);

  const { status, derive, cancel, reset } = usePersonaDerive({
    connection,
    preset,
    globalVariables,
  });

  const take = takes[index] ?? null;
  const descriptionTokens = take ? countTokens.countText(take.description) : 0;

  const roll = useCallback(
    async (character: CharacterSummary) => {
      const result = await derive(character);
      if (!result) return;
      setTakes((current) => {
        const next = appendTake(current, { ...result, dirty: false });
        setIndex(next.index);
        return next.takes;
      });
    },
    [derive],
  );

  const pick = useCallback(
    (character: CharacterSummary) => {
      // Advancing and rolling are one action: a separate Convert click would be a button
      // that only ever gets pressed once.
      setCard(character);
      setTakes([]);
      setIndex(0);
      setSaveError(null);
      savedId.current = null;
      reset();
      void roll(character);
    },
    [reset, roll],
  );

  const changeCard = useCallback(() => {
    cancel();
    reset();
    setCard(null);
    setTakes([]);
    setIndex(0);
    setConfirmChange(false);
    setSaveError(null);
    savedId.current = null;
  }, [cancel, reset]);

  const patch = useCallback(
    (fields: Partial<Take>) => setTakes((current) => editTake(current, index, fields)),
    [index],
  );

  async function save() {
    if (!take || !card || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const name = take.name.trim() || card.name;
      if (!savedId.current) savedId.current = (await personaApi.create(name)).id;
      const id = savedId.current;
      await personaApi.save(id, { name, description: take.description.trim() });

      // Best effort, and never allowed to fail the save. The file is named avatar.png
      // because the endpoint checks the extension before the bytes; the PNG carries the
      // source card's `chara`/`ccv3` tEXt chunks along with it, which is inert — nothing
      // ever reads a persona avatar as a card.
      const art = await fetchPngFile(characterApi.imageUrl(card.avatar, card.modified));
      if (art) await personaApi.uploadAvatar(id, art).catch(() => {});

      onSaved(id);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save the persona.');
    } finally {
      setSaving(false);
    }
  }

  if (!card) {
    return (
      <PickerStep
        characters={characters}
        hiddenTags={hiddenTags}
        query={query}
        onQuery={setQuery}
        onPick={pick}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="persona-convert">
      <div className="persona-convert__top">
        <button type="button" className="wc-button wc-button--ghost" onClick={onClose}>
          ← All personas
        </button>
        <span className="persona-convert__spacer" />
        {/* Two-click confirm in place, per the no-modals rule — same idiom as the editor's
            delete button, including the blur reset. */}
        <button
          type="button"
          className="wc-button wc-button--ghost"
          onClick={() => {
            if (!take?.dirty || confirmChange) changeCard();
            else setConfirmChange(true);
          }}
          onBlur={() => setConfirmChange(false)}
          title={confirmChange ? 'Click again to discard this draft' : 'Pick a different card'}
        >
          {confirmChange ? 'Discard draft?' : 'Change card'}
        </button>
      </div>

      <div className="persona-convert__source">
        <span className="persona-convert__face">
          <img src={characterApi.imageUrl(card.avatar, card.modified)} alt="" loading="lazy" />
        </span>
        <span className="persona-convert__source-text">
          <span className="persona-convert__source-name">{card.name}</span>
          <span className="persona-convert__source-hint">
            Only what the card actually states — anything it leaves out is left blank.
          </span>
        </span>
      </div>

      {status.running ? (
        <div className="persona-convert__status" role="status">
          <span>
            Reading {card.name}’s card
            {connection?.name ? ` with ${connection.name}` : ''}…
          </span>
          <button type="button" className="wc-button wc-button--ghost" onClick={cancel}>
            Cancel
          </button>
        </div>
      ) : null}

      {status.error ? (
        <div className="persona-convert__error" role="alert">
          <span>{status.error}</span>
          <button type="button" className="wc-button" onClick={() => void roll(card)}>
            Try again
          </button>
        </div>
      ) : null}

      {/* Cancelling leaves a chosen card and no draft. Without this the only way forward
          would be Change card and re-picking the card you already picked. */}
      {!status.running && !status.error && !take ? (
        <div className="persona-convert__draft">
          <button type="button" className="wc-button" onClick={() => void roll(card)}>
            Convert {card.name}
          </button>
        </div>
      ) : null}

      {take ? (
        <div className="persona-convert__draft">
          {takes.length > 1 ? (
            <div className="persona-convert__takes">
              <button
                type="button"
                className="wc-button wc-button--ghost"
                disabled={index === 0}
                onClick={() => setIndex(stepTake(takes, index, -1))}
                aria-label="Previous take"
              >
                ‹
              </button>
              <span>
                Take {index + 1} of {takes.length}
              </span>
              <button
                type="button"
                className="wc-button wc-button--ghost"
                disabled={index === takes.length - 1}
                onClick={() => setIndex(stepTake(takes, index, 1))}
                aria-label="Next take"
              >
                ›
              </button>
            </div>
          ) : null}

          <TextField
            label="Name"
            value={take.name}
            onChange={(name) => patch({ name })}
            hint="What {{user}} expands to, and the label on your messages."
          />

          <TextField
            label="Description"
            value={take.description}
            onChange={(description) => patch({ description })}
            multiline
            expandable
            rows={8}
            hint="Available as {{persona}} wherever it is positioned."
            meta={`${descriptionTokens} tokens`}
          />

          {descriptionTokens > LONG_DESCRIPTION_TOKENS ? (
            <p className="wc-hint">
              Longer than a persona usually needs — this rides in every request. Trimming a line or
              two is worth it.
            </p>
          ) : null}

          {saveError ? (
            <p className="persona-convert__error" role="alert">
              {saveError}
            </p>
          ) : null}

          <div className="persona-convert__actions">
            <button
              type="button"
              className="wc-button wc-button--primary"
              disabled={saving || status.running || !take.description.trim()}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save as persona'}
            </button>
            <button
              type="button"
              className="wc-button"
              disabled={saving || status.running}
              onClick={() => void roll(card)}
              title="Ask again — this keeps the take you have"
            >
              Re-roll
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface PickerStepProps {
  characters: CharacterSummary[];
  hiddenTags: readonly string[];
  query: string;
  onQuery: (query: string) => void;
  onPick: (character: CharacterSummary) => void;
  onClose: () => void;
}

/**
 * A searchable row list, not a popover.
 *
 * The Arena's medallion picker is not reused: its every class name is `arena-*` with the
 * styles in `ArenaShell.css`, its trigger hardcodes a VS badge and Arena wording, and it does
 * not honour `hiddenTags`. The part that could meaningfully drift — what matches a query,
 * which tags are visible — is `characterTree.ts`, and that *is* shared.
 */
function PickerStep({ characters, hiddenTags, query, onQuery, onPick, onClose }: PickerStepProps) {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  const matches = characters.filter((character) => matchesQuery(character, query));
  const shown = matches.slice(0, MAX_PICKER_ROWS);

  return (
    <div className="persona-convert">
      <div className="persona-convert__top">
        <button type="button" className="wc-button wc-button--ghost" onClick={onClose}>
          ← All personas
        </button>
      </div>

      <p className="persona-convert__lede">
        Pick a character to become. Their name, age and appearance are boiled down into a persona
        you can write as — nothing the card does not say gets invented.
      </p>

      <label className="persona-roster__search">
        <SearchIcon />
        <input
          ref={searchRef}
          type="search"
          className="persona-roster__query"
          value={query}
          placeholder={`Search ${characters.length} characters…`}
          aria-label="Search characters"
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>

      {matches.length === 0 ? (
        <div className="wc-empty">
          <span>
            {query.trim() ? `No character matches “${query.trim()}”.` : 'No characters yet.'}
          </span>
        </div>
      ) : (
        <div className="persona-convert__cards">
          {shown.map((character) => {
            const tags = visibleTagsOf(character.tags, hiddenTags);
            return (
              <button
                key={character.avatar}
                type="button"
                className="persona-convert__card"
                onClick={() => onPick(character)}
                title={`Make a persona from ${character.name}`}
              >
                <span className="persona-convert__face">
                  <img
                    src={characterApi.imageUrl(character.avatar, character.modified)}
                    alt=""
                    loading="lazy"
                  />
                </span>
                <span className="persona-convert__card-text">
                  <span className="persona-convert__card-name">{character.name}</span>
                  <span className="persona-convert__card-tags">
                    {tags.length ? tags.slice(0, 3).join(' · ') : 'No tags'}
                  </span>
                </span>
              </button>
            );
          })}
          {matches.length > shown.length ? (
            <p className="persona-convert__more">
              …and {matches.length - shown.length} more — search to narrow.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
