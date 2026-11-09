/**
 * The Studio's workbench for one card: the rail of its sections on the left, the section
 * you write in, and beside it what the card costs and anything that is really wrong.
 *
 * Every edit autosaves through `useCardDraft`, the card's one writer, and the card's own
 * lorebook saves through `useEmbeddedBook`, serialised with it. What changed since the
 * card was opened is worked out against the snapshot the Studio took on the way in, and
 * each change can be put back from the island.
 */

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { resolveGreetingMacros } from '@shared/prompt/greeting.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardDataV2, CharacterDetail } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import type {
  LorebookSummary,
  WorldInfoEntry,
  WorldInfoSettings,
} from '@shared/types/worldinfo.ts';
import { bookEntries, toWorldInfoBook } from '@shared/worldinfo/convert.ts';
import {
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Select } from '../components/Select.tsx';
import { useEmbeddedBook } from '../features/character/EmbeddedBook.tsx';
import { Markdown } from '../features/chat/Markdown.tsx';
import { cropToCardRatio } from '../features/studio/AvatarStudio.tsx';
import { useCardDraft } from '../features/studio/useCardDraft.ts';
import { characterApi } from '../lib/api.ts';
import type { PersistenceControls } from '../lib/autosave.ts';
import { Avatar } from './Avatar.tsx';
import { Icon } from './icons.tsx';
import { EntryEditor, EntryList } from './LoreTool.tsx';
import { ChipList, FieldHead, FoldingFields, LineInput, MacroText } from './StudioFields.tsx';
import {
  type CardChange,
  type CardCost,
  cardChanges,
  cardCost,
  type ExampleTurn,
  entryPatch,
  entryWhen,
  joinExamples,
  kTokens,
  moveItem,
  parseExamples,
  STUDIO_SECTIONS,
  type StudioProblem,
  type StudioSection,
  studioProblems,
} from './studio.ts';

/** The card as it was when the Studio opened it: what "changed" is measured against. */
export interface OpenedCard {
  data: CardDataV2;
  folder: string;
}

/** What the island shows of the workbench, and what it can ask the workbench to do. */
export interface BenchReport {
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  saveError: string | null;
  changes: CardChange[];
  section: StudioSection;
}

export interface BenchHandle {
  revert: (change: CardChange | 'all') => void;
  goTo: (section: StudioSection) => void;
}

const NO_MARKS = new Map();

