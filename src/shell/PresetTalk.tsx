/**
 * The Co-Creator's side of the loop: the conversation, where every edit shows the change it
 * made and every reply you sent back shows what you sent, and the composer.
 */

import { REASONING_EFFORT_OPTIONS } from '@shared/models/reasoning.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { PresetSummary, ReasoningEffort } from '@shared/types/preset.ts';
import type {
  PresetCocreatorMessage,
  PresetComparisonSource,
  PresetDraftRevision,
  PresetTestReport,
  ReferencePresetSummary,
} from '@shared/types/preset-cocreator.ts';
import { memo, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Popover } from '../components/Popover.tsx';
import { Markdown } from '../features/chat/Markdown.tsx';
import { Reasoning } from '../features/chat/Reasoning.tsx';
import type { StreamStore } from '../features/chat/state/streamStore.ts';
import { useStickToBottom } from '../features/chat/useStickToBottom.ts';
import {
  correlateToolMessages,
  type ToolExchange,
  toolCallArguments,
} from '../features/preset-cocreator/assistant.ts';
import { compareCommandDraft } from '../features/preset-cocreator/compareCommands.ts';
import {
  comparisonChoices,
  filterComparisonChoices,
} from '../features/preset-cocreator/compareSources.ts';
import { DiffParts } from '../features/preset-cocreator/PresetChanges.tsx';
import {
  describePresetChanges,
  formatValue,
  type PresetChange,
} from '../features/preset-cocreator/presetChanges.ts';
import { diffText } from '../features/preset-cocreator/textDiff.ts';
import type { PresetCocreatorController } from '../features/preset-cocreator/usePresetCocreator.ts';
import type { PresetTestingController } from '../features/preset-cocreator/usePresetTesting.ts';
import { characterApi } from '../lib/api.ts';
import { Avatar } from './Avatar.tsx';
import { Range, Segments } from './controls.tsx';
import { Icon } from './icons.tsx';

