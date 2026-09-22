import { greetingTexts } from '@shared/chat/message.ts';
import { createDisplayRegexMacros, resolveGreetingMacros } from '@shared/prompt/greeting.ts';
import type { Connection } from '@shared/providers/types.ts';
import { regexDepths } from '@shared/regex/depth.ts';
import { applyRegexScripts, createRegexCompileCache } from '@shared/regex/engine.ts';
import type { CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type { MacroVariableMap, Persona } from '@shared/types/chat.ts';
import type { ProposedPresetTest } from '@shared/types/preset-cocreator.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import { REGEX_PLACEMENT } from '@shared/types/regex.ts';
import type { LorebookSummary, WorldInfoBook, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronIcon,
  ChevronLeftIcon,
  EditIcon,
  MessagesIcon,
  NotesIcon,
  PlugIcon,
  RefreshIcon,
  SearchIcon,
} from '../../layout/icons.tsx';
import { characterApi, lorebookApi } from '../../lib/api.ts';
import { formatTimestamp } from '../chat/formatDate.ts';
import { Markdown } from '../chat/Markdown.tsx';
import { Reasoning } from '../chat/Reasoning.tsx';
import { useStickToBottom } from '../chat/useStickToBottom.ts';
import '../chat/MessageBubble.css';
import { composeLorebookSources } from '../lore/useLorebooks.ts';
import { PresetModelSettings } from './PresetModelSettings.tsx';
import { ProposalTray } from './ProposalTray.tsx';
import { StreamingBubble } from './StreamingBubble.tsx';
import type { PresetCocreatorController } from './usePresetCocreator.ts';
import type { PresetTestingController } from './usePresetTesting.ts';

interface PresetTestingPanelProps {
  controller: PresetCocreatorController;
  testing: PresetTestingController;
  connections: readonly Connection[];
  characters: readonly CharacterSummary[];
  personas: readonly Persona[];
  books: readonly LorebookSummary[];
  initialCharacterId?: string | null;
  initialPersonaId?: string | null;
  globalLorebookIds: readonly string[];
  worldInfoSettings: WorldInfoSettings;
  globalVariables: MacroVariableMap;
  regexScripts: readonly RegexScript[];
  /** Why the Co-Creator cannot take a turn right now — a report starts one. */
  coCreatorBlockedReason: string | null;
  /** A report went out and the Co-Creator is answering it on the left. */
  onReportSent: () => void;
  /** Why a proposed test cannot run right now; shared with the Co-Creator's cards. */
  proposalBlockedReason: string | null;
}

export function PresetTestingPanel({
  controller,
  testing,
  connections,
  characters,
  personas,
  books,
  initialCharacterId,
  initialPersonaId,
  globalLorebookIds,
  worldInfoSettings,
  globalVariables,
  regexScripts,
  coCreatorBlockedReason,
  onReportSent,
  proposalBlockedReason,
}: PresetTestingPanelProps) {
  const [characterId, setCharacterId] = useState(initialCharacterId ?? characters[0]?.avatar ?? '');
  const [character, setCharacter] = useState<CharacterDetail | null>(null);
  const [greetingIndex, setGreetingIndex] = useState(0);
  const [personaId, setPersonaId] = useState(initialPersonaId ?? '');
  const [loreIds, setLoreIds] = useState<string[]>([...globalLorebookIds]);
  const [regexIds, setRegexIds] = useState<string[]>(regexScripts.map((script) => script.id));
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [shareNote, setShareNote] = useState('');
  const [shareTranscript, setShareTranscript] = useState(true);
  const [sharePrompt, setSharePrompt] = useState(true);
  const [shareDiagnostics, setShareDiagnostics] = useState(true);
  // The proposal whose text was loaded into the message box: sending then runs it.
  const [composerProposalId, setComposerProposalId] = useState<string | null>(null);
  // State, not a ref, so the resize observer below re-attaches when the dock first mounts.
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [lastShared, setLastShared] = useState<{ messageId: string; at: number } | null>(null);
  const shareRef = useRef<HTMLElement>(null);
  const shareNoteRef = useRef<HTMLTextAreaElement>(null);
  const [inspectRequest, setInspectRequest] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLDetailsElement>(null);
  const { scrollToBottom, isFollowing } = useStickToBottom(scrollRef, bodyRef);

  useEffect(() => {
    if (!characterId) {
      setCharacter(null);
      return;
    }
    let cancelled = false;
    setSetupError('');
    void characterApi
      .get(characterId)
      .then((detail) => {
        if (!cancelled) {
          setCharacter(detail);
          setGreetingIndex(0);
        }
      })
      .catch((failure) => {
        if (!cancelled) setSetupError((failure as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [characterId]);

  const patchTestingSettings = (
    testingSettings: typeof controller.session.document.settings.testing,
  ) =>
    controller.updateDocument((document) => ({
      ...document,
      settings: { ...document.settings, testing: testingSettings },
    }));

  const snapshotScenario = async () => {
    if (!character) {
      setSetupError('Choose a character card first.');
      return;
    }
    setSetupBusy(true);
    setSetupError('');
    try {
      const persona = personas.find((entry) => entry.id === personaId) ?? null;
      const linked =
        typeof character.card.data.extensions?.world === 'string'
          ? character.card.data.extensions.world
          : null;
      const wanted = new Set(loreIds);
      if (linked) wanted.add(linked);
      if (persona?.lorebookId) wanted.add(persona.lorebookId);
      const loaded: Record<string, WorldInfoBook> = {};
      await Promise.all(
        [...wanted].map(async (id) => {
          if (!books.some((book) => book.id === id)) return;
          loaded[id] = await lorebookApi.get(id);
        }),
      );
      const sources = composeLorebookSources({
        character: character.card.data,
        linkedName: linked,
        loaded,
        globalIds: loreIds,
        personaId: persona?.lorebookId ?? undefined,
      });
      testing.start(
        {
          characterId: character.avatar,
          character: structuredClone(character.card.data),
          greetingIndex,
          persona: persona ? structuredClone(persona) : null,
          worldInfoSources: structuredClone(sources),
          worldInfoSettings: structuredClone(worldInfoSettings),
          regexScripts: structuredClone(
            regexScripts.filter((script) => regexIds.includes(script.id)),
          ),
          variables: { local: {}, global: structuredClone(globalVariables) },
        },
        `${character.name} · ${new Date().toLocaleTimeString()}`,
      );
    } catch (failure) {
      setSetupError((failure as Error).message);
    } finally {
      setSetupBusy(false);
    }
  };

  const test = testing.activeTest;
  const latestAssistant = test
    ? ([...test.messages].reverse().find((message) => !message.is_user) ?? null)
    : null;
  const hasOldRevisions = Boolean(
    test?.messages.some(
      (message) =>
        !message.is_user &&
        typeof message.extra?.preset_revision === 'number' &&
        message.extra.preset_revision !== controller.session.draftRevision,
    ),
  );
  const pendingProposals = controller.session.document.proposedTests.filter(
    (proposal) => proposal.status === 'pending',
  );
  const greetings = character ? greetingTexts(character.card.data) : [];
  const display = useMemo(() => {
    const rendered = new Map<string, string>();
    const reasoning = new Map<string, string>();
    if (!test) return { texts: rendered, reasoning };
    const options = {
      character: test.scenario.character,
      preset: controller.session.current.preset,
      persona: test.scenario.persona,
      messages: test.messages,
      metadata: { variables: test.localVariables },
      globalVariables: test.globalVariables,
      seed: test.id,
    };
    const first = test.messages[0];
    if (first && !first.is_user) {
      rendered.set(first.id, resolveGreetingMacros(first.mes, options));
    }
    if (!test.scenario.regexScripts.length) return { texts: rendered, reasoning };
    const depths = regexDepths(test.messages);
    const regexOptions = {
      macros: createDisplayRegexMacros(options),
      cache: createRegexCompileCache(),
    };
    for (const message of test.messages) {
      const context = {
        placement: message.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
        display: true,
        depth: depths.get(message.id),
      };
      const source = rendered.get(message.id) ?? message.mes;
      rendered.set(
        message.id,
        applyRegexScripts(source, test.scenario.regexScripts, context, regexOptions),
      );
      // The thinking runs through its own placement, exactly as the main chat does it.
      const thinking = message.extra?.reasoning;
      if (typeof thinking === 'string' && thinking) {
        reasoning.set(
          message.id,
          applyRegexScripts(
            thinking,
            test.scenario.regexScripts,
            { ...context, placement: REGEX_PLACEMENT.REASONING },
            regexOptions,
          ),
        );
      }
    }
    return { texts: rendered, reasoning };
  }, [controller.session.current.preset, test]);

  // A different conversation starts at its newest reply, whatever the last one was showing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the test id is the trigger
  useEffect(() => {
    scrollToBottom();
  }, [test?.id, scrollToBottom]);

  // Asking to inspect a reply means showing the inspector, which sits below the transcript.
  // The panel's own offset rather than scrollIntoView, which also scrolls the clipped
  // workspace ancestors and slides the whole header off the top of the screen.
  useEffect(() => {
    const scroller = scrollRef.current;
    const inspector = inspectorRef.current;
    if (!inspectRequest || !scroller || !inspector) return;
    scroller.scrollTop +=
      inspector.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, [inspectRequest]);

  // A turn can start from the tray or from the Co-Creator's card on the left, not only
  // from this composer — whoever sent it, the reader should see it land.
  const lastTestMessage = test?.messages.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the newest message id is the trigger
  useEffect(() => {
    if (lastTestMessage?.is_user) scrollToBottom();
  }, [lastTestMessage?.id]);

  /*
   * The dock is sticky over the transcript, so when it grows — a proposal arriving, an
   * error line — it covers the end of the conversation. The stick-to-bottom hook only
   * watches the transcript itself, so the dock's own growth re-pins here.
   */
  useEffect(() => {
    if (!dock) return;
    let lastHeight = dock.offsetHeight;
    const observer = new ResizeObserver(() => {
      const height = dock.offsetHeight;
      if (height === lastHeight) return;
      lastHeight = height;
      if (isFollowing.current) scrollToBottom();
    });
    observer.observe(dock);
    return () => observer.disconnect();
  }, [dock, isFollowing, scrollToBottom]);

  const composerProposal =
    pendingProposals.find((proposal) => proposal.id === composerProposalId) ?? null;
  // Loading a proposal replaces the message box, so it must never overwrite words of yours.
  const draftIsPristine =
    !draft.trim() || (composerProposal !== null && draft === composerProposal.message);
  const editBlockedReason = !test
    ? 'Start a test scenario first.'
    : !draftIsPristine
      ? 'The message box has a draft — send or clear it first.'
      : null;

  const editProposal = (proposal: ProposedPresetTest) => {
    if (editBlockedReason) return;
    setDraft(proposal.message);
    setComposerProposalId(proposal.id);
    composerRef.current?.focus({ preventScroll: true });
  };

  const runProposal = (proposal: ProposedPresetTest, text = proposal.message) => {
    if (proposalBlockedReason) return;
    scrollToBottom();
    void testing.runProposal(proposal, text);
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    scrollToBottom();
    if (composerProposal) {
      setComposerProposalId(null);
      void testing.runProposal(composerProposal, text);
      return;
    }
    void testing.send(text);
  };

  const shareBlockedReason =
    coCreatorBlockedReason ?? (testing.busy ? 'Wait for the test reply to finish.' : null);

  const share = () => {
    if (!latestAssistant || shareBlockedReason) return;
    const report = testing.share({
      throughMessageId: latestAssistant.id,
      note: shareNote,
      includeTranscript: shareTranscript,
      includePrompt: sharePrompt,
      includeDiagnostics: shareDiagnostics,
    });
    if (!report) return;
    setShareOpen(false);
    setShareNote('');
    setLastShared({ messageId: latestAssistant.id, at: report.created });
    onReportSent();
  };

  /*
   * The form opens below the transcript, under the sticky composer's edge — it used to
   * appear out of sight. Scroll just far enough to show all of it above the composer, in
   * the panel's own scroller, and put the caret in the note.
   */
  useEffect(() => {
    const scroller = scrollRef.current;
    const section = shareRef.current;
    if (!shareOpen || !scroller || !section) return;
    const visibleBottom =
      scroller.getBoundingClientRect().bottom - (dock?.getBoundingClientRect().height ?? 0);
    const overflow = section.getBoundingClientRect().bottom - visibleBottom;
    if (overflow > 0) scroller.scrollTop += overflow;
    shareNoteRef.current?.focus({ preventScroll: true });
  }, [shareOpen, dock]);

  const sharedTime =
    lastShared && lastShared.messageId === latestAssistant?.id
      ? formatTimestamp(new Date(lastShared.at).toISOString())
      : null;

  return (
    <div className="preset-cc-testing" ref={scrollRef}>
      <details className="preset-cc-setup" open={!test}>
        <summary>Scenario and testing model</summary>
        <div className="preset-cc-setup__body">
          <PresetModelSettings
            label="Testing model"
            value={controller.session.document.settings.testing}
            connections={connections}
            onChange={patchTestingSettings}
          />
          <div className="preset-cc-scenario">
            <label className="field">
              <span className="wc-label">Character card</span>
              <select
                className="wc-select"
                value={characterId}
                onChange={(event) => setCharacterId(event.target.value)}
              >
                <option value="">Choose a card</option>
                {characters.map((entry) => (
                  <option key={entry.avatar} value={entry.avatar}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="wc-label">Greeting</span>
              <select
                className="wc-select"
                value={greetingIndex}
                disabled={!greetings.length}
                onChange={(event) => setGreetingIndex(Number(event.target.value))}
              >
                {greetings.map((greeting, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional greeting list
                  <option key={`${index}:${greeting.slice(0, 20)}`} value={index}>
                    {index === 0 ? 'Primary' : `Alternate ${index}`} · {greeting.slice(0, 52)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="wc-label">Persona</span>
              <select
                className="wc-select"
                value={personaId}
                onChange={(event) => setPersonaId(event.target.value)}
              >
                <option value="">No persona</option>
                {personas.map((persona) => (
                  <option key={persona.id} value={persona.id}>
                    {persona.name}
                    {persona.variantLabel ? ` · ${persona.variantLabel}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend className="wc-label">Lorebooks</legend>
              {books.length ? (
                books.map((book) => (
                  <label className="preset-cc-check" key={book.id}>
                    <input
                      type="checkbox"
                      checked={loreIds.includes(book.id)}
                      onChange={(event) =>
                        setLoreIds((current) =>
                          event.target.checked
                            ? [...current, book.id]
                            : current.filter((id) => id !== book.id),
                        )
                      }
                    />
                    {book.name}
                  </label>
                ))
              ) : (
                <span className="wc-hint">No standalone lorebooks.</span>
              )}
            </fieldset>
            <fieldset>
              <legend className="wc-label">Regex scripts</legend>
              {regexScripts.length ? (
                regexScripts.map((script) => (
                  <label className="preset-cc-check" key={script.id}>
                    <input
                      type="checkbox"
                      checked={regexIds.includes(script.id)}
                      onChange={(event) =>
                        setRegexIds((current) =>
                          event.target.checked
                            ? [...current, script.id]
                            : current.filter((id) => id !== script.id),
                        )
                      }
                    />
                    {script.scriptName}
                  </label>
                ))
              ) : (
                <span className="wc-hint">No regex scripts.</span>
              )}
            </fieldset>
            <button
              type="button"
              className="wc-button wc-button--primary"
              disabled={!character || setupBusy}
              onClick={() => void snapshotScenario()}
            >
              {test ? 'Snapshot as new test' : 'Start test'}
            </button>
            <p className="wc-hint">
              The card, greeting, persona, lore, regex, and variables are copied into the test.
              Later library edits cannot change it.
            </p>
          </div>
        </div>
        {setupError ? <p className="preset-cc-inline-error">{setupError}</p> : null}
      </details>

      {controller.session.document.tests.length ? (
        <div className="preset-cc-test-history">
          <label className="wc-label" htmlFor="preset-cc-test-select">
            Saved conversation
          </label>
          <select
            id="preset-cc-test-select"
            className="wc-select"
            value={test?.id ?? ''}
            onChange={(event) => testing.setActive(event.target.value)}
          >
            {controller.session.document.tests.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="wc-button wc-button--ghost"
            disabled={!test || testing.busy}
            onClick={() => testing.restart()}
          >
            Restart
          </button>
        </div>
      ) : null}

      {/* Only the transcript region is watched for growth. The composer and the controls
          below it stay direct children of the scroller so the composer's sticky edge spans
          the whole panel, not just this box. */}
      <div className="preset-cc-test-body" ref={bodyRef}>
        {test ? (
          <>
            {hasOldRevisions ? (
              <p className="preset-cc-revision-warning">
                This conversation contains replies generated with older preset revisions.
              </p>
            ) : null}
            <div className="preset-cc-transcript">
              {test.messages.map((message) => {
                const revision = message.extra?.preset_revision;
                const model = message.extra?.model;
                const timestamp = formatTimestamp(message.send_date);
                const isLatest = message.id === latestAssistant?.id;
                const swipes = message.swipes?.length ?? 1;
                const swipeIndex = message.swipe_id ?? 0;
                return (
                  <article
                    className="message preset-cc-test-message"
                    data-role={message.is_user ? 'user' : 'assistant'}
                    key={message.id}
                  >
                    <div className="message__bubble">
                      <header className="message__head">
                        <div className="message__avatar">
                          <span aria-hidden="true">{message.name.slice(0, 1).toUpperCase()}</span>
                        </div>
                        <div className="message__ident">
                          <span className="message__name">{message.name}</span>
                          {timestamp ? (
                            <time
                              className="message__time"
                              dateTime={timestamp.iso}
                              title={timestamp.full}
                            >
                              {timestamp.short}
                            </time>
                          ) : null}
                          {!message.is_user && typeof revision === 'number' ? (
                            <span
                              className="message__badge"
                              title={`Generated with preset revision ${revision}${
                                revision !== controller.session.draftRevision
                                  ? ' — older than the current draft'
                                  : ''
                              }`}
                            >
                              rev {revision}
                              {revision !== controller.session.draftRevision ? ' · old' : ''}
                            </span>
                          ) : null}
                          {!message.is_user && model ? (
                            <span className="message__provider" title={String(model)}>
                              <PlugIcon />
                              <span className="wc-visually-hidden">{String(model)}</span>
                            </span>
                          ) : null}
                        </div>
                        {!testing.busy ? (
                          <div className="message__tools">
                            <button
                              type="button"
                              className="wc-button wc-button--ghost message__action"
                              onClick={() => {
                                setEditingId(message.id);
                                setEditingText(message.mes);
                              }}
                              title="Edit"
                              aria-label="Edit"
                            >
                              <EditIcon />
                            </button>
                            {!message.is_user && message.extra?.preset_test_evidence_id ? (
                              <button
                                type="button"
                                className="wc-button wc-button--ghost message__action"
                                onClick={() => {
                                  testing.inspect(String(message.extra?.preset_test_evidence_id));
                                  setInspectorOpen(true);
                                  setInspectRequest((count) => count + 1);
                                }}
                                title="Inspect the assembled request"
                                aria-label="Inspect"
                              >
                                <SearchIcon />
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </header>
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
                                testing.editMessage(message.id, editingText);
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
                            <span className="wc-hint">Edits are never macro-resolved</span>
                          </div>
                        </div>
                      ) : (
                        <>
                          {!message.is_user &&
                          typeof message.extra?.reasoning === 'string' &&
                          message.extra.reasoning ? (
                            <Reasoning
                              text={message.extra.reasoning}
                              displayText={display.reasoning.get(message.id)}
                            />
                          ) : null}
                          <Markdown
                            text={display.texts.get(message.id) ?? message.mes}
                            className="message__text"
                          />
                        </>
                      )}
                      {!editingId && isLatest && !message.is_user ? (
                        <footer className="message__foot">
                          <div className="message__swipes">
                            <button
                              type="button"
                              className="wc-button wc-button--ghost message__action"
                              onClick={() => void testing.swipe(-1)}
                              disabled={testing.busy || swipeIndex === 0}
                              data-invisible={swipeIndex === 0 || undefined}
                              aria-label="Previous alternative"
                              title="Previous alternative"
                            >
                              <ChevronLeftIcon />
                            </button>
                            <span className="message__swipe-count">
                              {swipeIndex + 1}/{swipes}
                            </span>
                            <button
                              type="button"
                              className="wc-button wc-button--ghost message__action"
                              onClick={() => void testing.swipe(1)}
                              disabled={testing.busy}
                              aria-label="Next alternative, or generate one"
                              title={
                                swipeIndex === swipes - 1
                                  ? 'Generate another alternative'
                                  : 'Next alternative'
                              }
                            >
                              <ChevronIcon />
                            </button>
                            <button
                              type="button"
                              className="wc-button wc-button--ghost message__action"
                              disabled={testing.busy}
                              onClick={() => void testing.regenerate()}
                              title="Regenerate — replaces the reply and drops its alternates"
                            >
                              <RefreshIcon />
                            </button>
                          </div>
                        </footer>
                      ) : null}
                    </div>
                  </article>
                );
              })}
              {testing.busy ? (
                <StreamingBubble
                  name={test.scenario.character.name}
                  initial={test.scenario.character.name}
                  reasoning={testing.streamingReasoning}
                  text={testing.streamingText}
                  note="thinking"
                />
              ) : null}
            </div>
          </>
        ) : (
          <div className="wc-empty">Snapshot a scenario to begin a multi-turn test.</div>
        )}
      </div>

      {test ? (
        <>
          <div className="preset-cc-test-controls">
            {sharedTime ? (
              <span className="preset-cc-shared-status" role="status">
                Sent to Co-Creator · {sharedTime.short}
                {controller.busy ? ' · replying on the left' : ''}
              </span>
            ) : (
              <span className="wc-hint">
                Swipes, regenerate and retry live on the latest reply.
              </span>
            )}
            <button
              type="button"
              className="wc-button wc-button--ghost"
              disabled={!latestAssistant}
              onClick={() => setShareOpen(true)}
            >
              <MessagesIcon /> Send to Co-Creator
            </button>
          </div>

          {shareOpen ? (
            <section className="preset-cc-share" ref={shareRef}>
              <h3>Share immutable test report</h3>
              <label className="preset-cc-check">
                <input
                  type="checkbox"
                  checked={shareTranscript}
                  onChange={(event) => setShareTranscript(event.target.checked)}
                />
                Visible conversation
              </label>
              <label className="preset-cc-check">
                <input
                  type="checkbox"
                  checked={sharePrompt}
                  onChange={(event) => setSharePrompt(event.target.checked)}
                />
                Actual assembled prompt and effective request
              </label>
              <label className="preset-cc-check">
                <input
                  type="checkbox"
                  checked={shareDiagnostics}
                  onChange={(event) => setShareDiagnostics(event.target.checked)}
                />
                Diagnostics and token accounting
              </label>
              <textarea
                ref={shareNoteRef}
                className="wc-textarea"
                rows={3}
                value={shareNote}
                placeholder="What should the Co-Creator look at? Optional…"
                onChange={(event) => setShareNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    share();
                  }
                }}
              />
              <div className="preset-cc-share__actions">
                <button
                  type="button"
                  className="wc-button wc-button--primary"
                  disabled={Boolean(shareBlockedReason)}
                  title={shareBlockedReason ?? undefined}
                  onClick={share}
                >
                  Send report
                </button>
                <button
                  type="button"
                  className="wc-button wc-button--ghost"
                  onClick={() => setShareOpen(false)}
                >
                  Cancel
                </button>
                <span className="wc-hint">
                  {shareBlockedReason ?? 'The Co-Creator replies as soon as it is sent.'}
                </span>
              </div>
            </section>
          ) : null}

          {testing.inspectedEvidence ? (
            <details
              className="preset-cc-inspector"
              ref={inspectorRef}
              open={inspectorOpen}
              onToggle={(event) => setInspectorOpen(event.currentTarget.open)}
            >
              <summary>
                Request inspector · revision {testing.inspectedEvidence.draftRevision}
              </summary>
              <dl>
                <dt>Model</dt>
                <dd>{testing.inspectedEvidence.model}</dd>
                <dt>Status</dt>
                <dd>{testing.inspectedEvidence.status}</dd>
                <dt>Prompt tokens</dt>
                <dd>
                  {testing.inspectedEvidence.promptTokens ?? testing.inspectedEvidence.totalTokens}
                </dd>
                <dt>Completion tokens</dt>
                <dd>
                  {testing.inspectedEvidence.completionTokens ?? 'estimated in transcript only'}
                </dd>
                <dt>Dropped history</dt>
                <dd>{testing.inspectedEvidence.droppedMessages}</dd>
              </dl>
              {testing.inspectedEvidence.error ? (
                <p className="preset-cc-inline-error">{testing.inspectedEvidence.error}</p>
              ) : null}
              <details>
                <summary>Assembled messages</summary>
                <pre>{JSON.stringify(testing.inspectedEvidence.messages, null, 2)}</pre>
              </details>
              <details>
                <summary>Effective request</summary>
                <pre>{JSON.stringify(testing.inspectedEvidence.body, null, 2)}</pre>
              </details>
              <details>
                <summary>Activated lore and warnings</summary>
                <pre>
                  {JSON.stringify(
                    {
                      worldInfo: testing.inspectedEvidence.worldInfo,
                      macroWarnings: testing.inspectedEvidence.macroWarnings,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </details>
          ) : null}
        </>
      ) : null}

      {/* One sticky dock for everything you act on next: the proposals, any error, and the
          composer. The error used to render below the composer's sticky edge, out of view. */}
      <div className="preset-cc-dock" ref={setDock}>
        <ProposalTray
          proposals={pendingProposals}
          editingId={composerProposal?.id ?? null}
          blockedReason={proposalBlockedReason}
          editBlockedReason={editBlockedReason}
          onRun={(proposal) => runProposal(proposal)}
          onEdit={editProposal}
          onDismiss={testing.dismissProposal}
          onDismissAll={testing.dismissAllProposals}
        />
        {testing.error ? <p className="preset-cc-inline-error">{testing.error}</p> : null}
        {test ? (
          <>
            {composerProposal ? (
              <div className="preset-cc-dock__attached">
                <NotesIcon className="preset-cc-icon-sm" />
                <span>
                  Sending runs the proposed test
                  {composerProposal.restart ? ' in a fresh conversation' : ''}.
                </span>
                <button
                  type="button"
                  className="wc-button wc-button--ghost"
                  title="Keep the text, but send it as an ordinary message"
                  onClick={() => setComposerProposalId(null)}
                >
                  Detach
                </button>
              </div>
            ) : null}
            <div className="preset-cc-composer" data-busy={testing.busy || undefined}>
              <div className="preset-cc-composer__field">
                <textarea
                  ref={composerRef}
                  className="wc-textarea"
                  rows={3}
                  value={draft}
                  disabled={testing.busy}
                  placeholder={`Message ${test.scenario.character.name}…`}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    // Emptying the box lets go of the proposal it was holding.
                    if (!event.target.value.trim()) setComposerProposalId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
              </div>
              {testing.busy ? (
                <button
                  type="button"
                  className="wc-button wc-button--danger"
                  onClick={testing.stop}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="wc-button wc-button--primary"
                  disabled={!draft.trim()}
                  onClick={send}
                >
                  {composerProposal ? 'Run' : 'Send'}
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
