import type { Connection } from '@shared/providers/types.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EditIcon, PlugIcon, WandIcon } from '../../layout/icons.tsx';
import { formatTimestamp } from '../chat/formatDate.ts';
import { Markdown } from '../chat/Markdown.tsx';
import { Reasoning } from '../chat/Reasoning.tsx';
import { useStickToBottom } from '../chat/useStickToBottom.ts';
import '../chat/MessageBubble.css';
import { correlateToolMessages } from './assistant.ts';
import { PresetModelSettings } from './PresetModelSettings.tsx';
import { StreamingBubble } from './StreamingBubble.tsx';
import { type ProposalControls, type RevisionPresets, ToolActivityCard } from './ToolActivity.tsx';
import { summarizeReport } from './testing.ts';
import type { PresetCocreatorController } from './usePresetCocreator.ts';

interface PresetAssistantPanelProps {
  controller: PresetCocreatorController;
  connections: readonly Connection[];
  /** Owned by the workspace, which also blocks shared reports on it. */
  toolCapability: boolean | null;
  onToolCapabilityChange: (supported: boolean | null) => void;
  /** Run and dismiss for the proposal cards; the proposals themselves live in the document. */
  proposalActions: Omit<ProposalControls, 'proposals'>;
}

export function PresetAssistantPanel({
  controller,
  connections,
  toolCapability,
  onToolCapabilityChange,
  proposalActions,
}: PresetAssistantPanelProps) {
  const [draft, setDraft] = useState('');
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

  const submit = () => {
    const text = draft.trim();
    if (!text || controller.busy || toolCapability === false) return;
    setDraft('');
    // Sending is a request to watch the answer, even from halfway up the history.
    scrollToBottom();
    void controller.send(text);
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
                      {summary.revision !== null ? ` · rev ${summary.revision}` : ''}
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
                          setEditingText(message.content);
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
                ) : (
                  <Markdown text={message.content} className="message__text" />
                )}
              </div>
            </article>
          );
        })}
        {controller.busy ? (
          <StreamingBubble
            name="Co-Creator"
            initial="C"
            reasoning={controller.streamingReasoning}
            text={controller.streamingText}
            note={workingNote}
          />
        ) : null}
      </div>

      <div className="preset-cc-composer" data-busy={controller.busy || undefined}>
        <div className="preset-cc-composer__field">
          <textarea
            className="wc-textarea"
            rows={3}
            value={draft}
            disabled={controller.busy}
            placeholder="Ask for an improvement, explain a problem, or discuss a shared test…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        {controller.busy ? (
          <button type="button" className="wc-button wc-button--danger" onClick={controller.stop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="wc-button wc-button--primary"
            disabled={!draft.trim() || toolCapability === false}
            title={
              toolCapability === false
                ? 'The selected provider reports that this model does not support tools.'
                : undefined
            }
            onClick={submit}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