export function PresetTalk({
  controller,
  testing,
  presets,
  references,
  characters,
  modelName,
  reasoningSaving = false,
  assistantEffort,
  onShowRevision,
}: {
  controller: PresetCocreatorController;
  testing: PresetTestingController;
  presets: readonly PresetSummary[];
  references: readonly ReferencePresetSummary[];
  characters: readonly CharacterSummary[];
  modelName: string | null;
  reasoningSaving?: boolean;
  assistantEffort?: ReasoningEffort;
  onShowRevision: (revision: number) => void;
}) {
  const { session } = controller;
  const messages = session.document.messages;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useStickToBottom(scrollRef, bodyRef);

  const exchanges = useMemo(
    () => new Map(correlateToolMessages(messages).map((exchange) => [exchange.id, exchange])),
    [messages],
  );
  const history = session.history;
  const last = messages.at(-1);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const assistant = session.document.settings.assistant;
  const patchAssistant = (patch: Partial<typeof assistant>) =>
    controller.updateDocument((current) => ({
      ...current,
      settings: { ...current.settings, assistant: { ...current.settings.assistant, ...patch } },
    }));
  const overrideLabel = REASONING_EFFORT_OPTIONS.find(([id]) => id === assistantEffort)?.[1];
  const blockedReason = reasoningSaving ? 'Saving model settings…' : null;

  return (
    <section className="w3-pc-col w3-pc-talk" aria-label="Co-Creator">
      <div className="w3-pc-col__head">
        <h3>Co-Creator</h3>
        <small>{modelName ?? 'No model'}</small>
        <span className="w3-co-gap" />
        <Popover
          label="How the Co-Creator works in this session"
          icon={null}
          open={instructionsOpen}
          onOpenChange={setInstructionsOpen}
          placement="bottom-end"
          role="dialog"
          popupClassName="w3-pc-instr"
          renderTrigger={(trigger) => (
            <button
              {...trigger}
              type="button"
              className="w3-pc-headbtn"
              title="Temperature, reasoning and instructions for this session"
              onClick={() => setInstructionsOpen(!instructionsOpen)}
            >
              <Icon name="gear" size="xs" />
              Setup
            </button>
          )}
        >
          <div className="w3-pc-instr__body">
            <Range
              label="Temperature"
              value={assistant.temperature}
              min={0}
              max={2}
              step={0.05}
              shown={assistant.temperature.toFixed(2)}
              onChange={(temperature) => patchAssistant({ temperature })}
            />
            <div className="w3-pc-instr__row">
              <span>
                Reasoning <small>Session default</small>
              </span>
              <Segments
                label="Reasoning effort"
                value={assistant.reasoningEffort}
                options={REASONING_EFFORT_OPTIONS}
                onChange={(reasoningEffort) => patchAssistant({ reasoningEffort })}
              />
              {overrideLabel ? (
                <p className="w3-pc-instr__hint">
                  {modelName ?? 'This model'} uses {overrideLabel}, remembered in the model picker.
                  Choose Use session default there to follow this setting.
                </p>
              ) : null}
            </div>
            <textarea
              className="w3-pc-instr__text"
              rows={6}
              value={session.document.settings.assistantInstructions}
              placeholder="Instructions it keeps in mind in this session"
              aria-label="Instructions for this session"
              onChange={(event) => {
                const assistantInstructions = event.target.value;
                controller.updateDocument((current) => ({
                  ...current,
                  settings: { ...current.settings, assistantInstructions },
                }));
              }}
            />
          </div>
        </Popover>
      </div>
      <div className="w3-co-scroll" ref={scrollRef}>
        <div className="w3-pc-list" ref={bodyRef}>
          {!messages.length ? (
            <p className="w3-pc-empty">
              Say what you want to fix, or run a test and send a reply back.
            </p>
          ) : null}
          {messages.map((message) => (
            <TalkMessage
              key={message.id}
              message={message}
              exchange={exchanges.get(message.id) ?? null}
              history={history}
              characters={characters}
              isLast={message === last}
              busy={controller.busy}
              blockedReason={blockedReason}
              onContinue={() => void controller.continueReply()}
              onEdit={controller.editMessage}
              onShowRevision={onShowRevision}
              onShowTest={(testId) => testing.setActive(testId)}
            />
          ))}
          {controller.busy && !controller.preparing ? (
            <Streaming store={controller.stream} last={last} compacting={controller.compacting} />
          ) : null}
        </div>
      </div>
      {controller.error ? (
        <p className="w3-co-error" role="alert">
          {controller.error}
        </p>
      ) : null}
      <Composer
        controller={controller}
        testing={testing}
        presets={presets}
        references={references}
        history={history}
        reasoningSaving={reasoningSaving}
      />
    </section>
  );
}

// ---------- Messages ----------