export function StudioBench({
  detail,
  opened,
  folders,
  books,
  countTokens,
  loreSettings,
  preset,
  persona,
  personaUrl,
  handle,
  onReport,
  onSaved,
  onRenamed,
  onDeleted,
  onCoCreator,
  onExport,
  onDuplicate,
  registerPersistence,
}: {
  detail: CharacterDetail;
  opened: OpenedCard;
  folders: readonly string[];
  books: readonly LorebookSummary[];
  countTokens: TokenCounter;
  loreSettings: WorldInfoSettings;
  preset: Preset | null;
  persona: Persona | null;
  personaUrl: string | null;
  handle: MutableRefObject<BenchHandle | null>;
  onReport: (report: BenchReport) => void;
  onSaved: (detail: CharacterDetail) => void;
  onRenamed: (detail: CharacterDetail) => void;
  onDeleted: () => void;
  onCoCreator: (avatar: string) => void;
  onExport: (avatar: string, format: 'png' | 'json', flush: () => Promise<void>) => void;
  onDuplicate: (avatar: string, flush: () => Promise<void>) => void;
  registerPersistence: (controls: PersistenceControls | null) => void;
}) {
  const draft = useCardDraft({ detail, onSaved, onRenamed, onDeleted, registerPersistence });
  const [section, setSection] = useState<StudioSection>('identity');
  const canvasRef = useRef<HTMLElement>(null);

  const stored = useMemo(
    () =>
      draft.data.character_book ? bookEntries(toWorldInfoBook(draft.data.character_book)) : [],
    [draft.data.character_book],
  );
  const book = useEmbeddedBook({
    avatar: draft.avatar,
    entries: stored,
    onSaved: draft.handleBookSaved,
    onError: draft.reportError,
    serializeCardWrite: draft.serializeCardWrite,
    registerPersistence: draft.registerBookPersistence,
  });
  const entries = book.entries;
  const openedEntries = useMemo(
    () =>
      opened.data.character_book ? bookEntries(toWorldInfoBook(opened.data.character_book)) : [],
    [opened.data.character_book],
  );

  const cost = useMemo(
    () => cardCost(draft.data, entries, countTokens),
    [draft.data, entries, countTokens],
  );
  const problems = useMemo(() => studioProblems(draft.data, entries), [draft.data, entries]);
  const changes = useMemo(
    () =>
      cardChanges(
        { data: opened.data, folder: opened.folder, entries: openedEntries },
        { data: draft.data, folder: draft.folder, entries },
      ),
    [opened, openedEntries, draft.data, draft.folder, entries],
  );

  useEffect(() => {
    onReport({ saveState: draft.saveState, saveError: draft.saveError, changes, section });
  }, [onReport, draft.saveState, draft.saveError, changes, section]);

  const goTo = (next: StudioSection) => {
    setSection(next);
    canvasRef.current?.scrollTo({ top: 0 });
  };

  const revertOne = (change: CardChange) => {
    const target = change.target;
    switch (target.kind) {
      case 'name':
        return void draft.rename(opened.data.name);
      case 'folder':
        return void draft.moveToFolder(opened.folder);
      case 'entry': {
        const was = openedEntries.find((entry) => entry.uid === target.uid);
        if (was) book.updateEntry(target.uid, entryPatch(was));
        return;
      }
      case 'added-entry':
        return book.deleteEntry(target.uid);
      case 'field':
        if (target.key === 'world') {
          const world = opened.data.extensions.world;
          return draft.updateExtension('world', typeof world === 'string' && world ? world : null);
        }
        if (target.key === 'source') return draft.update('source', opened.data.source ?? []);
        return draft.update(target.key, opened.data[target.key]);
    }
  };
  handle.current = {
    goTo,
    revert: (change) => {
      if (change !== 'all') return revertOne(change);
      // The name last: a rename moves the card's file, and everything else lands first.
      const all = [...changes].sort(
        (a, b) => Number(a.target.kind === 'name') - Number(b.target.kind === 'name'),
      );
      for (const item of all) revertOne(item);
    },
  };

  const flush = () => draft.flush();
  const imageUrl = characterApi.imageUrl(draft.avatar, detail.modified);
  const tokens = (text: string | undefined) => (text?.trim() ? countTokens.countText(text) : 0);
  const textField = (
    key:
      | 'description'
      | 'personality'
      | 'scenario'
      | 'system_prompt'
      | 'post_history_instructions'
      | 'creator_notes',
    label: string,
    variant: 'prose' | 'text',
    autoFocus = false,
  ) => (
    <>
      <FieldHead
        label={label}
        tokens={key === 'creator_notes' ? undefined : tokens(draft.data[key])}
      />
      <MacroText
        label={label}
        value={draft.data[key]}
        variant={variant}
        autoFocus={autoFocus}
        onChange={(value) => draft.update(key, value)}
      />
    </>
  );

  let page: ReactNode;
  switch (section) {
    case 'identity':
      page = (
        <Identity
          data={draft.data}
          folder={draft.folder}
          folders={folders}
          imageUrl={imageUrl}
          onRename={(name) => void draft.rename(name)}
          onField={(key, value) => draft.update(key, value)}
          onFolder={(next) => void draft.moveToFolder(next)}
          onImage={(file) =>
            void cropToCardRatio(file)
              .then((cropped) => draft.replaceAvatar(cropped))
              .catch((err) => draft.reportError((err as Error).message))
          }
        />
      );
      break;
    case 'definition':
      page = (
        <>
          <div className="w3-st-field">{textField('description', 'Description', 'prose')}</div>
          <FoldingFields
            fields={[
              { key: 'personality', label: 'Personality', value: draft.data.personality },
              { key: 'scenario', label: 'Scenario', value: draft.data.scenario },
            ]}
            render={(key, focus) =>
              textField(
                key as 'personality' | 'scenario',
                key === 'personality' ? 'Personality' : 'Scenario',
                'prose',
                focus,
              )
            }
          />
        </>
      );
      break;
    case 'greetings':
      page = (
        <Greetings
          data={draft.data}
          countTokens={countTokens}
          preset={preset}
          persona={persona}
          personaUrl={personaUrl}
          imageUrl={imageUrl}
          seed={draft.avatar}
          onFirst={(text) => draft.update('first_mes', text)}
          onAlternates={(list) => draft.update('alternate_greetings', list)}
          onSwap={(index) => {
            const alternates = [...draft.data.alternate_greetings];
            const chosen = alternates[index - 1] ?? '';
            alternates[index - 1] = draft.data.first_mes;
            draft.update('first_mes', chosen);
            draft.update('alternate_greetings', alternates);
          }}
        />
      );
      break;
    case 'examples':
      page = (
        <Examples
          text={draft.data.mes_example}
          tokens={tokens(draft.data.mes_example)}
          onChange={(text) => draft.update('mes_example', text)}
        />
      );
      break;
    case 'prompts':
      page = (
        <FoldingFields
          fields={[
            { key: 'system_prompt', label: 'System prompt', value: draft.data.system_prompt },
            {
              key: 'post_history_instructions',
              label: 'Post-history instructions',
              value: draft.data.post_history_instructions,
            },
          ]}
          render={(key, focus) =>
            key === 'system_prompt'
              ? textField('system_prompt', 'System prompt', 'text', focus)
              : textField('post_history_instructions', 'Post-history instructions', 'text', focus)
          }
        />
      );
      break;
    case 'lorebook':
      page = (
        <CardBook
          entries={entries}
          busy={book.busy}
          books={books}
          linked={
            typeof draft.data.extensions.world === 'string' ? draft.data.extensions.world : ''
          }
          settings={loreSettings}
          countTokens={countTokens}
          onLink={(name) => draft.updateExtension('world', name || null)}
          onAdd={book.addEntry}
          onChange={book.updateEntry}
          onDelete={book.deleteEntry}
          onReorder={book.reorder}
        />
      );
      break;
    case 'metadata':
      page = (
        <>
          <div className="w3-st-field">
            <FieldHead label="Tags" />
            <ChipList
              values={draft.data.tags}
              label="Add a tag"
              placeholder="Add a tag"
              onChange={(tags) => draft.update('tags', tags)}
            />
          </div>
          <div className="w3-st-field">{textField('creator_notes', 'Creator notes', 'text')}</div>
          <FoldingFields
            fields={[
              { key: 'nickname', label: 'Nickname', value: draft.data.nickname ?? '' },
              { key: 'source', label: 'Source', value: (draft.data.source ?? []).join(' ') },
            ]}
            render={(key) =>
              key === 'nickname' ? (
                <>
                  <FieldHead label="Nickname" />
                  <LineInput
                    label="Nickname"
                    value={draft.data.nickname ?? ''}
                    placeholder="What {{char}} becomes when it is set"
                    onCommit={(value) => draft.update('nickname', value)}
                  />
                </>
              ) : (
                <>
                  <FieldHead label="Source" />
                  <ChipList
                    values={draft.data.source ?? []}
                    label="Add a source"
                    placeholder="A link or where it came from"
                    onChange={(source) => draft.update('source', source)}
                  />
                </>
              )
            }
          />
        </>
      );
      break;
  }

  const current = STUDIO_SECTIONS.find((item) => item.id === section);

  return (
    <div className="w3-bench">
      <Rail
        name={draft.data.name}
        folder={draft.folder}
        imageUrl={imageUrl}
        section={section}
        cost={cost}
        problems={problems}
        saveFailed={draft.saveState === 'error'}
        onRetry={() => void draft.retry().catch(() => {})}
        onSection={goTo}
        onCoCreator={() => onCoCreator(draft.avatar)}
        onExport={(format) => onExport(draft.avatar, format, flush)}
        onDuplicate={() => onDuplicate(draft.avatar, flush)}
        onDelete={() => void draft.remove()}
      />
      <main className="w3-bench__canvas" ref={canvasRef}>
        <div className="w3-bench__sheet" data-section={section}>
          <header className="w3-bench__head">
            <h2>{current?.label}</h2>
          </header>
          <div className="w3-bench__page" key={section}>
            {page}
          </div>
        </div>
      </main>
      <Side cost={cost} problems={problems} onSection={goTo} />
    </div>
  );
}

