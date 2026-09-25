import type { Connection } from '@shared/providers/types.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import type { PresetComparison, ReferencePresetSummary } from '@shared/types/preset-cocreator.ts';
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Popover } from '../../components/Popover.tsx';
import { EditIcon, PlugIcon, WandIcon } from '../../layout/icons.tsx';
import { formatTimestamp } from '../chat/formatDate.ts';
import { Markdown } from '../chat/Markdown.tsx';
import { Reasoning } from '../chat/Reasoning.tsx';
import { useStickToBottom } from '../chat/useStickToBottom.ts';
import '../chat/MessageBubble.css';
import { correlateToolMessages } from './assistant.ts';
import { compareCommandDraft, PRESET_SLASH_COMMANDS } from './compareCommands.ts';
import {
  type ComparisonChoice,
  comparisonChoices,
  filterComparisonChoices,
} from './compareSources.ts';
import { PresetModelSettings } from './PresetModelSettings.tsx';
import { StreamingBubble } from './StreamingBubble.tsx';
import { type ProposalControls, type RevisionPresets, ToolActivityCard } from './ToolActivity.tsx';
import { summarizeReport } from './testing.ts';
import { describePresetUsed } from './testingSources.ts';
import type { PresetCocreatorController } from './usePresetCocreator.ts';

interface PresetAssistantPanelProps {
  controller: PresetCocreatorController;
  connections: readonly Connection[];
  /** Owned by the workspace, which also blocks shared reports on it. */
  toolCapability: boolean | null;
  onToolCapabilityChange: (supported: boolean | null) => void;
  /** Run and dismiss for the proposal cards; the proposals themselves live in the document. */
  proposalActions: Omit<ProposalControls, 'proposals'>;
  presets: readonly PresetSummary[];
  references: readonly ReferencePresetSummary[];
}

const ComparisonCard = memo(function ComparisonCard({
  comparison,
}: {
  comparison: PresetComparison;
}) {
  return (
    <div className="preset-cc-comparison-card">
      <div className="preset-cc-comparison-card__title">/compare</div>
      <p>
        {comparison.draft.label} · revision {comparison.draft.revision} → {comparison.other.label}
      </p>
      <span className="wc-hint">
        {comparison.other.source.kind === 'revision'
          ? 'Session revision'
          : comparison.other.source.kind === 'library'
            ? 'My preset'
            : 'Reference preset'}
      </span>
      {comparison.focus ? <blockquote>{comparison.focus}</blockquote> : null}
      <details>
        <summary>Preset snapshots used</summary>
        <strong>Current draft · revision {comparison.draft.revision}</strong>
        <pre>{JSON.stringify(comparison.draft.preset, null, 2)}</pre>
        <strong>{comparison.other.label}</strong>
        <pre>{JSON.stringify(comparison.other.preset, null, 2)}</pre>
      </details>
    </div>
  );
});