const TalkMessage = memo(function TalkMessage({
  message,
  exchange,
  history,
  characters,
  isLast,
  busy,
  blockedReason,
  onContinue,
  onEdit,
  onShowRevision,
  onShowTest,
}: {
  message: PresetCocreatorMessage;
  exchange: ToolExchange | null;
  history: readonly PresetDraftRevision[];
  characters: readonly CharacterSummary[];
  isLast: boolean;
  busy: boolean;
  blockedReason: string | null;
  onContinue: () => void;
  onEdit: (id: string, text: string) => void;
  onShowRevision: (revision: number) => void;
  onShowTest: (testId: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const editor =
    editing !== null ? (
      <div className="w3-pc-msgedit">
        <textarea
          value={editing}
          aria-label="Edit the message"
          // biome-ignore lint/a11y/noAutofocus: opened by asking to edit
          autoFocus
          onChange={(event) => setEditing(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(null);
          }}
        />
        <div className="w3-pc-msgedit__acts">
          <button
            type="button"
            className="w3-st-ghost w3-st-ghost--sm"
            onClick={() => setEditing(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="w3-st-pill w3-co-pill w3-pc-pill--sm"
            disabled={busy || !editing.trim()}
            onClick={() => {
              onEdit(message.id, editing);
              setEditing(null);
            }}
          >
            Save
          </button>
        </div>
      </div>
    ) : null;
  const editButton = (
    <button
      type="button"
      disabled={busy}
      title="Change what it says. The next turn reads the new text."
      onClick={() => setEditing(message.content)}
    >
      <Icon name="pencil" size="xs" />
      Edit
    </button>
  );
  if (message.role === 'tool') {
    return exchange ? (
      <ToolLine exchange={exchange} history={history} onShowRevision={onShowRevision} />
    ) : null;
  }
  if (message.role === 'report') {
    if (message.report) {
      return <SentBack report={message.report} characters={characters} onShowTest={onShowTest} />;
    }
    if (message.batch) {
      return (
        <div className="w3-co-msg" data-me>
          <div className="w3-pc-report">
            <div className="w3-pc-report__head">
              <b>
                Sent back {message.batch.reports.length}{' '}
                {message.batch.reports.length === 1 ? 'reply' : 'replies'}
              </b>
            </div>
            {message.batch.note ? (
              <div className="w3-pc-report__note">{message.batch.note}</div>
            ) : null}
          </div>
        </div>
      );
    }
    return null;
  }
  if (message.role === 'user') {
    if (message.comparison) {
      return (
        <div className="w3-co-msg" data-me>
          <div className="w3-pc-report">
            <div className="w3-pc-report__head">
              <Icon name="lines" size="xs" />
              <b>Compare</b> revision {message.comparison.draft.revision} with{' '}
              {message.comparison.other.label}
            </div>
            {message.comparison.focus ? (
              <div className="w3-pc-report__note">{message.comparison.focus}</div>
            ) : null}
          </div>
        </div>
      );
    }
    // Continue requests are the app's words, not yours.
    if (isContinueRequest(message.content)) return null;
    return (
      <div className="w3-co-msg" data-me>
        {editor ?? (
          <>
            <div className="w3-co-msg__bubble">
              <Markdown text={message.content} />
            </div>
            <div className="w3-co-msg__tools">{editButton}</div>
          </>
        )}
      </div>
    );
  }
  // The assistant: what it said, and the calls it made render as their own lines.
  if (!message.content.trim() && !message.reasoning && !message.incomplete) return null;
  return (
    <div className="w3-co-msg">
      <div className="w3-co-msg__who">
        <b>Co-Creator</b>
        {message.incomplete ? (
          <span className="w3-pc-flag">
            {message.incomplete === 'stopped'
              ? 'stopped'
              : message.incomplete === 'filtered'
                ? 'filtered'
                : 'cut off'}
          </span>
        ) : null}
      </div>
      <div className="w3-co-msg__body">
        {message.reasoning ? <Reasoning text={message.reasoning} /> : null}
        {editor ?? (message.content.trim() ? <Markdown text={message.content} /> : null)}
      </div>
      {editor ? null : (
        <div className="w3-co-msg__tools">
          {message.incomplete && message.incomplete !== 'filtered' && isLast ? (
            <button
              type="button"
              disabled={busy || Boolean(blockedReason)}
              title={blockedReason ?? undefined}
              onClick={onContinue}
            >
              <Icon name="forward" size="xs" />
              Continue
            </button>
          ) : null}
          {message.content.trim() ? editButton : null}
        </div>
      )}
    </div>
  );
});

function isContinueRequest(text: string) {
  return (
    text.startsWith('Continue your interrupted answer exactly where it stopped') ||
    text.startsWith('Your previous response was interrupted during a tool call')
  );
}

function ToolLine({
  exchange,
  history,
  onShowRevision,
}: {
  exchange: ToolExchange;
  history: readonly PresetDraftRevision[];
  onShowRevision: (revision: number) => void;
}) {
  const args = toolCallArguments(exchange.call);
  const result =
    exchange.result && typeof exchange.result === 'object'
      ? (exchange.result as Record<string, unknown>)
      : {};
  const failed = result.ok === false;
  const error = typeof result.error === 'string' ? result.error : null;

  if (exchange.name === 'patch_preset') {
    const revision = typeof result.revision === 'number' ? result.revision : null;
    if (failed || revision === null) {
      return (
        <div className="w3-pc-line" data-bad>
          <Icon name="alert" size="xs" />
          <span>The edit didn’t apply{error ? `: ${error}` : ''}. It tries again.</span>
        </div>
      );
    }
    const summary = typeof args.summary === 'string' ? args.summary : '';
    return (
      <EditCard
        revision={revision}
        summary={summary}
        history={history}
        onShowRevision={onShowRevision}
      />
    );
  }
  if (exchange.name === 'read_preset') {
    return (
      <div className="w3-pc-line">
        <Icon name="eye" size="xs" />
        <span>Read the preset</span>
      </div>
    );
  }
  if (exchange.name === 'read_reference_preset') {
    const name = typeof args.name === 'string' ? args.name : 'a reference';
    return (
      <div className="w3-pc-line" data-bad={failed || undefined}>
        <Icon name="eye" size="xs" />
        <span>
          Read {name}
          {failed && error ? `: ${error}` : ''}
        </span>
      </div>
    );
  }
  if (exchange.name === 'propose_test') {
    return (
      <div className="w3-pc-line" data-bad={failed || undefined}>
        <Icon name="chat" size="xs" />
        <span>
          {failed
            ? `The test suggestion failed${error ? `: ${error}` : ''}`
            : 'Suggested a test, on the bench'}
        </span>
      </div>
    );
  }
  return (
    <div className="w3-pc-line">
      <span>
        {exchange.name}
        {failed && error ? `: ${error}` : ''}
      </span>
    </div>
  );
}

/** One edit: what it changed, read the way you'd read the preset. */
const EditCard = memo(function EditCard({
  revision,
  summary,
  history,
  onShowRevision,
}: {
  revision: number;
  summary: string;
  history: readonly PresetDraftRevision[];
  onShowRevision: (revision: number) => void;
}) {
  const after = history.find((entry) => entry.revision === revision) ?? null;
  const before = history.find((entry) => entry.revision === revision - 1) ?? null;
  const changes = useMemo(
    () => (before && after ? describePresetChanges(before.preset, after.preset) : []),
    [before, after],
  );
  const [all, setAll] = useState(false);
  const shown = all ? changes : changes.slice(0, 3);
  const prompts = changes.filter((change) => change.kind === 'text' || change.kind === 'prompt');
  const names = [...new Set(prompts.map((change) => change.label.split(' › ')[0]))];
  return (
    <div className="w3-pc-edit">
      <div className="w3-pc-edit__head">
        <Icon name="pencil" size="xs" />
        <span>
          {names.length ? (
            <>
              Edited <b>{names.slice(0, 2).join(', ')}</b>
              {names.length > 2 ? ` and ${names.length - 2} more` : ''}
            </>
          ) : (
            <b>Edited the preset</b>
          )}
        </span>
        <span className="w3-co-gap" />
        <button
          type="button"
          className="w3-pc-link"
          title="Show this revision on the preset"
          onClick={() => onShowRevision(revision)}
        >
          Revision {revision}
        </button>
      </div>
      {summary ? <p className="w3-pc-edit__why">{summary}</p> : null}
      {shown.map((change) => (
        <ChangeView key={change.key} change={change} />
      ))}
      {changes.length > shown.length ? (
        <button type="button" className="w3-pc-link" onClick={() => setAll(true)}>
          Show all {changes.length} changes
        </button>
      ) : null}
    </div>
  );
});

function ChangeView({ change }: { change: PresetChange }) {
  if (change.kind === 'text') return <TextChange change={change} />;
  if (change.kind === 'value') {
    return (
      <div className="w3-pc-change">
        <span className="w3-pc-change__label">{change.label}</span>
        <span className="w3-pc-change__value">
          <del>{formatValue(change.before)}</del> → <ins>{formatValue(change.after)}</ins>
        </span>
      </div>
    );
  }
  if (change.kind === 'prompt') {
    return (
      <div className="w3-pc-change">
        <span className="w3-pc-change__label">
          {change.change === 'added' ? 'New prompt' : 'Removed'} · {change.label}
        </span>
        {change.content ? (
          <div className="w3-pc-diff">
            {change.change === 'added' ? <ins>{change.content}</ins> : <del>{change.content}</del>}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="w3-pc-change">
      <span className="w3-pc-change__label">{change.label}</span>
      <ul className="w3-pc-change__lines">
        {change.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function TextChange({ change }: { change: Extract<PresetChange, { kind: 'text' }> }) {
  const diff = useMemo(() => diffText(change.before, change.after), [change.before, change.after]);
  return (
    <div className="w3-pc-change">
      <span className="w3-pc-change__label">{change.label}</span>
      {diff.mode === 'words' ? (
        <div className="w3-pc-diff">
          <DiffParts parts={diff.parts} />
        </div>
      ) : (
        <div className="w3-pc-diff w3-pc-diff--two">
          <del>{diff.before}</del>
          <ins>{diff.after}</ins>
        </div>
      )}
    </div>
  );
}

/** A reply you sent back: whose, on which revision, and what you said about it. */
function SentBack({
  report,
  characters,
  onShowTest,
}: {
  report: PresetTestReport;
  characters: readonly CharacterSummary[];
  onShowTest: (testId: string) => void;
}) {
  const name = report.characterName ?? 'Test';
  const card = characters.find((c) => c.name === name) ?? null;
  const revision = report.presetUsed?.revision;
  const parts = [
    'Reply',
    report.includePrompt ? 'Prompt' : null,
    report.includeDiagnostics ? 'Diagnostics' : null,
    report.includeTranscript ? 'Conversation' : null,
  ].filter(Boolean);
  return (
    <div className="w3-co-msg" data-me>
      <div className="w3-pc-report">
        <button
          type="button"
          className="w3-pc-report__head"
          title="Show this test on the bench"
          onClick={() => onShowTest(report.testId)}
        >
          <Avatar
            url={card ? characterApi.imageUrl(card.avatar, card.modified) : null}
            name={name}
            size="xs"
          />
          <b>Sent back</b>
          <span>
            {name}
            {typeof revision === 'number'
              ? ` · revision ${revision}`
              : report.presetUsed
                ? ` · ${report.presetUsed.label}`
                : ''}
            {report.evidence?.model ? ` · ${report.evidence.model.split('/').pop()}` : ''}
          </span>
        </button>
        {report.replyText ? <div className="w3-pc-report__quote">{report.replyText}</div> : null}
        {report.note.trim() ? <div className="w3-pc-report__note">{report.note}</div> : null}
        <div className="w3-pc-tags">
          {parts.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The one streaming leaf: the reply's text reaches here and nowhere else. */
function Streaming({
  store,
  last,
  compacting,
}: {
  store: StreamStore;
  last: PresetCocreatorMessage | undefined;
  compacting: boolean;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const working = compacting
    ? 'Compacting the conversation'
    : last?.role === 'tool' && last.toolName === 'patch_preset'
      ? 'Edited the preset, carrying on'
      : last?.role === 'tool'
        ? 'Reading'
        : 'Thinking';
  return (
    <div className="w3-co-msg w3-pc-streaming">
      <div className="w3-co-msg__who">
        <b>Co-Creator</b>
        {snapshot.text ? null : <span className="w3-pc-working">{working}</span>}
      </div>
      <div className="w3-co-msg__body">
        {snapshot.reasoning ? <Reasoning text={snapshot.reasoning} defaultOpen /> : null}
        {snapshot.text ? (
          <div className="message__text w3-pc-stream-text">{snapshot.text}</div>
        ) : null}
      </div>
    </div>
  );
}

// ---------- The composer ----------

function Composer({
  controller,
  testing,
  presets,
  references,
  history,
  reasoningSaving,
}: {
  controller: PresetCocreatorController;
  testing: PresetTestingController;
  presets: readonly PresetSummary[];
  references: readonly ReferencePresetSummary[];
  history: readonly PresetDraftRevision[];
  reasoningSaving: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [comparison, setComparison] = useState<{
    source: PresetComparisonSource;
    label: string;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  const command = comparison ? ({ kind: 'message' } as const) : compareCommandDraft(draft);
  const choices = useMemo(
    () =>
      command.kind === 'source'
        ? filterComparisonChoices(
            comparisonChoices(references, presets, history, controller.session.draftRevision),
            command.query,
          ).slice(0, 12)
        : [],
    [command, references, presets, history, controller.session.draftRevision],
  );
  const choosing = command.kind === 'source' || command.kind === 'command';

  const pick = (choice: (typeof choices)[number]) => {
    setComparison({ source: choice.source, label: choice.label });
    setDraft('');
    setIndex(0);
    textRef.current?.focus({ preventScroll: true });
  };

  const queue = controller.session.document.batchQueue;
  const batching = queue.items.length > 0 && !comparison;

  const blocked = reasoningSaving
    ? 'Saving model settings…'
    : !controller.assistantConnection
      ? 'Choose the Co-Creator’s model on the island first.'
      : null;

  const send = () => {
    if (controller.busy || blocked) return;
    if (batching) {
      const note = draft.trim();
      testing.updateBatch((current) => ({ ...current, note }));
      setDraft('');
      void controller.sendBatch().catch(() => {});
      return;
    }
    if (comparison) {
      const focus = draft;
      setComparison(null);
      setDraft('');
      void controller.compare(comparison.source, comparison.label, focus).catch(() => {});
      return;
    }
    if (command.kind === 'invalid') {
      setProblem(`${command.error} Only /compare works here.`);
      return;
    }
    if (command.kind !== 'message') {
      setProblem('Pick a preset to compare with.');
      return;
    }
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void controller.send(text);
  };

  return (
    <div className="w3-co-composer w3-pc-composer">
      {comparison ? (
        <div className="w3-pc-attached">
          <Icon name="lines" size="xs" />
          <span>
            Compare the draft with <b>{comparison.label}</b>
          </span>
          <span className="w3-co-gap" />
          <button
            type="button"
            className="w3-pc-x"
            aria-label="Don't compare"
            onClick={() => setComparison(null)}
          >
            <Icon name="close" size="xs" />
          </button>
        </div>
      ) : null}
      {batching ? (
        <div className="w3-pc-batch">
          <div className="w3-pc-batch__head">
            <Icon name="forward" size="xs" />
            <b>
              {queue.items.length} {queue.items.length === 1 ? 'reply' : 'replies'} to send back
            </b>
            <span className="w3-co-gap" />
            <button
              type="button"
              className="w3-pc-incl"
              aria-pressed={queue.includePrompt}
              onClick={() =>
                testing.updateBatch((q) => ({ ...q, includePrompt: !q.includePrompt }))
              }
            >
              Prompt
            </button>
            <button
              type="button"
              className="w3-pc-incl"
              aria-pressed={queue.includeDiagnostics}
              onClick={() =>
                testing.updateBatch((q) => ({ ...q, includeDiagnostics: !q.includeDiagnostics }))
              }
            >
              Diagnostics
            </button>
            <button
              type="button"
              className="w3-pc-incl"
              aria-pressed={queue.includeTranscript}
              onClick={() =>
                testing.updateBatch((q) => ({ ...q, includeTranscript: !q.includeTranscript }))
              }
            >
              Whole conversation
            </button>
          </div>
          {queue.items.map((item) => (
            <div key={item.id} className="w3-pc-batch__item">
              <span className="w3-pc-batch__who">
                {item.characterName ?? 'Test'}
                {typeof item.presetUsed?.revision === 'number'
                  ? ` · revision ${item.presetUsed.revision}`
                  : ''}
              </span>
              <input
                value={item.note}
                placeholder={(item.replyText ?? '').slice(0, 80) || 'A note on this one (optional)'}
                aria-label={`A note on ${item.characterName ?? 'this reply'}`}
                onChange={(event) => testing.setBatchItemNote(item.id, event.target.value)}
              />
              <button
                type="button"
                className="w3-pc-x"
                aria-label="Take it out of the batch"
                onClick={() => testing.removeBatchItem(item.id)}
              >
                <Icon name="close" size="xs" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {problem ? <p className="w3-pc-problem">{problem}</p> : null}
      <div className="w3-co-box">
        <Popover
          label="Compare with"
          icon={null}
          className="w3-pc-field"
          open={choosing}
          onOpenChange={(open) => {
            if (!open && choosing) setDraft('');
          }}
          role="listbox"
          placement="top-start"
          popupClassName="w3-pc-choices"
          renderTrigger={(trigger) => (
            <textarea
              {...trigger}
              ref={(node) => {
                trigger.ref(node);
                textRef.current = node;
              }}
              rows={2}
              value={draft}
              disabled={controller.busy}
              aria-label="Message the Co-Creator"
              placeholder={
                comparison
                  ? 'What to look at (optional)'
                  : batching
                    ? 'What should it look at across them? (optional)'
                    : 'Ask for a change, or /compare with another preset'
              }
              onChange={(event) => {
                setDraft(event.target.value);
                setProblem(null);
                setIndex(0);
              }}
              onKeyDown={(event) => {
                if (
                  choosing &&
                  choices.length &&
                  (event.key === 'ArrowDown' || event.key === 'ArrowUp')
                ) {
                  event.preventDefault();
                  setIndex(
                    (at) =>
                      (at + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length,
                  );
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (command.kind === 'command') setDraft('/compare ');
                  else if (command.kind === 'source' && choices[index]) pick(choices[index]);
                  else send();
                }
              }}
            />
          )}
        >
          <div className="w3-pc-choices__list">
            {command.kind === 'command' ? (
              <button
                type="button"
                role="option"
                aria-selected
                onClick={() => setDraft('/compare ')}
              >
                <b>/compare</b>
                <small>Ask the Co-Creator how your draft compares with another preset</small>
              </button>
            ) : choices.length ? (
              choices.map((choice, at) => (
                <button
                  key={choice.key}
                  type="button"
                  role="option"
                  aria-selected={at === index}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(choice)}
                >
                  <b>{choice.label}</b>
                  <small>
                    {choice.group === 'Session revisions' ? choice.detail : choice.group}
                  </small>
                </button>
              ))
            ) : (
              <p>No preset by that name.</p>
            )}
          </div>
        </Popover>
        <div className="w3-co-box__acts">
          {controller.busy ? (
            <button
              type="button"
              className="w3-co-send w3-pc-stop"
              aria-label="Stop"
              onClick={controller.stop}
            >
              <Icon name="stop" size="sm" />
            </button>
          ) : (
            <button
              type="button"
              className="w3-co-send"
              aria-label="Send"
              disabled={Boolean(blocked) || (!comparison && !batching && !draft.trim())}
              title={blocked ?? undefined}
              onClick={send}
            >
              <Icon name="send" size="sm" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
