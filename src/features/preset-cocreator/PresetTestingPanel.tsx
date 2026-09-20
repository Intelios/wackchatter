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
import { useEffect, useMemo, useState } from 'react';
import { characterApi, lorebookApi } from '../../lib/api.ts';
import { Markdown } from '../chat/Markdown.tsx';
import { composeLorebookSources } from '../lore/useLorebooks.ts';
import { PresetModelSettings } from './PresetModelSettings.tsx';
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
  const [proposalText, setProposalText] = useState<Record<string, string>>({});

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
  const displayTexts = useMemo(() => {
    const rendered = new Map<string, string>();
    if (!test) return rendered;
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
    if (!test.scenario.regexScripts.length) return rendered;
    const depths = regexDepths(test.messages);
    const regexOptions = {
      macros: createDisplayRegexMacros(options),
      cache: createRegexCompileCache(),
    };
    for (const message of test.messages) {
      const source = rendered.get(message.id) ?? message.mes;
      rendered.set(
        message.id,
        applyRegexScripts(
          source,
          test.scenario.regexScripts,
          {
            placement: message.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
            display: true,
            depth: depths.get(message.id),
          },
          regexOptions,
        ),
      );
    }
    return rendered;
  }, [controller.session.current.preset, test]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void testing.send(text);
  };

  const share = () => {
    if (!latestAssistant) return;
    testing.share({
      throughMessageId: latestAssistant.id,
      note: shareNote,
      includeTranscript: shareTranscript,
      includePrompt: sharePrompt,
      includeDiagnostics: shareDiagnostics,
    });
    setShareOpen(false);
    setShareNote('');
  };

  const proposalCard = (proposal: ProposedPresetTest) => {
    const value = proposalText[proposal.id] ?? proposal.message;
    return (
      <article className="preset-cc-proposal" key={proposal.id}>
        <strong>Assistant-proposed test</strong>
        {proposal.rationale ? <p>{proposal.rationale}</p> : null}
        <textarea
          className="wc-textarea"
          rows={2}
          value={value}
          onChange={(event) =>
            setProposalText((current) => ({ ...current, [proposal.id]: event.target.value }))
          }
        />
        <p className="wc-hint">
          Run uses current draft revision {controller.session.draftRevision}
          {proposal.restart ? ' in a fresh conversation.' : ' in the active conversation.'}
        </p>
        <div className="preset-cc-proposal__actions">
          <button
            type="button"
            className="wc-button wc-button--primary"
            disabled={!test || testing.busy || !value.trim()}
            onClick={() => void testing.runProposal(proposal, value)}
          >
            Run
          </button>
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => testing.dismissProposal(proposal.id)}
          >
            Dismiss
          </button>
        </div>
      </article>
    );
  };

  return (
    <div className="preset-cc-testing">
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

      {pendingProposals.length ? (
        <div className="preset-cc-proposals">{pendingProposals.map(proposalCard)}</div>
      ) : null}

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
              return (
                <article
                  className="preset-cc-test-message"
                  data-user={message.is_user || undefined}
                  key={message.id}
                >
                  <div className="preset-cc-test-message__meta">
                    <strong>{message.name}</strong>
                    {!message.is_user && typeof revision === 'number' ? (
                      <span>
                        Revision {revision} · {String(model ?? 'unknown model')}
                      </span>
                    ) : null}
                  </div>
                  {editingId === message.id ? (
                    <div className="preset-cc-test-message__edit">
                      <textarea
                        className="wc-textarea"
                        rows={4}
                        value={editingText}
                        onChange={(event) => setEditingText(event.target.value)}
                      />
                      <button
                        type="button"
                        className="wc-button wc-button--primary"
                        onClick={() => {
                          testing.editMessage(message.id, editingText);
                          setEditingId(null);
                        }}
                      >
                        Apply edit
                      </button>
                      <button
                        type="button"
                        className="wc-button wc-button--ghost"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <Markdown
                      text={displayTexts.get(message.id) ?? message.mes}
                      className="preset-cc-test-message__text"
                    />
                  )}
                  <div className="preset-cc-test-message__actions">
                    <button
                      type="button"
                      className="wc-button wc-button--ghost"
                      disabled={testing.busy}
                      onClick={() => {
                        setEditingId(message.id);
                        setEditingText(message.mes);
                      }}
                    >
                      Edit
                    </button>
                    {!message.is_user && message.extra?.preset_test_evidence_id ? (
                      <button
                        type="button"
                        className="wc-button wc-button--ghost"
                        onClick={() =>
                          testing.inspect(String(message.extra?.preset_test_evidence_id))
                        }
                      >
                        Inspect
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
            {testing.streamingText || testing.streamingReasoning ? (
              <article className="preset-cc-test-message">
                <div className="preset-cc-test-message__meta">
                  <strong>{test.scenario.character.name}</strong>
                  <span>Generating with revision {controller.session.draftRevision}</span>
                </div>
                {testing.streamingReasoning ? (
                  <details>
                    <summary>Reasoning</summary>
                    <Markdown text={testing.streamingReasoning} />
                  </details>
                ) : null}
                <Markdown text={testing.streamingText} className="preset-cc-test-message__text" />
              </article>
            ) : null}
          </div>

          <div className="preset-cc-test-controls">
            <button
              type="button"
              className="wc-button wc-button--ghost"
              disabled={testing.busy}
              onClick={() => void testing.swipe(-1)}
            >
              ‹ Swipe
            </button>
            <span>
              {latestAssistant
                ? `${(latestAssistant.swipe_id ?? 0) + 1}/${latestAssistant.swipes?.length ?? 1}`
                : '—'}
            </span>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              disabled={testing.busy}
              onClick={() => void testing.swipe(1)}
            >
              Swipe ›
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              disabled={!latestAssistant || testing.busy}
              onClick={() => void testing.regenerate()}
            >
              Regenerate
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              disabled={!latestAssistant}
              onClick={() => setShareOpen(true)}
            >
              Send to Co-Creator
            </button>
          </div>

          {shareOpen ? (
            <section className="preset-cc-share">
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
                className="wc-textarea"
                rows={3}
                value={shareNote}
                placeholder="Optional feedback note…"
                onChange={(event) => setShareNote(event.target.value)}
              />
              <div className="preset-cc-share__actions">
                <button type="button" className="wc-button wc-button--primary" onClick={share}>
                  Send report
                </button>
                <button
                  type="button"
                  className="wc-button wc-button--ghost"
                  onClick={() => setShareOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </section>
          ) : null}

          {testing.inspectedEvidence ? (
            <details className="preset-cc-inspector" open>
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

          <div className="preset-cc-test-composer">
            <textarea
              className="wc-textarea"
              rows={3}
              value={draft}
              disabled={testing.busy}
              placeholder={`Message ${test.scenario.character.name}…`}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            {testing.busy ? (
              <button type="button" className="wc-button wc-button--danger" onClick={testing.stop}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="wc-button wc-button--primary"
                disabled={!draft.trim()}
                onClick={send}
              >
                Send
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="wc-empty">Snapshot a scenario to begin a multi-turn test.</div>
      )}
      {testing.error ? <p className="preset-cc-inline-error">{testing.error}</p> : null}
    </div>
  );
}