export function PresetAssistantPanel({
  controller,
  connections,
  toolCapability,
  onToolCapabilityChange,
  proposalActions,
  presets,
  references,
}: PresetAssistantPanelProps) {
  const [draft, setDraft] = useState('');
  const [comparison, setComparison] = useState<ComparisonChoice | null>(null);
  const [preservedFocus, setPreservedFocus] = useState('');
  const [commandError, setCommandError] = useState('');
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(false);
  const sawBusyRef = useRef(false);
  const suggestionId = useId();
  const choices = useMemo(
    () =>
      comparisonChoices(
        references,
        presets,
        controller.session.history,
        controller.session.draftRevision,
      ),
    [references, presets, controller.session.history, controller.session.draftRevision],
  );
  const parsedCommand = compareCommandDraft(draft);
  const sourceMode = !comparison && parsedCommand.kind === 'source';
  const sourceQuery = parsedCommand.kind === 'source' ? parsedCommand.query : '';
  const matchingChoices = sourceMode ? filterComparisonChoices(choices, sourceQuery) : [];
  const commandSuggestions = !comparison && parsedCommand.kind === 'command';
  const visibleSuggestions = sourceMode ? matchingChoices.length : commandSuggestions ? 1 : 0;
  const popupOpen =
    suggestionsOpen && !controller.busy && !comparison && Boolean(sourceMode || commandSuggestions);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const settings = controller.session.document.settings;
  const messages = controller.session.document.messages;
  const tests = controller.session.document.tests;
  const proposalControls: ProposalControls = {
    ...proposalActions,
    proposals: controller.session.document.proposedTests,
  };
  // Edit cards diff the revision they made against the one before it, as History does.
  const history = controller.session.history;
  const revisionPresets = useMemo<RevisionPresets>(() => {
    const byRevision = new Map(history.map((entry) => [entry.revision, entry.preset]));
    return (revision) => {
      const after = byRevision.get(revision);
      return after ? { before: byRevision.get(revision - 1) ?? null, after } : null;
    };
  }, [history]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const { scrollToBottom } = useStickToBottom(scrollRef, conversationRef);

  useEffect(() => {
    if (controller.busy) {
      sawBusyRef.current = true;
    } else if (sawBusyRef.current) {
      sawBusyRef.current = false;
      if (restoreFocusRef.current) {
        const active = document.activeElement;
        if (active === document.body || active === null || composerRef.current?.contains(active)) {
          textareaRef.current?.focus({ preventScroll: true });
        }
      }
      restoreFocusRef.current = false;
    }
  }, [controller.busy]);

  // A report arrives from the other panel, so nothing here sent it: re-engage the follow,
  // or a reader scrolled up in the history would miss the reply starting.
  const lastMessage = messages.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the newest message id is the trigger
  useEffect(() => {
    if (lastMessage?.role === 'report') scrollToBottom();
  }, [lastMessage?.id]);

  const patchSettings = (patch: Partial<typeof settings>) =>
    controller.updateDocument((document) => ({
      ...document,
      settings: { ...document.settings, ...patch },
    }));

  const chooseSource = (choice: ComparisonChoice) => {
    setComparison(choice);
    setDraft(preservedFocus);
    setSuggestionsOpen(false);
    setCommandError('');
    setSuggestionIndex(0);
    textareaRef.current?.focus({ preventScroll: true });
  };

  const submit = async () => {
    const text = draft.trim();
    if (controller.busy) return;
    if (!comparison && text.startsWith('/')) {
      const parsed = compareCommandDraft(draft);
      if (parsed.kind === 'command' && !parsed.completing) {
        setDraft('/compare ');
        setSuggestionsOpen(true);
      } else {
        setCommandError(
          parsed.kind === 'source'
            ? 'Choose a preset from the suggestions before comparing.'
            : parsed.kind === 'invalid'
              ? parsed.error
              : 'Choose a command from the suggestions.',
        );
      }
      return;
    }
    if ((toolCapability === false && !comparison) || !controller.assistantConnection) return;
    if (comparison) {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        restoreFocusRef.current = true;
        scrollToBottom();
        await controller.compare(comparison.source, comparison.label, text);
        setComparison(null);
        setPreservedFocus('');
        setDraft('');
        setCommandError('');
        scrollToBottom();
      } catch (failure) {
        setCommandError((failure as Error).message);
      } finally {
        submittingRef.current = false;
      }
      return;
    }
    if (!text) return;
    restoreFocusRef.current = true;
    setDraft('');
    // Sending is a request to watch the answer, even from halfway up the history.
    scrollToBottom();
    await controller.send(text);
  };

  // Tool results render as cards between the messages around them, in conversation order.
  const toolCards = new Map(
    correlateToolMessages(messages).map((exchange) => [exchange.id, exchange]),
  );
  // While the model works between provider requests (a patch landing, a read), the
  // streaming bubble's status word names the phase instead of sitting mute.
  const workingNote =
    lastMessage?.role === 'tool' && lastMessage.toolName === 'patch_preset'
      ? 'applied an edit, continuing'
      : 'thinking';

  return (
    <div className="preset-cc-assistant" ref={scrollRef}>
      <details className="preset-cc-setup">
        <summary>Assistant model and instructions</summary>
        <div className="preset-cc-setup__body">
          <PresetModelSettings
            label="Co-Creator model"
            value={settings.assistant}
            connections={connections}
            requireTools
            onCapabilityChange={onToolCapabilityChange}
            onChange={(assistant) => patchSettings({ assistant })}
          />
          <label className="field">
            <span className="wc-label">Additional instructions</span>
            <textarea
              className="wc-textarea"
              rows={4}
              value={settings.assistantInstructions}
              placeholder="Preferences for this design session…"
              onChange={(event) => patchSettings({ assistantInstructions: event.target.value })}
            />
          </label>
        </div>
      </details>

      <div className="preset-cc-assistant__conversation" aria-live="polite" ref={conversationRef}>
        {messages.length === 0 && settings.assistant.connectionId === null ? (
          <div className="wc-empty">
            Choose a native tool-capable model, then describe what you want to improve.
          </div>
        ) : null}
        {messages.map((message) => {
          if (message.role === 'tool') {
            const exchange = toolCards.get(message.id);
            return exchange ? (
              <ToolActivityCard
                exchange={exchange}
                proposalControls={proposalControls}
                revisionPresets={revisionPresets}
                key={message.id}
              />
            ) : null;
          }
          if (message.role === 'report') {
            if (message.batch) {
              const batch = message.batch;
              const timestamp = formatTimestamp(new Date(message.created).toISOString());
              return (
                <article className="message" data-role="report" key={message.id}>
                  <div className="message__bubble">
                    <header className="message__head">
                      <div className="message__avatar">
                        <span aria-hidden="true">Y</span>
                      </div>
                      <div className="message__ident">
                        <span className="message__name">You</span>
                        <span className="message__badge">shared {batch.reports.length} tests</span>
                        {timestamp ? (
                          <time
                            className="message__time"
                            dateTime={timestamp.iso}
                            title={timestamp.full}
                          >
                            {timestamp.short}
                          </time>
                        ) : null}
                      </div>
                    </header>
                    {batch.note ? (
                      <blockquote className="preset-cc-report__note">{batch.note}</blockquote>
                    ) : null}
                    <ol className="preset-cc-report__batch-items">
                      {batch.reports.map((report) => (
                        <li key={report.id}>
                          <strong>{report.testTitle ?? 'Saved test'}</strong>
                          <span>
                            {report.presetUsed
                              ? describePresetUsed(report.presetUsed)
                              : 'Working draft'}
                          </span>
                          {report.replyText ? (
                            <p>
                              {report.replyText.slice(0, 180)}
                              {report.replyText.length > 180 ? '…' : ''}
                            </p>
                          ) : null}
                          {report.note ? <blockquote>{report.note}</blockquote> : null}
                        </li>
                      ))}
                    </ol>
                    <details className="preset-cc-tool__raw">
                      <summary>Full batch</summary>
                      <pre>{JSON.stringify(batch, null, 2)}</pre>
                    </details>
                  </div>
                </article>
              );
            }
            // The report is the user's turn, so it reads as one: who sent it, which test
            // and reply it covers, what it carries, and their note — the JSON on request.
            const report = message.report;
            const summary = report ? summarizeReport(report, tests) : null;
            const timestamp = formatTimestamp(new Date(message.created).toISOString());
            const through =
              summary?.replyNumber === 0
                ? 'the greeting'
                : summary?.replyNumber
                  ? `reply ${summary.replyNumber}`
                  : null;
            return (
              <article className="message" data-role="report" key={message.id}>
                <div className="message__bubble">
                  <header className="message__head">
                    <div className="message__avatar">
                      <span aria-hidden="true">Y</span>
                    </div>
                    <div className="message__ident">
                      <span className="message__name">You</span>
                      <span className="message__badge">shared a test</span>
                      {timestamp ? (
                        <time
                          className="message__time"
                          dateTime={timestamp.iso}
                          title={timestamp.full}
                        >
                          {timestamp.short}
                        </time>
                      ) : null}
                    </div>
                  </header>
                  {summary ? (
                    <p className="preset-cc-report__source">
                      <strong>{summary.testTitle ?? 'A deleted test'}</strong>
                      {through ? ` — through ${through}` : ''}
                      {report?.presetUsed
                        ? ` · ${describePresetUsed(report.presetUsed)}`
                        : summary.revision !== null
                          ? ` · rev ${summary.revision}`
                          : ''}
                    </p>
                  ) : null}
                  {summary?.sections.length ? (
                    <div className="preset-cc-report__chips">
                      {summary.sections.map((section) => (
                        <span key={section}>{section}</span>
                      ))}
                    </div>
                  ) : null}
                  {report?.note.trim() ? (
                    <blockquote className="preset-cc-report__note">{report.note.trim()}</blockquote>
                  ) : null}
                  <details className="preset-cc-tool__raw">
                    <summary>Full report</summary>
                    <pre>{JSON.stringify(report, null, 2)}</pre>
                  </details>
                </div>
              </article>
            );
          }
          const timestamp = formatTimestamp(new Date(message.created).toISOString());
          const model =
            message.role === 'assistant' && controller.assistantConnection
              ? controller.assistantConnection.model
              : null;
          return (
            <article className="message" data-role={message.role} key={message.id}>
              <div className="message__bubble">
                <header className="message__head">
                  <div className="message__avatar">
                    {message.role === 'assistant' ? (
                      <WandIcon />
                    ) : (
                      <span aria-hidden="true">
                        {message.role === 'user' ? 'You'.slice(0, 1) : '?'}
                      </span>
                    )}
                  </div>
                  <div className="message__ident">
                    <span className="message__name">
                      {message.role === 'user' ? 'You' : 'Co-Creator'}
                    </span>
                    {timestamp ? (
                      <time
                        className="message__time"
                        dateTime={timestamp.iso}
                        title={timestamp.full}
                      >
                        {timestamp.short}
                      </time>
                    ) : null}
                    {model ? (
                      <span className="message__provider" title={model}>
                        <PlugIcon />
                        <span className="wc-visually-hidden">{model}</span>
                      </span>
                    ) : null}
                  </div>
                  {!controller.busy ? (
                    <div className="message__tools">
                      <button
                        type="button"
                        className="wc-button wc-button--ghost message__action"
                        onClick={() => {
                          setEditingId(message.id);
                          setEditingText(message.comparison?.focus ?? message.content);
                        }}
                        title="Edit"
                        aria-label="Edit"
                      >
                        <EditIcon />
                      </button>
                    </div>
                  ) : null}
                </header>
                {message.reasoning ? <Reasoning text={message.reasoning} /> : null}
                {editingId === message.id ? (
                  <div className="message__editor">
                    <textarea
                      className="wc-textarea"
                      rows={Math.min(20, Math.max(3, editingText.split('\n').length + 1))}
                      value={editingText}
                      onChange={(event) => setEditingText(event.target.value)}
                    />
                    <div className="message__editor-actions">
                      <button
                        type="button"
                        className="wc-button wc-button--primary"
                        onClick={() => {
                          controller.editMessage(message.id, editingText);
                          setEditingId(null);
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="wc-button wc-button--ghost"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : message.comparison ? (
                  <ComparisonCard comparison={message.comparison} />
                ) : (
                  <Markdown text={message.content} className="message__text" />
                )}
              </div>
            </article>
          );
        })}
        {controller.busy && !controller.preparing ? (
          <StreamingBubble
            name="Co-Creator"
            initial="C"
            reasoning={controller.streamingReasoning}
            text={controller.streamingText}
            note={workingNote}
          />
        ) : null}
      </div>

      <div
        className="preset-cc-composer"
        data-busy={controller.busy || undefined}
        ref={composerRef}
      >
        {comparison ? (
          <div className="preset-cc-composer__selection">
            <span>
              Current draft · revision {controller.session.draftRevision} →{' '}
              <strong>{comparison.label}</strong>
            </span>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              onClick={() => {
                setPreservedFocus(draft);
                setComparison(null);
                setDraft('/compare ');
                setSuggestionsOpen(true);
                textareaRef.current?.focus({ preventScroll: true });
              }}
            >
              Change
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              aria-label="Remove comparison selection"
              onClick={() => {
                setPreservedFocus(draft);
                setComparison(null);
                setDraft('/compare ');
                setSuggestionsOpen(true);
                textareaRef.current?.focus({ preventScroll: true });
              }}
            >
              ×
            </button>
          </div>
        ) : null}
        {commandError ? (
          <div className="preset-cc-inline-error preset-cc-composer__error" role="alert">
            {commandError}
          </div>
        ) : null}
        <div className="preset-cc-composer__field">
          <Popover
            label={sourceMode ? 'Choose a preset to compare' : 'Slash commands'}
            icon={null}
            open={popupOpen}
            onOpenChange={setSuggestionsOpen}
            role="listbox"
            placement="top-start"
            className="preset-cc-composer__popover"
            popupClassName="preset-cc-composer__suggestions"
            renderTrigger={(trigger) => (
              <textarea
                {...trigger}
                ref={(node) => {
                  trigger.ref(node);
                  textareaRef.current = node;
                }}
                className="wc-textarea"
                rows={3}
                value={draft}
                disabled={controller.busy}
                placeholder={
                  comparison
                    ? 'Optional focus for this comparison…'
                    : 'Ask for an improvement, or type / for commands…'
                }
                aria-autocomplete="list"
                aria-activedescendant={
                  popupOpen && visibleSuggestions ? `${suggestionId}-${suggestionIndex}` : undefined
                }
                onFocus={() => {
                  if (draft.trimStart().startsWith('/') && !comparison) setSuggestionsOpen(true);
                }}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setCommandError('');
                  setSuggestionIndex(0);
                  setSuggestionsOpen(event.target.value.trimStart().startsWith('/') && !comparison);
                }}
                onKeyDown={(event) => {
                  if (
                    popupOpen &&
                    visibleSuggestions &&
                    (event.key === 'ArrowDown' || event.key === 'ArrowUp')
                  ) {
                    event.preventDefault();
                    setSuggestionIndex(
                      (index) =>
                        (index + (event.key === 'ArrowDown' ? 1 : visibleSuggestions - 1)) %
                        visibleSuggestions,
                    );
                    return;
                  }
                  if (
                    popupOpen &&
                    visibleSuggestions &&
                    (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))
                  ) {
                    event.preventDefault();
                    if (sourceMode) chooseSource(matchingChoices[suggestionIndex]!);
                    else {
                      setDraft('/compare ');
                      setSuggestionsOpen(true);
                      setSuggestionIndex(0);
                    }
                    return;
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            )}
          >
            {sourceMode ? (
              matchingChoices.length ? (
                <div className="preset-cc-composer__choice-list">
                  {(['Reference presets', 'My presets', 'Session revisions'] as const).map(
                    (group) => {
                      const members = matchingChoices.filter((choice) => choice.group === group);
                      return members.length ? (
                        <fieldset key={group} className="preset-cc-composer__choice-group">
                          <legend className="preset-cc-composer__group-label">{group}</legend>
                          {members.map((choice) => {
                            const index = matchingChoices.indexOf(choice);
                            return (
                              <button
                                type="button"
                                role="option"
                                aria-selected={suggestionIndex === index}
                                id={`${suggestionId}-${index}`}
                                className={`composer__slash-item${suggestionIndex === index ? ' composer__slash-item--active' : ''}`}
                                key={choice.key}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => chooseSource(choice)}
                              >
                                <span className="composer__slash-name">{choice.label}</span>
                                <span className="composer__slash-desc">{choice.detail}</span>
                              </button>
                            );
                          })}
                        </fieldset>
                      ) : null;
                    },
                  )}
                </div>
              ) : (
                <div className="preset-cc-composer__empty">
                  No matching presets. Add a reference or change your search.
                </div>
              )
            ) : (
              <button
                type="button"
                role="option"
                aria-selected="true"
                id={`${suggestionId}-0`}
                className="composer__slash-item composer__slash-item--active"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setDraft('/compare ');
                  setSuggestionsOpen(true);
                }}
              >
                <span className="composer__slash-name">/{PRESET_SLASH_COMMANDS[0].name}</span>
                <span className="composer__slash-desc">{PRESET_SLASH_COMMANDS[0].description}</span>
                <span className="composer__slash-usage">{PRESET_SLASH_COMMANDS[0].usage}</span>
              </button>
            )}
          </Popover>
        </div>
        {controller.preparing ? (
          <button
            type="button"
            className="wc-button wc-button--ghost"
            disabled
            title="Loading and saving the comparison snapshots."
          >
            Preparing…
          </button>
        ) : controller.busy ? (
          <button type="button" className="wc-button wc-button--danger" onClick={controller.stop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="wc-button wc-button--primary"
            disabled={
              (!comparison && !draft.trim()) ||
              (toolCapability === false && !comparison) ||
              !controller.assistantConnection
            }
            title={
              !controller.assistantConnection
                ? 'Choose a Co-Creator model first.'
                : toolCapability === false && !comparison
                  ? 'The selected provider reports that this model does not support tools.'
                  : undefined
            }
            onClick={() => void submit()}
          >
            {comparison ? 'Compare' : 'Send'}
          </button>
        )}
      </div>
    </div>
  );
}
