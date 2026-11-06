/**
 * The Personas tool: who you are, then everyone else.
 *
 * The card at the top is the persona you're writing as, with its variants as tabs. The
 * rest are rows below it, most recently used first; clicking one makes it the card (and,
 * with a chat open, switches that chat too). A persona is edited on its own page, which
 * keeps the list's room; that page and the from-a-character page are the controller's
 * `personaPage`, because the margin's heading names what is open.
 */

import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { ResolvedModel } from '@shared/providers/types.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { MacroVariableMap, Persona } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import type { DialogueColorOverride, DialogueColorSettings } from '@shared/types/settings.ts';
import type { LorebookSummary } from '@shared/types/worldinfo.ts';
import { useState } from 'react';
import type { PersonaPage } from '../app/useAppController.ts';
import { Menu } from '../components/Menu.tsx';
import { Select } from '../components/Select.tsx';
import { useAvatarColor } from '../features/chat/avatarColor.ts';
import { PersonaConverter } from '../features/persona/PersonaConverter.tsx';
import { personaDisplayName } from '../features/persona/personaRoster.ts';
import { usePersonaWorkbench } from '../features/persona/usePersonaWorkbench.ts';
import { personaApi } from '../lib/api.ts';
import type { PersistenceControls } from '../lib/autosave.ts';
import { ColourSwatches, useHeld } from './CharacterSheet.tsx';
import { Icon } from './icons.tsx';
import {
  depthChoices,
  type PersonaPosition,
  type PersonaRole,
  POSITION_WORDS,
  personaRoster,
  placementShort,
  ROLE_WORDS,
} from './personas.ts';
import './personas.css';
import './sheet.css';

export interface PersonaToolProps {
  page: PersonaPage | null;
  setPage: (page: PersonaPage | null) => void;
  personas: Persona[];
  books: LorebookSummary[];
  characters: CharacterSummary[];
  hiddenTags: readonly string[];
  connection: ResolvedModel | null;
  preset: Preset | null;
  globalVariables: MacroVariableMap;
  activeId: string | null;
  recentIds: readonly string[];
  countTokens: TokenCounter;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  registerPersistence?: (controls: PersistenceControls | null) => void;
  dialogueColors: DialogueColorSettings;
  avatarVersions: Readonly<Record<string, number>>;
  onDialogueColorChange: (id: string, value: DialogueColorOverride | undefined) => void;
  onAvatarChanged: (id: string) => void;
  onDeleted: (id: string) => void;
}

/** `{{user}}` read as the persona's name, for showing a description outside a prompt. */
function readable(persona: Persona): string {
  return persona.description.replace(/\{\{user\}\}/gi, persona.name);
}