// ---------- The rail ----------

function Rail({
  name,
  folder,
  imageUrl,
  section,
  cost,
  problems,
  saveFailed,
  onRetry,
  onSection,
  onCoCreator,
  onExport,
  onDuplicate,
  onDelete,
}: {
  name: string;
  folder: string;
  imageUrl: string;
  section: StudioSection;
  cost: CardCost;
  problems: StudioProblem[];
  saveFailed: boolean;
  onRetry: () => void;
  onSection: (section: StudioSection) => void;
  onCoCreator: () => void;
  onExport: (format: 'png' | 'json') => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <nav className="w3-rail" aria-label="Card sections">
      <div className="w3-rail__card">
        <img src={imageUrl} alt="" draggable={false} />
        <div>
          <b>{name || 'Untitled'}</b>
          <small>{folder || 'Top level'}</small>
        </div>
      </div>
      <div className="w3-rail__nav">
        {STUDIO_SECTIONS.map((item) => {
          const tokens = cost.bySection[item.id];
          const wrong = problems.some((problem) => problem.section === item.id);
          return (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id || undefined}
              onClick={() => onSection(item.id)}
            >
              <span>{item.label}</span>
              <span className="w3-rail__n">
                {tokens ? kTokens(tokens) : ''}
                {wrong ? <i title="Something here needs fixing" /> : null}
              </span>
            </button>
          );
        })}
      </div>
      <div className="w3-rail__foot">
        {saveFailed ? (
          <button type="button" className="w3-rail__retry" onClick={onRetry}>
            <Icon name="refresh" size="sm" />
            Retry saving
          </button>
        ) : null}
        <button type="button" onClick={onCoCreator} title="Continue this card in the Co-Creator">
          <Icon name="spark" size="sm" />
          Co-Creator
        </button>
        <div className="w3-rail__pair">
          <button type="button" onClick={() => onExport('png')}>
            <Icon name="download" size="sm" />
            PNG
          </button>
          <button type="button" onClick={() => onExport('json')}>
            <Icon name="download" size="sm" />
            JSON
          </button>
        </div>
        <button type="button" onClick={onDuplicate}>
          <Icon name="copy" size="sm" />
          Duplicate
        </button>
        <button
          type="button"
          data-armed={armed || undefined}
          onClick={() => (armed ? onDelete() : setArmed(true))}
          onBlur={() => setArmed(false)}
        >
          <Icon name="trash" size="sm" />
          {armed ? 'Click again to delete' : 'Delete card'}
        </button>
      </div>
    </nav>
  );
}

