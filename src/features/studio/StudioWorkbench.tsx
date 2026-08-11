import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CharacterDetail } from '@shared/types/card.ts';
import type { LorebookSummary } from '@shared/types/worldinfo.ts';
import { bookEntries as bookEntriesOf, toWorldInfoBook } from '@shared/worldinfo/convert.ts';
import { useEffect, useMemo, useState } from 'react';
import {
  CheckField,
  NumberField,
  SelectField,
  TagField,
  TextField,
} from '../../components/Field.tsx';
import { ChevronLeftIcon, DownloadIcon, TrashIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import type { PersistenceControls } from '../../lib/autosave.ts';
import { EmbeddedBook } from '../character/EmbeddedBook.tsx';
import { AvatarStudio } from './AvatarStudio.tsx';
import { measureCard } from './budget.ts';
import { Inspector } from './Inspector.tsx';
import { lintCard } from './lint.ts';
import { STUDIO_SECTIONS, type StudioSection } from './sections.ts';
import { useCardDraft } from './useCardDraft.ts';
import './StudioWorkbench.css';

interface StudioWorkbenchProps {
  detail: CharacterDetail;
  folders: readonly string[];
  books: readonly LorebookSummary[];
  countTokens: TokenCounter;
  contextLimit: number | undefined;
  inspectorCollapsed: boolean;
  onInspectorCollapsedChange: (collapsed: boolean) => void;
  onSaved: (detail: CharacterDetail) => void;
  onRenamed: (detail: CharacterDetail) => void;
  onDeleted: () => void;
  onBack: () => void;
  registerPersistence: (controls: PersistenceControls | null) => void;
  onStatusChange: (status: string) => void;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function sectionTokens(section: StudioSection, fields: Record<string, number>): number {
  const select = (...keys: string[]) => keys.reduce((total, key) => total + (fields[key] ?? 0), 0);
  switch (section) {
    case 'identity':
      return select('name', 'creator', 'character_version');
    case 'definition':
      return select('description', 'personality', 'scenario');
    // Alternates and group-only greetings are one message each, only sent when chosen, so
    // the rail reports the opening message alone — the greeting that is always on the wire.
    case 'greetings':
      return select('first_mes');
    case 'examples':
      return select('mes_example');
    case 'prompts':
      return select('system_prompt', 'post_history_instructions');
    case 'metadata':
      return select('creator_notes', 'nickname');
    case 'advanced':
      return select('depth_prompt');
    default:
      return 0;
  }
}

function EditableGreetingList({
  label,
  value,
  onChange,
  tokenCounts,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  tokenCounts: number[];
}) {
  function update(index: number, next: string) {
    const copy = [...value];
    copy[index] = next;
    onChange(copy);
  }

  function move(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= value.length) return;
    const copy = [...value];
    [copy[index], copy[nextIndex]] = [copy[nextIndex]!, copy[index]!];
    onChange(copy);
  }

  return (
    <div className="studio-greetings">
      <div className="studio-greetings__head">
        <span className="wc-label">{label}</span>
        <span className="field__meta">{value.length}</span>
      </div>
      {value.map((greeting, index) => (
        // Each greeting is positional and duplicates are legal, so no card-owned stable id exists.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional greeting list
        <div className="studio-greetings__item" key={`${label}-${index}`}>
          <TextField
            label={`${label} ${index + 1}`}
            value={greeting}
            onChange={(next) => update(index, next)}
            multiline
            expandable
            rows={5}
            meta={`${formatTokens(tokenCounts[index] ?? 0)} tokens`}
          />
          <div className="studio-greetings__actions">
            <button
              type="button"
              className="wc-button wc-button--ghost"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              Move up
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              disabled={index === value.length - 1}
              onClick={() => move(index, 1)}
            >
              Move down
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost wc-button--danger"
              onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="wc-button" onClick={() => onChange([...value, ''])}>
        Add greeting
      </button>
    </div>
  );
}

export function StudioWorkbench({
  detail,
  folders,
  books,
  countTokens,
  contextLimit,
  inspectorCollapsed,
  onInspectorCollapsedChange,
  onSaved,
  onRenamed,
  onDeleted,
  onBack,
  registerPersistence,
  onStatusChange,
}: StudioWorkbenchProps) {
  const [section, setSection] = useState<StudioSection>('identity');
  const [nameDraft, setNameDraft] = useState(detail.card.data.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const draft = useCardDraft({ detail, onSaved, onRenamed, onDeleted, registerPersistence });
  const budget = useMemo(() => measureCard(draft.data, countTokens), [countTokens, draft.data]);
  const lintDetail = useMemo(
    () => ({ ...detail, folder: draft.folder, card: { ...detail.card, data: draft.data } }),
    [detail, draft.data, draft.folder],
  );
  const findings = useMemo(
    () =>
      lintCard(
        lintDetail,
        budget,
        books.map((book) => book.name),
      ),
    [books, budget, lintDetail],
  );
  const lorebookEntries = useMemo(
    () =>
      draft.data.character_book ? bookEntriesOf(toWorldInfoBook(draft.data.character_book)) : [],
    [draft.data.character_book],
  );

  useEffect(() => onStatusChange(draft.statusLabel), [draft.statusLabel, onStatusChange]);
  useEffect(() => setNameDraft(draft.data.name), [draft.data.name]);

  const fields = budget.fields;
  const meta = (key: string) => `${formatTokens(fields[key] ?? 0)} tokens`;
  const linkedBook =
    typeof draft.data.extensions.world === 'string' ? draft.data.extensions.world : '';
  const depthPrompt = draft.data.extensions.depth_prompt ?? {
    depth: 4,
    prompt: '',
    role: 'system' as const,
  };
  const allFolders = [...new Set([...folders, draft.folder])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  // The raw view is the stored TavernCard, including its synchronized V1 mirror. Draft text
  // appears here as soon as its serialized save settles rather than showing a false mirror.
  const displayedCard = detail.card;

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await draft.remove();
  }

  async function copyRaw() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(displayedCard, null, 4));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function renderSection() {
    switch (section) {
      case 'identity':
        return (
          <div className="studio-section__identity">
            <AvatarStudio
              avatarUrl={characterApi.imageUrl(draft.avatar, detail.modified)}
              name={draft.data.name}
              onReplace={draft.replaceAvatar}
            />
            <div className="studio-section__identity-fields">
              <TextField
                label="Name"
                value={nameDraft}
                onChange={setNameDraft}
                onCommit={() => void draft.rename(nameDraft)}
                hint="Renaming moves the PNG file identity. Existing chats follow it."
                meta={meta('name')}
              />
              <TextField
                label="Creator"
                value={draft.data.creator}
                onChange={(value) => draft.update('creator', value)}
                meta={meta('creator')}
              />
              <TextField
                label="Character version"
                value={draft.data.character_version}
                onChange={(value) => draft.update('character_version', value)}
                meta={meta('character_version')}
              />
              <div className="field">
                <label className="wc-label" htmlFor="studio-folder">
                  Folder
                </label>
                <select
                  id="studio-folder"
                  className="wc-select"
                  value={draft.folder}
                  onChange={(event) => void draft.moveToFolder(event.target.value)}
                >
                  <option value="">Top level</option>
                  {allFolders.map((folder) => (
                    <option key={folder} value={folder}>
                      {folder}
                    </option>
                  ))}
                </select>
                <p className="wc-hint">Moves the file without changing its identity or chats.</p>
              </div>
            </div>
          </div>
        );
      case 'definition':
        return (
          <>
            <TextField
              label="Description"
              value={draft.data.description}
              onChange={(value) => draft.update('description', value)}
              multiline
              expandable
              rows={18}
              meta={meta('description')}
              hint="Core definition, sent through the character description prompt."
            />
            <TextField
              label="Personality"
              value={draft.data.personality}
              onChange={(value) => draft.update('personality', value)}
              multiline
              expandable
              rows={10}
              meta={meta('personality')}
            />
            <TextField
              label="Scenario"
              value={draft.data.scenario}
              onChange={(value) => draft.update('scenario', value)}
              multiline
              expandable
              rows={10}
              meta={meta('scenario')}
            />
          </>
        );
      case 'greetings':
        return (
          <>
            <TextField
              label="First message"
              value={draft.data.first_mes}
              onChange={(value) => draft.update('first_mes', value)}
              multiline
              expandable
              rows={15}
              meta={meta('first_mes')}
              hint="Opens each new chat. Supports {{char}} and {{user}}."
            />
            <EditableGreetingList
              label="Alternate greeting"
              value={draft.data.alternate_greetings}
              onChange={(value) => draft.update('alternate_greetings', value)}
              tokenCounts={draft.data.alternate_greetings.map(
                (_, index) => fields[`alternate_greetings.${index}`] ?? 0,
              )}
            />
            <EditableGreetingList
              label="Group-only greeting"
              value={draft.data.group_only_greetings ?? []}
              onChange={(value) => draft.update('group_only_greetings', value)}
              tokenCounts={(draft.data.group_only_greetings ?? []).map(
                (_, index) => fields[`group_only_greetings.${index}`] ?? 0,
              )}
            />
          </>
        );
      case 'examples':
        return (
          <>
            <TextField
              label="Example dialogue"
              value={draft.data.mes_example}
              onChange={(value) => draft.update('mes_example', value)}
              multiline
              expandable
              rows={20}
              meta={meta('mes_example')}
              hint="Separate examples with <START>. Use {{user}}: and {{char}}: prefixes."
            />
            <button
              type="button"
              className="wc-button"
              onClick={() =>
                draft.update(
                  'mes_example',
                  `${draft.data.mes_example}${draft.data.mes_example.trim() ? '\n\n' : ''}<START>\n{{user}}: \n{{char}}: `,
                )
              }
            >
              Add &lt;START&gt; block
            </button>
          </>
        );
      case 'prompts':
        return (
          <>
            <TextField
              label="System prompt"
              value={draft.data.system_prompt}
              onChange={(value) => draft.update('system_prompt', value)}
              multiline
              expandable
              rows={12}
              meta={meta('system_prompt')}
              hint="Replaces the preset Main Prompt unless that prompt forbids overrides."
            />
            <TextField
              label="Post-history instructions"
              value={draft.data.post_history_instructions}
              onChange={(value) => draft.update('post_history_instructions', value)}
              multiline
              expandable
              rows={12}
              meta={meta('post_history_instructions')}
              hint="Replaces the preset Post-History Instructions prompt."
            />
          </>
        );
      case 'lorebook':
        return (
          <EmbeddedBook
            avatar={draft.avatar}
            entries={lorebookEntries}
            onSaved={draft.handleBookSaved}
            onError={draft.reportError}
            serializeCardWrite={draft.serializeCardWrite}
            registerPersistence={draft.registerBookPersistence}
          />
        );
      case 'metadata':
        return (
          <>
            <TagField
              label="Tags"
              value={draft.data.tags}
              onChange={(value) => draft.update('tags', value)}
              hint="Type a discovery label and press Enter."
            />
            <TextField
              label="Creator notes"
              value={draft.data.creator_notes}
              onChange={(value) => draft.update('creator_notes', value)}
              multiline
              expandable
              rows={12}
              meta={meta('creator_notes')}
              hint="Notes for card users. This is not sent to the model."
            />
            <TextField
              label="Nickname"
              value={draft.data.nickname ?? ''}
              onChange={(value) => draft.update('nickname', value)}
              meta={meta('nickname')}
            />
            <TagField
              label="Source"
              value={draft.data.source ?? []}
              onChange={(value) => draft.update('source', value)}
              hint="Type a source link or provenance label and press Enter."
            />
          </>
        );
      case 'advanced':
        return (
          <>
            <SelectField<string>
              label="Linked lorebook"
              value={linkedBook}
              options={[
                { label: 'None', value: '' },
                ...(linkedBook && !books.some((book) => book.name === linkedBook)
                  ? [{ label: `${linkedBook} (missing)`, value: linkedBook }]
                  : []),
                ...books.map((book) => ({ label: book.name, value: book.name })),
              ]}
              onChange={(value) => draft.updateExtension('world', value || null)}
              hint="This standalone lorebook is activated with the character."
            />
            <NumberField
              label="Talkativeness"
              value={draft.data.extensions.talkativeness ?? 0}
              min={0}
              max={100}
              onChange={(value) => draft.updateExtension('talkativeness', value)}
              hint="A SillyTavern card setting preserved with the card."
            />
            <CheckField
              label="Favourite"
              checked={draft.data.extensions.fav === true}
              onChange={(value) => draft.updateExtension('fav', value)}
            />
            <NumberField
              label="Depth prompt depth"
              value={depthPrompt.depth}
              min={0}
              onChange={(value) =>
                draft.updateExtension('depth_prompt', { ...depthPrompt, depth: value })
              }
            />
            <SelectField<'system' | 'user' | 'assistant'>
              label="Depth prompt role"
              value={depthPrompt.role}
              options={[
                { label: 'System', value: 'system' },
                { label: 'User', value: 'user' },
                { label: 'Assistant', value: 'assistant' },
              ]}
              onChange={(value) =>
                draft.updateExtension('depth_prompt', { ...depthPrompt, role: value })
              }
            />
            <TextField
              label="Depth prompt"
              value={depthPrompt.prompt}
              onChange={(value) =>
                draft.updateExtension('depth_prompt', { ...depthPrompt, prompt: value })
              }
              multiline
              expandable
              rows={10}
              meta={meta('depth_prompt')}
              hint="Used by SillyTavern. WackChatter does not inject this yet."
            />
          </>
        );
      case 'raw-json':
        return (
          <>
            <div className="studio-raw__head">
              <p className="wc-hint">
                Read-only in V1. It includes the V2 data block and V1 legacy mirror exactly as
                stored.
              </p>
              <button type="button" className="wc-button" onClick={() => void copyRaw()}>
                {copied ? 'Copied' : 'Copy JSON'}
              </button>
            </div>
            <pre className="studio-raw">{JSON.stringify(displayedCard, null, 4)}</pre>
          </>
        );
    }
  }

  return (
    <div className="studio-workbench" data-inspector-collapsed={inspectorCollapsed || undefined}>
      <nav className="studio-nav" aria-label="Card sections">
        {STUDIO_SECTIONS.map((item) => {
          const sectionFindings = findings.filter((finding) => finding.section === item.id);
          const hasError = sectionFindings.some((finding) => finding.level === 'error');
          const tokenCount = sectionTokens(item.id, fields);
          const extra = item.id === 'lorebook' ? budget.lorebookConstant : tokenCount;
          return (
            <button
              key={item.id}
              type="button"
              className="studio-nav__item"
              data-active={section === item.id || undefined}
              onClick={() => setSection(item.id)}
            >
              <span>{item.label}</span>
              <span className="studio-nav__meta">
                {extra ? formatTokens(extra) : ''}
                {sectionFindings.length ? (
                  <b data-error={hasError || undefined}>
                    {hasError ? '!' : sectionFindings.length}
                  </b>
                ) : null}
              </span>
            </button>
          );
        })}
        <div className="studio-nav__footer">
          {draft.saveState === 'error' ? (
            <button type="button" className="wc-button" onClick={() => void draft.retry()}>
              Retry save
            </button>
          ) : null}
          <a
            className="wc-button wc-button--ghost"
            href={characterApi.exportUrl(draft.avatar, 'png')}
            download
          >
            <DownloadIcon /> Export PNG
          </a>
          <a
            className="wc-button wc-button--ghost"
            href={characterApi.exportUrl(draft.avatar, 'json')}
            download
          >
            <DownloadIcon /> Export JSON
          </a>
          <button
            type="button"
            className="wc-button wc-button--ghost wc-button--danger"
            onClick={() => void handleDelete()}
            onBlur={() => setConfirmDelete(false)}
          >
            <TrashIcon /> {confirmDelete ? 'Click again to confirm' : 'Delete card'}
          </button>
        </div>
      </nav>
      <main className="studio-canvas">
        <header className="studio-canvas__header">
          <div>
            <p className="studio-canvas__eyebrow">Character card</p>
            <h1>{STUDIO_SECTIONS.find((item) => item.id === section)?.label}</h1>
          </div>
          <button type="button" className="wc-button wc-button--primary" onClick={onBack}>
            <ChevronLeftIcon />
            Back to library
          </button>
        </header>
        <div className="studio-canvas__body">{renderSection()}</div>
      </main>
      <Inspector
        budget={budget}
        contextLimit={contextLimit}
        findings={findings}
        onSelectSection={setSection}
      />
      <button
        type="button"
        className="studio-workbench__inspector-toggle wc-button"
        onClick={() => onInspectorCollapsedChange(!inspectorCollapsed)}
        aria-expanded={!inspectorCollapsed}
      >
        {inspectorCollapsed ? 'Show inspector' : 'Hide inspector'}
      </button>
    </div>
  );
}