export function PersonaTool(props: PersonaToolProps) {
  const {
    page,
    setPage,
    personas,
    books,
    characters,
    activeId,
    recentIds,
    countTokens,
    onSelect,
    avatarVersions,
  } = props;
  const [query, setQuery] = useState('');
  const bench = usePersonaWorkbench({
    personas,
    activeId,
    editing: page?.kind === 'edit' ? page.id : null,
    setEditing: (id) => setPage(id ? { kind: 'edit', id } : null),
    onSelect,
    onChanged: props.onChanged,
    registerPersistence: props.registerPersistence,
    onAvatarChanged: props.onAvatarChanged,
    onDeleted: props.onDeleted,
  });

  const avatarUrl = (persona: Persona) =>
    persona.avatar
      ? personaApi.avatarUrl(persona.id, avatarVersions[persona.id] ?? persona.avatar)
      : null;

  /** Why making a persona from a card cannot start right now, or null. */
  const convertBlocked =
    characters.length === 0
      ? 'No characters in your library yet.'
      : !props.connection
        ? 'Choose a chat model in Connections first.'
        : !props.preset
          ? 'Still loading your preset.'
          : null;

  const errorLine = bench.error ? (
    <p className="w3-persona__error" role="alert">
      {bench.error}
      {page?.kind === 'edit' ? (
        <button type="button" onClick={bench.retry}>
          Retry save
        </button>
      ) : null}
    </p>
  ) : null;

  if (page?.kind === 'from') {
    return (
      <div className="w3-persona w3-persona--from">
        {errorLine}
        <PersonaConverter
          characters={characters}
          hiddenTags={props.hiddenTags}
          connection={props.connection}
          preset={props.preset}
          globalVariables={props.globalVariables}
          countTokens={countTokens}
          onClose={() => setPage(null)}
          onSaved={(id) => void bench.converted(id)}
        />
      </div>
    );
  }

  if (page?.kind === 'edit') {
    return (
      <div className="w3-persona">
        {errorLine}
        {bench.draft ? (
          <PersonaEditor
            key={bench.draft.id}
            draft={bench.draft}
            bench={bench}
            personas={personas}
            books={books}
            activeId={activeId}
            onSelect={onSelect}
            countTokens={countTokens}
            avatarUrl={avatarUrl}
            dialogueColors={props.dialogueColors}
            onDialogueColorChange={props.onDialogueColorChange}
          />
        ) : (
          <>
            <button
              type="button"
              className="w3-sheet__back"
              onClick={() => void bench.selectEditor(null)}
            >
              <Icon name="chevronLeft" size="sm" />
              All personas
            </button>
            <p className="w3-sheet__hint">
              {personas.some((persona) => persona.id === page.id)
                ? 'Loading…'
                : 'This persona is no longer in your library.'}
            </p>
          </>
        )}
      </div>
    );
  }

  const roster = personaRoster(personas, activeId, recentIds, query);
  const { you, tabs } = roster;
  const yourBook = you?.lorebookId
    ? (books.find((book) => book.id === you.lorebookId)?.name ?? 'missing')
    : null;

  return (
    <div className="w3-persona">
      {errorLine}
      <div className="w3-persona__tools">
        <label className="w3-persona__search">
          <Icon name="search" size="sm" />
          <input
            type="search"
            value={query}
            placeholder={`Search ${personas.length} personas`}
            aria-label="Search personas"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Menu
          label="New persona"
          showLabel
          icon={<Icon name="plus" size="sm" />}
          className="w3-persona__new"
          popupClassName="w3-persona__newmenu"
          placement="bottom-end"
          entries={[
            {
              label: 'Blank',
              description: 'A name, a picture and a description you write',
              icon: <Icon name="persona" size="sm" />,
              onSelect: () => void bench.create(),
            },
            {
              label: 'From a character',
              description: 'Pick a card and the chat model drafts a persona from it',
              icon: <Icon name="sparkles" size="sm" />,
              disabled: Boolean(convertBlocked),
              disabledReason: convertBlocked ?? undefined,
              onSelect: () => setPage({ kind: 'from' }),
            },
          ]}
        />
      </div>

      {you ? (
        <section className="w3-you" key={you.id} aria-label="Writing as">
          <PersonaFace persona={you} url={avatarUrl(you)} className="w3-you__face" />
          <div className="w3-you__text">
            <span className="w3-you__kicker">Writing as</span>
            <div className="w3-you__name">
              <h3>{you.name}</h3>
              {!tabs.length && you.variantLabel ? <span>{you.variantLabel}</span> : null}
            </div>
            {tabs.length ? (
              <div className="w3-you__tabs">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    aria-pressed={tab.id === you.id}
                    onClick={() => onSelect(tab.id)}
                    title={`Write as ${personaDisplayName(tab)}`}
                  >
                    {tab.variantOf ? (tab.variantLabel ?? 'Unlabelled') : 'Base'}
                  </button>
                ))}
                <button
                  type="button"
                  className="w3-you__add"
                  onClick={() => void bench.addVariant(tabs[0]!.id)}
                  title="Add a variant"
                  aria-label="Add a variant"
                >
                  <Icon name="plus" size="xs" />
                </button>
              </div>
            ) : null}
            <p className="w3-you__desc">{readable(you).trim() || 'No description yet.'}</p>
            <span className="w3-you__facts">
              {countTokens.countText(you.description)} tokens · {placementShort(you)}
              {yourBook ? ` · Lorebook: ${yourBook}` : ''}
            </span>
          </div>
          <div className="w3-you__actions">
            <button
              type="button"
              onClick={() => void bench.selectEditor(you.id)}
              title={`Edit ${personaDisplayName(you)}`}
            >
              <Icon name="pencil" size="xs" />
              Edit
            </button>
            <button
              type="button"
              onClick={() => onSelect(null)}
              title="Write as no persona"
              aria-label="Write as no persona"
            >
              <Icon name="close" size="xs" />
            </button>
          </div>
        </section>
      ) : (
        <section className="w3-you" data-none aria-label="Writing as">
          <span className="w3-you__face w3-pface">
            <Icon name="persona" />
          </span>
          <div className="w3-you__text">
            <span className="w3-you__kicker">Writing as</span>
            <div className="w3-you__name">
              <h3>No persona</h3>
            </div>
            <p className="w3-you__desc">
              Your messages go out as “User”, with no description in the prompt. Pick someone below
              to write as them.
            </p>
          </div>
        </section>
      )}

      <h3 className="w3-sheet__label">{query.trim() ? 'Matches' : 'Everyone else'}</h3>
      {roster.others.length ? (
        <div className="w3-prows">
          {roster.others.map(({ persona, variants }) => (
            <div className="w3-prow" key={persona.id}>
              <button
                type="button"
                className="w3-prow__pick"
                onClick={() => onSelect(persona.id)}
                title={`Write as ${personaDisplayName(persona)}`}
              >
                <PersonaFace persona={persona} url={avatarUrl(persona)} className="w3-prow__face" />
                <span className="w3-prow__text">
                  <b>
                    {persona.name}
                    {persona.variantLabel ? <small>{persona.variantLabel}</small> : null}
                  </b>
                  <span>{readable(persona).trim() || 'No description'}</span>
                </span>
                {variants ? (
                  <span className="w3-prow__count">
                    {variants} {variants === 1 ? 'variant' : 'variants'}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="w3-prow__edit"
                onClick={() => void bench.selectEditor(persona.id)}
                title={`Edit ${personaDisplayName(persona)}`}
                aria-label={`Edit ${personaDisplayName(persona)}`}
              >
                <Icon name="pencil" size="sm" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="w3-sheet__hint">
          {query.trim()
            ? `No persona matches “${query.trim()}”.`
            : personas.length
              ? 'No one else yet.'
              : 'No personas yet. Make one with New persona.'}
        </p>
      )}
    </div>
  );
}

function PersonaFace({
  persona,
  url,
  className,
}: {
  persona: Persona;
  url: string | null;
  className: string;
}) {
  return (
    <span className={`${className} w3-pface`}>
      {url ? (
        <img src={url} alt="" loading="lazy" />
      ) : (
        <span aria-hidden="true">{persona.name.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}

type Bench = ReturnType<typeof usePersonaWorkbench>;

function PersonaEditor({
  draft,
  bench,
  personas,
  books,
  activeId,
  onSelect,
  countTokens,
  avatarUrl,
  dialogueColors,
  onDialogueColorChange,
}: {
  draft: Persona;
  bench: Bench;
  personas: Persona[];
  books: LorebookSummary[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  countTokens: TokenCounter;
  avatarUrl: (persona: Persona) => string | null;
  dialogueColors: DialogueColorSettings;
  onDialogueColorChange: (id: string, value: DialogueColorOverride | undefined) => void;
}) {
  const { patch } = bench;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const url = avatarUrl(draft);
  const [colour, holdColour] = useHeld(dialogueColors.personas[draft.id]);
  const autoColour = useAvatarColor(colour === undefined ? url : null);

  // The group this persona belongs to: its base first, then the variants.
  const baseId = draft.variantOf ?? draft.id;
  const base = personas.find((persona) => persona.id === baseId) ?? null;
  const group = base
    ? [base, ...personas.filter((persona) => persona.variantOf === base.id)]
    : [draft];
  const variantCount = group.length - 1;

  const position: PersonaPosition = draft.position ?? 'inPrompt';
  const missingBook = Boolean(
    draft.lorebookId && !books.some((book) => book.id === draft.lorebookId),
  );

  const word = <T,>(
    label: string,
    value: T,
    options: readonly { value: T; label: string }[],
    onChange: (value: T) => void,
  ) => (
    <Select
      className="w3-word"
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      searchable={false}
    />
  );

  return (
    <div className="w3-pedit">
      <button
        type="button"
        className="w3-sheet__back"
        onClick={() => void bench.selectEditor(null)}
      >
        <Icon name="chevronLeft" size="sm" />
        All personas
      </button>

      <div className="w3-pedit__ident">
        <label
          className="w3-pedit__portrait"
          title={draft.avatar ? 'Replace the picture' : 'Add a picture'}
        >
          <PersonaFace persona={draft} url={url} className="w3-pedit__face" />
          <span className="w3-pedit__replace">{draft.avatar ? 'Replace' : 'Upload'}</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void bench.uploadAvatar(draft.id, file);
              event.target.value = '';
            }}
          />
        </label>
        <div className="w3-pedit__fields">
          <input
            ref={bench.nameRef}
            className="w3-pedit__input w3-pedit__input--name"
            value={draft.name}
            aria-label="Name"
            title="What {{user}} becomes, and the name on your messages"
            onChange={(event) => patch({ name: event.target.value })}
          />
          <div className="w3-pedit__row">
            {draft.variantOf ? (
              <input
                ref={bench.labelRef}
                className="w3-pedit__input w3-pedit__input--label"
                value={draft.variantLabel ?? ''}
                placeholder="Variant label"
                aria-label="Variant label"
                title="How lists tell this variant apart. Never sent to the model."
                onChange={(event) =>
                  patch({ variantLabel: event.target.value.trim() ? event.target.value : null })
                }
              />
            ) : null}
            {activeId === draft.id ? (
              <span className="w3-pedit__using">Writing as this</span>
            ) : (
              <button type="button" className="w3-pedit__use" onClick={() => onSelect(draft.id)}>
                Write as this
              </button>
            )}
          </div>
        </div>
      </div>

      <section className="w3-pedit__group">
        <h3 className="w3-sheet__label">Description</h3>
        <textarea
          className="w3-pedit__desc"
          value={draft.description}
          placeholder="Who you are in the story."
          aria-label="Description"
          onChange={(event) => patch({ description: event.target.value })}
        />
        <div className="w3-pedit__under">
          <span>
            <b>{'{{user}}'}</b> becomes {draft.name || 'this name'}
          </span>
          <span>{countTokens.countText(draft.description)} tokens</span>
        </div>
      </section>

      <section className="w3-pedit__group">
        <h3 className="w3-sheet__label">Dialogue colour</h3>
        <ColourSwatches
          value={colour}
          autoColor={autoColour}
          onChange={(value) => {
            holdColour(value);
            onDialogueColorChange(draft.id, value);
          }}
        />
        {dialogueColors.enabled ? null : (
          <p className="w3-sheet__hint">Dialogue colours are switched off in Settings.</p>
        )}
      </section>

      <section className="w3-pedit__group">
        <h3 className="w3-sheet__label">In the prompt</h3>
        <p className="w3-pedit__sentence">
          Sent{' '}
          {word('Where the description goes', position, POSITION_WORDS, (next: PersonaPosition) =>
            patch({ position: next }),
          )}
          {position === 'atDepth' ? (
            <>
              {' '}
              as a{' '}
              {word('Role', draft.role ?? 'system', ROLE_WORDS, (role: PersonaRole) =>
                patch({ role }),
              )}{' '}
              message,{' '}
              {word('Depth', draft.depth ?? 2, depthChoices(draft.depth ?? 2), (depth: number) =>
                patch({ depth }),
              )}
              .
            </>
          ) : position === 'none' ? (
            <>. Only {'{{persona}}'} reads it.</>
          ) : (
            '.'
          )}
        </p>
      </section>

      <section className="w3-pedit__group">
        <h3 className="w3-sheet__label">Lorebook</h3>
        <Select
          className="w3-pedit__select"
          label="Persona lorebook"
          value={draft.lorebookId ?? ''}
          options={[
            { label: 'None', value: '' },
            ...books.map((book) => ({ label: book.name, value: book.id })),
            ...(missingBook
              ? [{ label: `Missing: ${draft.lorebookId}`, value: draft.lorebookId! }]
              : []),
          ]}
          onChange={(lorebookId) => patch({ lorebookId: lorebookId || null })}
        />
        <p className="w3-sheet__hint">
          {missingBook
            ? 'That lorebook is gone. Replies carry on without it.'
            : 'Loaded ahead of character and global lore whenever this persona is in use.'}
        </p>
      </section>

      <section className="w3-pedit__group">
        <h3 className="w3-sheet__label">Variants</h3>
        {variantCount ? (
          <div className="w3-pedit__variants">
            {group.map((persona) => (
              <button
                key={persona.id}
                type="button"
                aria-current={persona.id === draft.id || undefined}
                onClick={() => void bench.selectEditor(persona.id)}
                title={`Edit ${personaDisplayName(persona)}`}
              >
                <PersonaFace
                  persona={persona}
                  url={avatarUrl(persona)}
                  className="w3-pedit__vface"
                />
                <b>{persona.variantOf ? (persona.variantLabel ?? 'Unlabelled') : 'Base'}</b>
                <span className="w3-pedit__vdesc">
                  {readable(persona).trim() || 'No description'}
                </span>
                {persona.id === draft.id ? <i>Editing</i> : null}
              </button>
            ))}
          </div>
        ) : (
          <p className="w3-sheet__hint">
            The same you in another setting: a variant keeps the name and changes the rest.
          </p>
        )}
        <div className="w3-pedit__buttons">
          <button
            type="button"
            className="w3-pedit__ghost"
            onClick={() => void bench.addVariant(base?.id ?? draft.id)}
          >
            <Icon name="plus" size="xs" />
            Add a variant
          </button>
          {draft.variantOf ? (
            <button
              type="button"
              className="w3-pedit__ghost"
              data-armed={confirmUnlink || undefined}
              onClick={() => {
                if (!confirmUnlink) return setConfirmUnlink(true);
                setConfirmUnlink(false);
                patch({ variantOf: null });
              }}
              onBlur={() => setConfirmUnlink(false)}
              title="This variant becomes a persona of its own"
            >
              {confirmUnlink ? 'Click again to unlink' : 'Make it its own persona'}
            </button>
          ) : null}
        </div>
      </section>

      <div className="w3-pedit__end">
        <button
          type="button"
          className="w3-pedit__ghost w3-pedit__delete"
          data-armed={confirmDelete || undefined}
          onClick={() => (confirmDelete ? void bench.remove(draft.id) : setConfirmDelete(true))}
          onBlur={() => setConfirmDelete(false)}
          title={
            confirmDelete && !draft.variantOf && variantCount
              ? `Its ${variantCount} ${variantCount === 1 ? 'variant becomes a persona' : 'variants become personas'} of their own`
              : undefined
          }
        >
          <Icon name="trash" size="xs" />
          {confirmDelete ? 'Click again to delete' : 'Delete persona'}
        </button>
      </div>
    </div>
  );
}