// ---------- The side ----------

function Side({
  cost,
  problems,
  onSection,
}: {
  cost: CardCost;
  problems: StudioProblem[];
  onSection: (section: StudioSection) => void;
}) {
  const max = Math.max(
    1,
    ...cost.always.map((row) => row.tokens),
    cost.longestGreeting,
    ...cost.lore.map((row) => row.tokens),
  );
  const bar = (
    key: string,
    label: string,
    tokens: number,
    section: StudioSection,
    quiet?: boolean,
  ) => (
    <button
      key={key}
      type="button"
      className="w3-cost__row"
      data-quiet={quiet || undefined}
      onClick={() => onSection(section)}
    >
      <span>{label}</span>
      <span className="w3-cost__n">{tokens.toLocaleString()}</span>
      <i style={{ '--w': `${(tokens / max) * 100}%` } as CSSProperties} />
    </button>
  );
  return (
    <aside className="w3-side" aria-label="What the card costs">
      {problems.length ? (
        <section className="w3-side__group">
          <h3>{problems.length === 1 ? 'One thing to fix' : `${problems.length} things to fix`}</h3>
          {problems.map((problem, index) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: the same problem can be listed twice
              key={index}
              type="button"
              className="w3-prob"
              onClick={() => onSection(problem.section)}
            >
              <Icon name="alert" size="sm" />
              <span>
                {problem.text}
                <small>{problem.where}</small>
              </span>
            </button>
          ))}
        </section>
      ) : null}
      <section className="w3-side__group">
        <h3>Always sent</h3>
        <p className="w3-cost__big">
          <b>{cost.alwaysTotal.toLocaleString()}</b> tokens
        </p>
        {cost.always.map((row) => bar(row.key, row.label, row.tokens, row.section))}
      </section>
      <section className="w3-side__group">
        <h3>Opening</h3>
        {bar('first', 'First message', cost.firstMessage, 'greetings', true)}
        {bar('longest', 'Longest greeting', cost.longestGreeting, 'greetings', true)}
      </section>
      {cost.lore.length ? (
        <section className="w3-side__group">
          <h3>Lore, when it fires</h3>
          {cost.lore.map((row) => bar(row.key, row.label, row.tokens, row.section, true))}
        </section>
      ) : null}
    </aside>
  );
}

