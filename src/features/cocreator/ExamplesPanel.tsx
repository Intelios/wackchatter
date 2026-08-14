import type { CharacterSummary } from '@shared/types/card.ts';
import type { ExampleField, ExampleSelection, ExampleSet } from '@shared/types/cocreator.ts';
import { useMemo, useState } from 'react';
import { Popover } from '../../components/Popover.tsx';
import { PlusIcon, TrashIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { ExampleSetsPopover } from './ExampleSetsPopover.tsx';
import { EXAMPLE_FIELD_LABELS, EXAMPLE_FIELD_ORDER, EXAMPLE_TOKEN_WARNING } from './examples.ts';
import type { LoadedExamples } from './useExampleCards.ts';

interface ExamplesPanelProps {
  selection: ExampleSelection;
  loaded: LoadedExamples;
  characters: readonly CharacterSummary[];
  exampleSets: readonly ExampleSet[];
  busy: boolean;
  /** True once the analysis request is already in the transcript. */
  analysed: boolean;
  onAdd: (avatar: string) => void;
  onRemove: (avatar: string) => void;
  onSetField: (field: ExampleField, on: boolean) => void;
  onApplySet: (set: ExampleSet) => void;
  onExampleSetsChange: (sets: ExampleSet[]) => void;
  onAnalyse: () => void;
}

/**
 * The cards being used as few-shot examples.
 *
 * The Co-Creator's one real advantage over designing a card in a general chat app: the
 * examples are cards the user already chose to keep, so "write it like these" is concrete
 * rather than an adjective.
 */
export function ExamplesPanel({
  selection,
  loaded,
  characters,
  exampleSets,
  busy,
  analysed,
  onAdd,
  onRemove,
  onSetField,
  onApplySet,
  onExampleSetsChange,
  onAnalyse,
}: ExamplesPanelProps) {
  const [picking, setPicking] = useState(false);
  const [setsOpen, setSetsOpen] = useState(false);
  const [query, setQuery] = useState('');

  const available = useMemo(() => {
    const attached = new Set(selection.cards);
    const needle = query.trim().toLowerCase();
    return characters
      .filter((character) => !attached.has(character.avatar))
      .filter((character) => !needle || character.name.toLowerCase().includes(needle))
      .slice(0, 60);
  }, [characters, selection.cards, query]);

  const byAvatar = useMemo(() => {
    const map = new Map<string, CharacterSummary>();
    for (const character of characters) map.set(character.avatar, character);
    return map;
  }, [characters]);

  const heavy = loaded.tokens > EXAMPLE_TOKEN_WARNING;

  return (
    <aside className="examples-panel" aria-label="Example cards">
      <header className="examples-panel__header">
        <h2>Examples</h2>
        <span className="examples-panel__count" data-warn={heavy || undefined}>
          {selection.cards.length === 0 ? 'none' : `${loaded.tokens} tok`}
        </span>
        <div className="examples-panel__actions">
          <ExampleSetsPopover
            sets={exampleSets}
            currentCards={selection.cards}
            currentFields={selection.fields}
            characters={characters}
            open={setsOpen}
            onOpenChange={setSetsOpen}
            onApplySet={onApplySet}
            onSetsChange={onExampleSetsChange}
            disabled={busy}
          />
          <Popover
            open={picking}
            onOpenChange={setPicking}
            label="Attach an example card"
            placement="bottom-start"
            role="dialog"
            icon={<PlusIcon />}
            className="examples-panel__attach"
            popupClassName="examples-picker__popup"
          >
            <div className="examples-picker">
              <input
                type="search"
                className="wc-input"
                value={query}
                placeholder="Search your cards…"
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="examples-picker__list">
                {available.length === 0 ? (
                  <p className="wc-empty">No other cards match.</p>
                ) : (
                  available.map((character) => (
                    <button
                      key={character.avatar}
                      type="button"
                      className="examples-picker__item"
                      onClick={() => {
                        onAdd(character.avatar);
                        setPicking(false);
                      }}
                    >
                      <img
                        src={characterApi.imageUrl(character.avatar, character.modified)}
                        alt=""
                      />
                      <span>{character.name}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </Popover>
        </div>
      </header>

      <div className="examples-panel__body">
        {selection.cards.length === 0 ? (
          <p className="wc-empty examples-panel__empty">
            Attach cards you like. The assistant studies how they are written, not what they say.
          </p>
        ) : null}

        {selection.cards.map((avatar) => {
          const summary = byAvatar.get(avatar);
          const rendered = loaded.examples.find((example) => example.avatar === avatar);
          const gone = loaded.missing.includes(avatar);
          return (
            <div key={avatar} className="examples-card" data-missing={gone || undefined}>
              <img src={characterApi.imageUrl(avatar, summary?.modified)} alt="" />
              <span className="examples-card__info">
                <span className="examples-card__name">{summary?.name ?? avatar}</span>
                <span className="examples-card__tokens">
                  {gone ? 'no longer in your library' : rendered ? `${rendered.tokens} tok` : '…'}
                </span>
              </span>
              <button
                type="button"
                className="wc-button wc-button--ghost wc-button--danger"
                onClick={() => onRemove(avatar)}
                disabled={busy}
                aria-label={`Detach ${summary?.name ?? avatar}`}
                title="Detach this example"
              >
                <TrashIcon />
              </button>
            </div>
          );
        })}

        {heavy ? (
          <p className="examples-panel__warning" role="status">
            Past about {EXAMPLE_TOKEN_WARNING.toLocaleString()} tokens of examples, models tend to
            copy an example's specifics rather than its register. Detach one, or turn off a field
            below.
          </p>
        ) : null}

        {selection.cards.length > 0 ? (
          <div className="examples-panel__fields">
            <span className="examples-panel__fields-label">Include per example</span>
            {EXAMPLE_FIELD_ORDER.map((field) => (
              <label key={field} className="examples-panel__field">
                <input
                  type="checkbox"
                  checked={selection.fields[field]}
                  disabled={busy}
                  onChange={(event) => onSetField(field, event.target.checked)}
                />
                {EXAMPLE_FIELD_LABELS[field]}
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <footer className="examples-panel__footer">
        {/*
         * Not a hidden prompt path: this appends a visible user turn and runs an ordinary
         * generation, so the answer sits in the transcript where the user can check it names
         * every card — which is the whole point of the button.
         */}
        <button
          type="button"
          className="wc-button"
          onClick={onAnalyse}
          disabled={busy || selection.cards.length === 0}
          title={
            selection.cards.length === 0
              ? 'Attach an example first'
              : analysed
                ? 'Ask again — useful after changing the examples'
                : 'Ask the assistant to list what it can see and what it will carry over'
          }
        >
          {analysed ? 'Analyse again' : 'Analyse examples'}
        </button>
      </footer>
    </aside>
  );
}