// ---------- Identity ----------

function Identity({
  data,
  folder,
  folders,
  imageUrl,
  onRename,
  onField,
  onFolder,
  onImage,
}: {
  data: CardDataV2;
  folder: string;
  folders: readonly string[];
  imageUrl: string;
  onRename: (name: string) => void;
  onField: (key: 'creator' | 'character_version', value: string) => void;
  onFolder: (folder: string) => void;
  onImage: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const all = [...new Set(['', ...folders, folder])].sort((a, b) =>
    a === '' ? -1 : b === '' ? 1 : a.localeCompare(b),
  );
  return (
    <div className="w3-st-identity">
      <div className="w3-st-portrait">
        <img src={imageUrl} alt="" draggable={false} />
        <button type="button" onClick={() => fileRef.current?.click()}>
          <Icon name="upload" size="xs" />
          Replace
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onImage(file);
          }}
        />
      </div>
      <div className="w3-st-idfields">
        <div className="w3-st-field">
          <FieldHead label="Name" />
          <LineInput
            className="w3-st-input w3-st-input--name"
            label="Name"
            value={data.name}
            placeholder="Name"
            onCommit={(name) => (name.trim() ? onRename(name) : undefined)}
          />
        </div>
        <div className="w3-st-two">
          <div className="w3-st-field">
            <FieldHead label="Creator" />
            <LineInput
              label="Creator"
              value={data.creator}
              placeholder="Who made it"
              onCommit={(value) => onField('creator', value)}
            />
          </div>
          <div className="w3-st-field">
            <FieldHead label="Version" />
            <LineInput
              label="Version"
              value={data.character_version}
              placeholder="1.0"
              onCommit={(value) => onField('character_version', value)}
            />
          </div>
        </div>
        <div className="w3-st-field">
          <FieldHead label="Folder" />
          <div className="w3-st-folders">
            {all.map((name) => (
              <button
                key={name || '(top)'}
                type="button"
                className="w3-chip"
                aria-pressed={folder === name}
                onClick={() => onFolder(name)}
              >
                {name || 'Top level'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Greetings ----------

function Greetings({
  data,
  countTokens,
  preset,
  persona,
  personaUrl,
  imageUrl,
  seed,
  onFirst,
  onAlternates,
  onSwap,
}: {
  data: CardDataV2;
  countTokens: TokenCounter;
  preset: Preset | null;
  persona: Persona | null;
  personaUrl: string | null;
  imageUrl: string;
  seed: string;
  onFirst: (text: string) => void;
  onAlternates: (list: string[]) => void;
  onSwap: (index: number) => void;
}) {
  const all = [data.first_mes, ...data.alternate_greetings];
  const [selected, setSelected] = useState(0);
  const [reading, setReading] = useState(false);
  const [armed, setArmed] = useState(false);
  const index = Math.min(selected, all.length - 1);
  const text = all[index] ?? '';
  // Greetings carry no id, so the shelf gives each one for as long as the card is open; a
  // move or a removal carries the ids along with the text.
  const ids = useRef<number[]>([]);
  const nextId = useRef(0);
  while (ids.current.length < data.alternate_greetings.length) ids.current.push(nextId.current++);
  ids.current.length = data.alternate_greetings.length;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (event: DragEndEvent) => {
    const from = ids.current.indexOf(Number(event.active.id));
    const to = event.over ? ids.current.indexOf(Number(event.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    ids.current = moveItem(ids.current, from, to);
    onAlternates(moveItem(data.alternate_greetings, from, to));
    if (index === from + 1) setSelected(to + 1);
  };
  const pick = (next: number) => {
    setSelected(next);
    setArmed(false);
  };
  const update = (value: string) => {
    if (index === 0) return onFirst(value);
    const list = [...data.alternate_greetings];
    list[index - 1] = value;
    onAlternates(list);
  };
  const preview = useMemo(() => {
    if (!reading) return '';
    if (!preset) return text;
    return resolveGreetingMacros(text, { character: data, preset, persona, messages: [], seed });
  }, [reading, preset, text, data, persona, seed]);

  return (
    <div className="w3-greet">
      <div className="w3-shelf">
        <ShelfItem
          title="First message"
          text={data.first_mes}
          tokens={countTokens.countText(data.first_mes)}
          current={index === 0}
          first
          onPick={() => pick(0)}
        />
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={ids.current} strategy={verticalListSortingStrategy}>
            <div className="w3-shelf__alts">
              {data.alternate_greetings.map((greeting, at) => (
                <ShelfItem
                  key={ids.current[at]}
                  id={ids.current[at]}
                  title={`Greeting ${at + 2}`}
                  text={greeting}
                  tokens={greeting.trim() ? countTokens.countText(greeting) : 0}
                  current={index === at + 1}
                  onPick={() => pick(at + 1)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <button
          type="button"
          className="w3-shelf__add"
          onClick={() => {
            onAlternates([...data.alternate_greetings, '']);
            pick(all.length);
            setReading(false);
          }}
        >
          <Icon name="plus" size="xs" />
          Add a greeting
        </button>
      </div>

      <div className="w3-greet__work">
        <div className="w3-greet__bar">
          <h3>{index === 0 ? 'First message' : `Greeting ${index + 1}`}</h3>
          <span className="w3-st-label__n">
            <b>{(text.trim() ? countTokens.countText(text) : 0).toLocaleString()}</b> tokens
          </span>
          <span className="w3-greet__gap" />
          <div className="w3-seg">
            <button type="button" aria-pressed={!reading} onClick={() => setReading(false)}>
              Write
            </button>
            <button type="button" aria-pressed={reading} onClick={() => setReading(true)}>
              Read
            </button>
          </div>
          {index > 0 ? (
            <>
              <button
                type="button"
                className="w3-st-ghost w3-st-ghost--sm"
                onClick={() => {
                  onSwap(index);
                  pick(0);
                }}
              >
                Make it the first
              </button>
              <button
                type="button"
                className="w3-st-ghost w3-st-ghost--sm"
                data-armed={armed || undefined}
                onBlur={() => setArmed(false)}
                onClick={() => {
                  if (!armed) return setArmed(true);
                  ids.current.splice(index - 1, 1);
                  onAlternates(data.alternate_greetings.filter((_, at) => at !== index - 1));
                  pick(index - 1);
                }}
              >
                <Icon name="trash" size="xs" />
                {armed ? 'Click again to remove' : 'Remove'}
              </button>
            </>
          ) : null}
        </div>
        {reading ? (
          <div className="w3-st-read">
            <div className="w3-st-read__who">
              <img src={imageUrl} alt="" draggable={false} />
              <b>{data.name || 'Untitled'}</b>
              {persona ? (
                <span className="w3-st-read__you">
                  to <Avatar url={personaUrl} name={persona.name} size="xs" who="me" />{' '}
                  {persona.name}
                </span>
              ) : null}
            </div>
            {text.trim() ? (
              <Markdown text={preview} />
            ) : (
              <p className="w3-st-read__empty">Nothing written yet.</p>
            )}
          </div>
        ) : (
          <MacroText
            key={index}
            label={index === 0 ? 'First message' : `Greeting ${index + 1}`}
            value={text}
            variant="prose"
            placeholder="How the chat opens"
            onChange={update}
          />
        )}
      </div>
    </div>
  );
}

function ShelfItem({
  id,
  title,
  text,
  tokens,
  current,
  first,
  onPick,
}: {
  id?: number;
  title: string;
  text: string;
  tokens: number;
  current: boolean;
  first?: boolean;
  onPick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: id ?? -1,
    disabled: first,
  });
  return (
    <div
      ref={first ? undefined : setNodeRef}
      className="w3-shelf__item"
      style={first ? undefined : { transform: CSS.Transform.toString(transform), transition }}
      data-current={current || undefined}
      data-first={first || undefined}
      data-dragging={isDragging || undefined}
    >
      {first ? (
        <span className="w3-shelf__grip" />
      ) : (
        <button
          type="button"
          className="w3-shelf__grip"
          aria-label={`Move ${title}`}
          {...attributes}
          {...listeners}
        >
          <svg viewBox="0 0 10 16" width="8" height="14" aria-hidden="true" fill="currentColor">
            <circle cx="2" cy="3" r="1.3" />
            <circle cx="8" cy="3" r="1.3" />
            <circle cx="2" cy="8" r="1.3" />
            <circle cx="8" cy="8" r="1.3" />
            <circle cx="2" cy="13" r="1.3" />
            <circle cx="8" cy="13" r="1.3" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="w3-shelf__pick"
        onClick={onPick}
        aria-current={current || undefined}
      >
        <b>
          {title}
          <span>{tokens ? kTokens(tokens) : ''}</span>
        </b>
        <span className="w3-shelf__line">{text.replace(/\s+/g, ' ').trim() || 'Empty'}</span>
      </button>
    </div>
  );
}

// ---------- Examples ----------

function Examples({
  text,
  tokens,
  onChange,
}: {
  text: string;
  tokens: number;
  onChange: (text: string) => void;
}) {
  const blocks = useMemo(() => parseExamples(text), [text]);
  const [raw, setRaw] = useState(false);
  const asRaw = raw || blocks === null;
  const write = (next: ExampleTurn[][]) => onChange(joinExamples(next));
  const list = blocks ?? [];

  return (
    <div className="w3-st-field">
      <FieldHead label="Example dialogue" tokens={tokens} />
      <div className="w3-seg w3-ex__mode">
        <button
          type="button"
          aria-pressed={!asRaw}
          disabled={blocks === null}
          title={
            blocks === null
              ? 'This dialogue is not written as <START> blocks of {{user}}: and {{char}}: lines'
              : undefined
          }
          onClick={() => setRaw(false)}
        >
          Conversation
        </button>
        <button type="button" aria-pressed={asRaw} onClick={() => setRaw(true)}>
          Raw
        </button>
      </div>
      {asRaw ? (
        <MacroText
          label="Example dialogue"
          value={text}
          onChange={onChange}
          placeholder="<START>"
        />
      ) : (
        <div className="w3-ex">
          {list.map((turns, block) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: examples are positional
            <div key={block} className="w3-ex__block">
              <div className="w3-ex__head">
                Example {block + 1}
                <button
                  type="button"
                  aria-label={`Remove example ${block + 1}`}
                  onClick={() => write(list.filter((_, at) => at !== block))}
                >
                  <Icon name="trash" size="xs" />
                </button>
              </div>
              {turns.map((turn, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: turns are positional
                <div key={at} className="w3-ex__turn" data-who={turn.who}>
                  <span className="w3-ex__who">
                    {turn.who === 'user' ? '{{user}}' : '{{char}}'}
                  </span>
                  <MacroText
                    label={`${turn.who === 'user' ? 'Your' : 'Their'} line`}
                    value={turn.text}
                    onChange={(value) =>
                      write(
                        list.map((t, b) =>
                          b === block ? t.map((x, i) => (i === at ? { ...x, text: value } : x)) : t,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="w3-ex__drop"
                    aria-label="Remove this line"
                    onClick={() =>
                      write(list.map((t, b) => (b === block ? t.filter((_, i) => i !== at) : t)))
                    }
                  >
                    <Icon name="close" size="xs" />
                  </button>
                </div>
              ))}
              <div className="w3-ex__add">
                {(['user', 'char'] as const).map((who) => (
                  <button
                    key={who}
                    type="button"
                    onClick={() =>
                      write(list.map((t, b) => (b === block ? [...t, { who, text: '' }] : t)))
                    }
                  >
                    + {`{{${who}}}`}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            className="w3-shelf__add"
            onClick={() =>
              write([
                ...list,
                [
                  { who: 'user', text: '' },
                  { who: 'char', text: '' },
                ],
              ])
            }
          >
            <Icon name="plus" size="xs" />
            Add an example
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- The card's lorebook ----------

function CardBook({
  entries,
  busy,
  books,
  linked,
  settings,
  countTokens,
  onLink,
  onAdd,
  onChange,
  onDelete,
  onReorder,
}: {
  entries: WorldInfoEntry[];
  busy: boolean;
  books: readonly LorebookSummary[];
  linked: string;
  settings: WorldInfoSettings;
  countTokens: TokenCounter;
  onLink: (name: string) => void;
  onAdd: () => Promise<number | null>;
  onChange: (uid: number, patch: Partial<WorldInfoEntry>) => void;
  onDelete: (uid: number) => void;
  onReorder: (uids: number[]) => void;
}) {
  const [open, setOpen] = useState<number | null>(entries[0]?.uid ?? null);
  const entry = open === null ? null : (entries.find((e) => e.uid === open) ?? null);
  const options = [
    { value: '', label: 'None' },
    ...(linked && !books.some((b) => b.name === linked)
      ? [{ value: linked, label: `${linked} (missing)` }]
      : []),
    ...books.map((b) => ({ value: b.name, label: b.name })),
  ];
  return (
    <div className="w3-st-book">
      <div className="w3-st-book__linked">
        <Icon name="book" size="sm" />
        <span>Linked lorebook</span>
        <Select
          className="w3-word"
          label="Linked lorebook"
          value={linked}
          options={options}
          onChange={onLink}
        />
      </div>
      <div className="w3-st-book__bar">
        <FieldHead
          label={`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} in the card`}
        />
        <button
          type="button"
          className="w3-st-ghost w3-st-ghost--sm"
          disabled={busy}
          onClick={() => void onAdd().then((uid) => uid !== null && setOpen(uid))}
        >
          <Icon name="plus" size="xs" />
          Entry
        </button>
      </div>
      {entries.length ? (
        <div className={entry ? 'w3-preset__split' : undefined}>
          <EntryList
            entries={entries}
            marks={NO_MARKS}
            open={open}
            rail={Boolean(entry)}
            readOnly={false}
            draggable
            onOpen={(uid) => setOpen(open === uid ? null : uid)}
            onToggle={(e) => onChange(e.uid, { disable: !e.disable })}
            onReorder={onReorder}
          />
          {entry ? (
            <EntryEditor
              key={entry.uid}
              entry={entry}
              mark={undefined}
              readOnly={false}
              settings={settings}
              countTokens={countTokens}
              when={entryWhen(entry, settings.depth)}
              onChange={(patch) => onChange(entry.uid, patch)}
              onDelete={() => {
                setOpen(null);
                onDelete(entry.uid);
              }}
              onClose={() => setOpen(null)}
            />
          ) : null}
        </div>
      ) : (
        <p className="w3-st-none">No entries yet.</p>
      )}
    </div>
  );
}
