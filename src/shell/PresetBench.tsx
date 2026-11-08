/**
 * The bench: test chats that run the preset, each frozen on its card, persona and lore.
 *
 * After the Co-Creator edits, a test says its replies ran on an older revision and offers to
 * rerun the last one; the rerun lands beside the old reply, before and after. Every reply
 * can be sent back to the Co-Creator with a note, the prompt and the diagnostics. Nothing
 * here spends money on its own.
 */

import { greetingTexts } from '@shared/chat/message.ts';
import { createDisplayRegexMacros, resolveGreetingMacros } from '@shared/prompt/greeting.ts';
import {
  getPromptById,
  getPromptOrder,
  setPromptOrder,
  updatePrompt,
} from '@shared/prompt/preset-io.ts';
import { regexDepths } from '@shared/regex/depth.ts';
import { applyRegexScripts, createRegexCompileCache } from '@shared/regex/engine.ts';
import type { CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type { ChatMessage, MacroVariableMap, Persona } from '@shared/types/chat.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type {
  PresetTest,
  PresetTestSource,
  ProposedPresetTest,
  ReferencePresetSummary,
} from '@shared/types/preset-cocreator.ts';
import { REGEX_PLACEMENT, type RegexScript } from '@shared/types/regex.ts';
import type { LorebookSummary, WorldInfoBook, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Popover } from '../components/Popover.tsx';
import { Markdown } from '../features/chat/Markdown.tsx';
import { Reasoning } from '../features/chat/Reasoning.tsx';
import type { StreamStore } from '../features/chat/state/streamStore.ts';
import { useStickToBottom } from '../features/chat/useStickToBottom.ts';
import { composeLorebookSources } from '../features/lore/useLorebooks.ts';
import { findJsonProblem, formatJsonProblem } from '../features/preset-cocreator/jsonProblem.ts';
import { NO_CARD_DEFAULT_NAME, noCardCharacter } from '../features/preset-cocreator/testing.ts';
import { presetTestSourceKey } from '../features/preset-cocreator/testingSources.ts';
import type { PresetCocreatorController } from '../features/preset-cocreator/usePresetCocreator.ts';
import type { PresetTestingController } from '../features/preset-cocreator/usePresetTesting.ts';
import { characterApi, lorebookApi, personaApi } from '../lib/api.ts';
import { Avatar } from './Avatar.tsx';
import { Switch } from './controls.tsx';
import { Icon } from './icons.tsx';
import type { PromptSheet } from './PresetRail.tsx';
import { CompareSheet, InspectSheet } from './PresetSheets.tsx';
import {
  formatUsd,
  latestReply,
  type Price,
  replyCost,
  rerunPair,
  staleRevision,
  swipeEvidence,
  wasSentBack,
} from './presetcc.ts';

const NO_CARD = '\u0000no-card';

export interface PresetBenchProps {
  controller: PresetCocreatorController;
  testing: PresetTestingController;
  sheet: PromptSheet | null;
  onOpenSheet: (sheet: PromptSheet) => void;
  onCloseSheet: () => void;
  presets: readonly PresetSummary[];
  references: readonly ReferencePresetSummary[];
  characters: readonly CharacterSummary[];
  personas: readonly Persona[];
  personaAvatarVersions: Record<string, string | number>;
  books: readonly LorebookSummary[];
  activeCharacterId: string | null;
  activePersonaId: string | null;
  globalLorebookIds: readonly string[];
  worldInfoSettings: WorldInfoSettings;
  globalVariables: MacroVariableMap;
  regexScripts: readonly RegexScript[];
  modelName: string | null;
  priceOf: (connectionId: string, model: string) => Price | null;
  /** Why a reply can't be sent back right now: it starts a Co-Creator turn. */
  coCreatorBlocked: string | null;
}

export function PresetBench(props: PresetBenchProps) {
  const { controller, testing } = props;
  const { session } = controller;
  const tests = session.document.tests;
  const test = testing.activeTest;
  const pending = session.document.proposedTests.filter((p) => p.status === 'pending');

  return (
    <section className="w3-pc-col w3-pc-bench" aria-label="Bench">
      <div className="w3-pc-col__head">
        <h3>Bench</h3>
        <small>{props.modelName ?? 'No model'}</small>
      </div>
      {props.sheet?.kind === 'inspect' ? (
        <InspectSheet
          key={props.sheet.evidenceId}
          {...inspected(tests, props.sheet.testId, props.sheet.evidenceId)}
          nameOf={(identifier) =>
            session.current.preset.prompts?.find((p) => p.identifier === identifier)?.name ||
            identifier
          }
          onClose={props.onCloseSheet}
        />
      ) : props.sheet?.kind === 'compare' ? (
        <CompareSheet
          label={props.sheet.label}
          here={props.sheet.here}
          there={props.sheet.there}
          revision={props.sheet.revision}
          onClose={props.onCloseSheet}
        />
      ) : props.sheet ? (
        <PromptEditor
          key={props.sheet.kind === 'prompt' ? props.sheet.identifier : 'json'}
          sheet={props.sheet}
          preset={session.current.preset}
          busy={controller.busy}
          onApply={async (preset, summary) => {
            await controller.replaceDraft(preset, summary);
            props.onCloseSheet();
          }}
          onClose={props.onCloseSheet}
        />
      ) : (
        <>
          <div className="w3-pc-testbar">
            <div className="w3-pc-tests">
              {tests.map((entry) => (
                <TestTab
                  key={entry.id}
                  test={entry}
                  active={entry.id === test?.id}
                  stale={staleRevision(entry, session.draftRevision) !== null}
                  characters={props.characters}
                  busy={testing.busy}
                  onPick={() => testing.setActive(entry.id)}
                />
              ))}
            </div>
            <NewTest {...props} />
          </div>
          {test ? <Scenario {...props} test={test} /> : null}
          {pending.length ? (
            <Proposal {...props} proposal={pending.at(-1)!} more={pending.length - 1} />
          ) : null}
          {test ? (
            <TestChat {...props} test={test} />
          ) : (
            <div className="w3-pc-benchempty">
              <p>Start a test: pick a card and the bench chats with it on your draft.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function inspected(tests: readonly PresetTest[], testId: string, evidenceId: string) {
  const test = tests.find((entry) => entry.id === testId);
  const evidence = test?.evidence.find((entry) => entry.id === evidenceId) ?? null;
  const name = test?.scenario.character.name || NO_CARD_DEFAULT_NAME;
  return { evidence, title: `${name}’s reply` };
}

// ---------- Tests ----------

function cardFace(characters: readonly CharacterSummary[], test: PresetTest) {
  const id = test.scenario.characterId;
  const card = id ? characters.find((c) => c.avatar === id) : null;
  return card
    ? characterApi.imageUrl(card.avatar, card.modified)
    : id
      ? characterApi.imageUrl(id)
      : null;
}

function TestTab({
  test,
  active,
  stale,
  characters,
  busy,
  onPick,
}: {
  test: PresetTest;
  active: boolean;
  stale: boolean;
  characters: readonly CharacterSummary[];
  busy: boolean;
  onPick: () => void;
}) {
  const name = test.scenario.character.name || NO_CARD_DEFAULT_NAME;
  const title = test.title.replace(/ · \d{1,2}:\d{2}(:\d{2})?( ?[AP]M)?$/i, '');
  return (
    <button
      type="button"
      className="w3-pc-ttab"
      aria-pressed={active}
      disabled={busy && !active}
      title={`${test.title}${stale ? ' · ran on an older revision' : ''}`}
      onClick={onPick}
    >
      <Avatar url={cardFace(characters, test)} name={name} size="xs" />
      <span>{title === name ? name : title}</span>
      {stale ? <i className="w3-pc-dot" /> : null}
    </button>
  );
}

/** A new test: which card, as whom, which greeting, which lore. Frozen once it starts. */
function NewTest(props: PresetBenchProps) {
  const { testing } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [characterId, setCharacterId] = useState(
    props.testing.activeTest?.scenario.characterId ??
      props.activeCharacterId ??
      props.characters[0]?.avatar ??
      NO_CARD,
  );
  const [detail, setDetail] = useState<CharacterDetail | null>(null);
  const [greeting, setGreeting] = useState(0);
  const [personaId, setPersonaId] = useState(
    props.testing.activeTest?.scenario.persona?.id ?? props.activePersonaId ?? '',
  );
  const [loreIds, setLoreIds] = useState<string[]>([...props.globalLorebookIds]);
  const [regexOn, setRegexOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open || characterId === NO_CARD) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void characterApi
      .get(characterId)
      .then((loaded) => {
        if (cancelled) return;
        setDetail(loaded);
        setGreeting(0);
      })
      .catch((err) => !cancelled && setProblem((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [open, characterId]);

  const greetings = detail ? greetingTexts(detail.card.data) : [];
  const linked =
    detail && typeof detail.card.data.extensions?.world === 'string'
      ? detail.card.data.extensions.world
      : null;
  const matches = props.characters
    .filter((c) => !query.trim() || c.name.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 30);

  const start = async () => {
    if (characterId !== NO_CARD && !detail) return;
    setBusy(true);
    setProblem(null);
    try {
      const persona = props.personas.find((p) => p.id === personaId) ?? null;
      const card = detail ? detail.card.data : noCardCharacter(NO_CARD_DEFAULT_NAME);
      const wanted = new Set(loreIds);
      if (linked) wanted.add(linked);
      if (persona?.lorebookId) wanted.add(persona.lorebookId);
      const loaded: Record<string, WorldInfoBook> = {};
      await Promise.all(
        [...wanted].map(async (id) => {
          if (props.books.some((book) => book.id === id)) loaded[id] = await lorebookApi.get(id);
        }),
      );
      const sources = composeLorebookSources({
        character: card,
        linkedName: linked,
        loaded,
        globalIds: loreIds,
        personaId: persona?.lorebookId ?? undefined,
      });
      testing.start(
        {
          characterId: detail ? detail.avatar : null,
          character: structuredClone(card),
          greetingIndex: detail ? greeting : 0,
          persona: persona ? structuredClone(persona) : null,
          worldInfoSources: structuredClone(sources),
          worldInfoSettings: structuredClone(props.worldInfoSettings),
          regexScripts: regexOn ? structuredClone([...props.regexScripts]) : [],
          variables: { local: {}, global: structuredClone(props.globalVariables) },
        },
        detail ? detail.name : NO_CARD_DEFAULT_NAME,
      );
      setOpen(false);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      label="New test"
      icon={null}
      open={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      role="dialog"
      popupClassName="w3-pc-newtest"
      renderTrigger={(trigger) => (
        <button
          {...trigger}
          type="button"
          className="w3-pc-ttab w3-pc-ttab--add"
          disabled={testing.busy}
          onClick={() => setOpen(!open)}
        >
          <Icon name="plus" size="xs" />
          New test
        </button>
      )}
    >
      <div className="w3-pc-newtest__body">
        <p className="w3-pc-newtest__label">Card</p>
        <label className="w3-st-search">
          <Icon name="search" size="sm" />
          <input
            value={query}
            placeholder="Which card?"
            aria-label="Find a card"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="w3-pc-cards" role="listbox" aria-label="Cards">
          {matches.map((c) => (
            <button
              key={c.avatar}
              type="button"
              role="option"
              aria-selected={c.avatar === characterId}
              onClick={() => setCharacterId(c.avatar)}
            >
              <Avatar url={characterApi.imageUrl(c.avatar, c.modified)} name={c.name} size="xs" />
              {c.name}
            </button>
          ))}
          <button
            type="button"
            role="option"
            aria-selected={characterId === NO_CARD}
            onClick={() => setCharacterId(NO_CARD)}
          >
            <Avatar url={null} name="?" size="xs" />
            No card
          </button>
        </div>
        {greetings.length > 1 ? (
          <>
            <p className="w3-pc-newtest__label">Greeting</p>
            <div className="w3-pc-chips">
              {greetings.map((_, at) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: greetings are positional
                  key={at}
                  type="button"
                  aria-pressed={at === greeting}
                  onClick={() => setGreeting(at)}
                >
                  {at === 0 ? 'First' : `Alternate ${at}`}
                </button>
              ))}
            </div>
          </>
        ) : null}
        <p className="w3-pc-newtest__label">You are</p>
        <div className="w3-pc-chips">
          <button type="button" aria-pressed={!personaId} onClick={() => setPersonaId('')}>
            No persona
          </button>
          {props.personas.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={p.id === personaId}
              onClick={() => setPersonaId(p.id)}
            >
              {p.name}
              {p.variantLabel ? ` · ${p.variantLabel}` : ''}
            </button>
          ))}
        </div>
        {props.books.length ? (
          <>
            <p className="w3-pc-newtest__label">
              Lore{linked ? <small> · {linked} comes with the card</small> : null}
            </p>
            <div className="w3-pc-chips">
              {props.books
                .filter((book) => book.id !== linked)
                .map((book) => (
                  <button
                    key={book.id}
                    type="button"
                    aria-pressed={loreIds.includes(book.id)}
                    onClick={() =>
                      setLoreIds((ids) =>
                        ids.includes(book.id)
                          ? ids.filter((id) => id !== book.id)
                          : [...ids, book.id],
                      )
                    }
                  >
                    {book.name}
                  </button>
                ))}
            </div>
          </>
        ) : null}
        {props.regexScripts.length ? (
          <div className="w3-pc-newtest__row">
            <span>Your regex scripts</span>
            <Switch label="Run your regex scripts" on={regexOn} onChange={setRegexOn} />
          </div>
        ) : null}
        {problem ? <p className="w3-pc-problem">{problem}</p> : null}
        <button
          type="button"
          className="w3-st-pill w3-co-pill"
          disabled={busy || (characterId !== NO_CARD && !detail)}
          onClick={() => void start()}
        >
          Start the test
        </button>
      </div>
    </Popover>
  );
}

/** What the test is frozen on, and which preset it runs. */
function Scenario(props: PresetBenchProps & { test: PresetTest }) {
  const { test, testing, controller } = props;
  const scenario = test.scenario;
  const persona = scenario.persona;
  const books = scenario.worldInfoSources.length;
  const greetings = greetingTexts(scenario.character).length;
  const [sourceOpen, setSourceOpen] = useState(false);
  const source = test.presetSource;
  const sourceLabel =
    source.kind === 'draft'
      ? 'Runs the draft'
      : source.kind === 'revision'
        ? `Runs revision ${source.revision}`
        : source.kind === 'library'
          ? `Runs ${props.presets.find((p) => p.id === source.id)?.name ?? source.id}`
          : `Runs ${props.references.find((r) => r.id === source.id)?.name ?? source.id}`;
  const options: { source: PresetTestSource; label: string; group: string }[] = [
    { source: { kind: 'draft' }, label: 'The draft', group: '' },
    ...[...controller.session.history]
      .filter((entry) => entry.revision < controller.session.draftRevision)
      .reverse()
      .map((entry) => ({
        source: { kind: 'revision', revision: entry.revision } as PresetTestSource,
        label: `Revision ${entry.revision}${entry.summary ? ` · ${entry.summary}` : ''}`,
        group: 'Earlier revisions',
      })),
    ...props.presets.map((p) => ({
      source: { kind: 'library', id: p.id } as PresetTestSource,
      label: p.name,
      group: 'Your presets',
    })),
    ...props.references.map((r) => ({
      source: { kind: 'reference', id: r.id } as PresetTestSource,
      label: r.name,
      group: 'References',
    })),
  ];
  const personaUrl = persona?.avatar
    ? personaApi.avatarUrl(persona.id, props.personaAvatarVersions[persona.id] ?? persona.avatar)
    : null;

  return (
    <div className="w3-pc-scenario">
      <span className="w3-pc-sc" title="Frozen when the test started. New test to change it.">
        <Avatar url={cardFace(props.characters, test)} name={scenario.character.name} size="xs" />
        {scenario.character.name || NO_CARD_DEFAULT_NAME}
      </span>
      <span className="w3-pc-sc" title="Frozen when the test started">
        <Avatar url={personaUrl} name={persona?.name ?? 'You'} size="xs" who="me" />
        {persona?.name ?? 'No persona'}
      </span>
      {books ? (
        <span
          className="w3-pc-sc w3-pc-sc--plain"
          title={scenario.worldInfoSources.map((s) => s.name).join(', ')}
        >
          <Icon name="book" size="xs" />
          {books} {books === 1 ? 'book' : 'books'}
        </span>
      ) : null}
      {greetings > 1 ? (
        <span className="w3-pc-sc w3-pc-sc--plain">
          Greeting {scenario.greetingIndex + 1} of {greetings}
        </span>
      ) : null}
      <Popover
        label="Which preset this test runs"
        icon={null}
        open={sourceOpen}
        onOpenChange={setSourceOpen}
        placement="bottom-start"
        role="listbox"
        popupClassName="w3-pc-lenspop"
        renderTrigger={(trigger) => (
          <button
            {...trigger}
            type="button"
            className="w3-pc-sc w3-pc-sc--plain w3-pc-sc--btn"
            data-other={source.kind !== 'draft' || undefined}
            disabled={testing.busy}
            onClick={() => setSourceOpen(!sourceOpen)}
          >
            {sourceLabel}
            <Icon name="chevronDown" size="xs" />
          </button>
        )}
      >
        <div className="w3-pc-lenspop__list">
          {options.map((option, at) => (
            <div key={presetTestSourceKey(option.source)}>
              {option.group && option.group !== options[at - 1]?.group ? (
                <p>{option.group}</p>
              ) : null}
              <button
                type="button"
                role="option"
                aria-selected={presetTestSourceKey(option.source) === presetTestSourceKey(source)}
                onClick={() => {
                  testing.setPresetSource(option.source);
                  setSourceOpen(false);
                }}
              >
                <b>{option.label}</b>
              </button>
            </div>
          ))}
        </div>
      </Popover>
      <span className="w3-co-gap" />
      <button
        type="button"
        className="w3-pc-headbtn"
        disabled={testing.busy}
        title="The same card, persona and lore, from the greeting again, as a new test"
        onClick={() => testing.restart()}
      >
        <Icon name="rewind" size="xs" />
        Start over
      </button>
    </div>
  );
}

function Proposal(props: PresetBenchProps & { proposal: ProposedPresetTest; more: number }) {
  const { proposal, testing } = props;
  const blocked = !testing.activeTest
    ? 'Start a test first'
    : testing.busy
      ? 'Wait for the reply to finish'
      : null;
  return (
    <div className="w3-pc-proposal">
      <div className="w3-pc-proposal__head">
        <Icon name="chat" size="xs" />
        <span>Suggested by the Co-Creator{props.more ? ` · ${props.more} more` : ''}</span>
        <span className="w3-co-gap" />
        <button
          type="button"
          className="w3-pc-x"
          aria-label="Dismiss the suggestion"
          onClick={() => testing.dismissProposal(proposal.id)}
        >
          <Icon name="close" size="xs" />
        </button>
      </div>
      <q>{proposal.message}</q>
      {proposal.rationale ? <p>{proposal.rationale}</p> : null}
      <div className="w3-pc-proposal__acts">
        <button
          type="button"
          className="w3-st-pill w3-co-pill w3-pc-pill--sm"
          disabled={Boolean(blocked)}
          title={
            blocked ??
            (proposal.restart ? 'Runs in a fresh chat with this test’s card' : 'Runs in this test')
          }
          onClick={() => void testing.runProposal(proposal, proposal.message)}
        >
          Run
        </button>
        <small>{proposal.restart ? 'In a fresh chat' : 'In this test'}</small>
      </div>
    </div>
  );
}

// ---------- The chat ----------

function TestChat(props: PresetBenchProps & { test: PresetTest }) {
  const { test, testing, controller } = props;
  const draftRevision = controller.session.draftRevision;
  const stale = staleRevision(test, draftRevision);
  const pair = rerunPair(test);
  const reply = latestReply(test);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { scrollToBottom } = useStickToBottom(scrollRef, bodyRef);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new test or a new message re-anchors
  useEffect(() => {
    scrollToBottom();
  }, [test.id, test.messages.length]);

  const preset = controller.session.current.preset;
  const display = useDisplay(test, preset);
  const evidence = reply ? swipeEvidence(test, reply) : null;
  const estimate = evidence
    ? replyCost(evidence, props.priceOf(evidence.connectionId, evidence.model))
    : null;

  return (
    <>
      {stale !== null && !testing.busy ? (
        <div className="w3-pc-stale">
          <i className="w3-pc-dot" />
          <span>
            Ran on <b>revision {stale}</b>. The draft is now {draftRevision}.
          </span>
          <span className="w3-co-gap" />
          {estimate !== null ? <small>about {formatUsd(estimate)}</small> : null}
          <button
            type="button"
            className="w3-st-pill w3-co-pill w3-pc-pill--sm"
            onClick={() => void testing.rerun()}
          >
            <Icon name="refresh" size="xs" />
            Rerun on revision {draftRevision}
          </button>
        </div>
      ) : null}
      <div className="w3-co-scroll w3-pc-chatscroll" ref={scrollRef}>
        <div className="w3-pc-chat" ref={bodyRef}>
          {test.messages.map((message) => (
            <TestMessage
              key={message.id}
              {...props}
              message={message}
              text={display.get(message.id) ?? message.mes}
              latest={message === reply && message === test.messages.at(-1)}
              pair={pair && pair.messageId === message.id ? pair : null}
              display={(text) => display.apply(text, message)}
            />
          ))}
          {testing.busy ? (
            <StreamingReply
              store={testing.stream}
              name={test.scenario.character.name}
              url={cardFace(props.characters, test)}
            />
          ) : null}
        </div>
      </div>
      {testing.error ? <p className="w3-co-error w3-pc-bencherr">{testing.error}</p> : null}
      <div className="w3-pc-benchbox">
        <textarea
          rows={1}
          value={test.composerDraft}
          disabled={testing.busy}
          placeholder={`Write as ${test.scenario.persona?.name ?? 'yourself'}`}
          aria-label="Your next message in the test"
          onChange={(event) => testing.setComposerDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              const text = test.composerDraft.trim();
              if (text && !testing.busy) void testing.send(text);
            }
          }}
        />
        {testing.busy ? (
          <button
            type="button"
            className="w3-pc-benchsend"
            aria-label="Stop"
            onClick={testing.stop}
          >
            <Icon name="stop" size="sm" />
          </button>
        ) : (
          <button
            type="button"
            className="w3-pc-benchsend"
            aria-label="Send"
            disabled={!test.composerDraft.trim() || !testing.connection}
            title={testing.connection ? undefined : 'Choose the bench’s model on the island'}
            onClick={() => void testing.send(test.composerDraft.trim())}
          >
            <Icon name="send" size="sm" />
          </button>
        )}
      </div>
    </>
  );
}

/** Greeting macros and display regex, as the chat shows them. */
function useDisplay(test: PresetTest, preset: Preset) {
  const { messages, scenario, localVariables, globalVariables, id } = test;
  return useMemo(() => {
    const options = {
      character: scenario.character,
      preset,
      persona: scenario.persona,
      messages,
      metadata: { variables: localVariables },
      globalVariables,
      seed: id,
    };
    const depths = regexDepths(messages);
    const regexOptions = {
      macros: createDisplayRegexMacros(options),
      cache: createRegexCompileCache(),
    };
    const apply = (text: string, message: ChatMessage) =>
      scenario.regexScripts.length
        ? applyRegexScripts(
            text,
            scenario.regexScripts,
            {
              placement: message.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
              display: true,
              depth: depths.get(message.id),
            },
            regexOptions,
          )
        : text;
    const texts = new Map<string, string>();
    messages.forEach((message, at) => {
      const source =
        at === 0 && !message.is_user ? resolveGreetingMacros(message.mes, options) : message.mes;
      texts.set(message.id, apply(source, message));
    });
    return { get: (key: string) => texts.get(key), apply };
  }, [messages, scenario, localVariables, globalVariables, id, preset]);
}

const TestMessage = memo(function TestMessage(
  props: PresetBenchProps & {
    test: PresetTest;
    message: ChatMessage;
    text: string;
    latest: boolean;
    pair: ReturnType<typeof rerunPair>;
    display: (text: string) => string;
  },
) {
  const { message, test, controller, latest, pair } = props;
  const persona = test.scenario.persona;
  const name = message.is_user
    ? (persona?.name ?? 'You')
    : test.scenario.character.name || NO_CARD_DEFAULT_NAME;
  const url = message.is_user
    ? persona?.avatar
      ? personaApi.avatarUrl(persona.id, props.personaAvatarVersions[persona.id] ?? persona.avatar)
      : null
    : cardFace(props.characters, test);
  const evidence = !message.is_user ? swipeEvidence(test, message) : null;
  const greeting = !message.is_user && test.messages.indexOf(message) === 0 && !evidence;
  const swipes = message.swipes?.length ?? 1;
  const reasoning = typeof message.extra?.reasoning === 'string' ? message.extra.reasoning : '';

  return (
    <div className="w3-pc-cm" data-me={message.is_user || undefined}>
      <div className="w3-pc-cm__who">
        <Avatar url={url} name={name} size="xs" who={message.is_user ? 'me' : 'char'} />
        <b>{name}</b>
        {greeting ? (
          <span className="w3-pc-rev">greeting</span>
        ) : evidence ? (
          <button
            type="button"
            className="w3-pc-rev"
            data-old={
              test.presetSource.kind === 'draft' &&
              evidence.draftRevision < controller.session.draftRevision
                ? true
                : undefined
            }
            title="See the prompt and request this reply went out with"
            onClick={() =>
              props.onOpenSheet({ kind: 'inspect', testId: test.id, evidenceId: evidence.id })
            }
          >
            {evidence.presetUsed?.source.kind && evidence.presetUsed.source.kind !== 'draft'
              ? evidence.presetUsed.label
              : `revision ${evidence.draftRevision}`}
            <Icon name="inspect" size="xs" />
          </button>
        ) : null}
      </div>
      {reasoning && !pair ? <Reasoning text={reasoning} /> : null}
      {pair ? (
        <>
          {pair.shared ? (
            <Markdown text={props.display(pair.shared)} className="message__text w3-pc-rp" />
          ) : null}
          <div className="w3-pc-pair">
            <div className="w3-pc-pair__side">
              <span className="w3-pc-pair__cap">
                Before <small>revision {pair.before.revision}</small>
              </span>
              <Markdown text={props.display(pair.before.text)} className="message__text w3-pc-rp" />
            </div>
            <div className="w3-pc-pair__side" data-new>
              <span className="w3-pc-pair__cap">
                After <small>revision {pair.after.revision}</small>
              </span>
              <Markdown text={props.display(pair.after.text)} className="message__text w3-pc-rp" />
            </div>
          </div>
          {pair.shared ? <p className="w3-pc-pairnote">The opening is the same in both.</p> : null}
        </>
      ) : (
        <Markdown text={props.text} className="message__text w3-pc-rp" />
      )}
      {latest && !message.is_user && !greeting ? <ReplyActions {...props} swipes={swipes} /> : null}
      {evidence && evidence.status !== 'complete' && evidence.error ? (
        <p className="w3-pc-problem">{evidence.error}</p>
      ) : null}
    </div>
  );
});

function ReplyActions(
  props: PresetBenchProps & { test: PresetTest; message: ChatMessage; swipes: number },
) {
  const { message, test, testing, controller, swipes } = props;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [prompt, setPrompt] = useState(true);
  const [diagnostics, setDiagnostics] = useState(true);
  const [transcript, setTranscript] = useState(false);
  const sent = wasSentBack(controller.session.document.messages, test.id, message);
  const queued = controller.session.document.batchQueue.items.some(
    (item) =>
      item.testId === test.id &&
      item.throughMessageId === message.id &&
      item.replyText === message.mes,
  );
  const blocked = props.coCreatorBlocked ?? (testing.busy ? 'Wait for the reply to finish.' : null);
  const at = (message.swipe_id ?? 0) + 1;

  const send = () => {
    if (blocked) return;
    testing.share({
      throughMessageId: message.id,
      note: note.trim(),
      includePrompt: prompt,
      includeDiagnostics: diagnostics,
      includeTranscript: transcript,
    });
    setOpen(false);
    setNote('');
  };

  return (
    <>
      <div className="w3-pc-acts">
        <span className="w3-co-swipe">
          <button
            type="button"
            aria-label="Previous reply"
            disabled={testing.busy || at <= 1}
            onClick={() => void testing.swipe(-1)}
          >
            <Icon name="chevronLeft" size="xs" />
          </button>
          {at}/{swipes}
          <button
            type="button"
            aria-label={at < swipes ? 'Next reply' : 'Write another reply'}
            title={at < swipes ? undefined : 'Write another reply'}
            disabled={testing.busy}
            onClick={() => void testing.swipe(1)}
          >
            <Icon name="chevronRight" size="xs" />
          </button>
        </span>
        <button
          type="button"
          className="w3-pc-act"
          disabled={testing.busy}
          onClick={() => void testing.regenerate()}
        >
          <Icon name="refresh" size="xs" />
          Regenerate
        </button>
        <span className="w3-co-gap" />
        {queued ? (
          <span
            className="w3-pc-act w3-pc-act--sent"
            title="Goes with the next message to the Co-Creator"
          >
            <Icon name="check" size="xs" />
            In the batch
          </span>
        ) : (
          <button
            type="button"
            className="w3-pc-act"
            disabled={testing.busy}
            title="Send it back together with others: it waits in the Co-Creator's box"
            onClick={() => testing.queueReply(message.id)}
          >
            <Icon name="plus" size="xs" />
            Batch
          </button>
        )}
        {sent && !open ? (
          <span className="w3-pc-act w3-pc-act--sent">
            <Icon name="check" size="xs" />
            Sent back
          </span>
        ) : (
          <button
            type="button"
            className="w3-pc-act w3-pc-act--back"
            aria-expanded={open}
            disabled={Boolean(blocked) && !open}
            title={blocked ?? 'Send this reply to the Co-Creator'}
            onClick={() => setOpen(!open)}
          >
            <Icon name="forward" size="xs" />
            Send back
          </button>
        )}
      </div>
      {open ? (
        <div className="w3-pc-sendback">
          <textarea
            rows={2}
            value={note}
            placeholder="What's wrong with it? (optional)"
            aria-label="Your note for the Co-Creator"
            // biome-ignore lint/a11y/noAutofocus: opened by asking to write the note
            autoFocus
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
              if (event.key === 'Escape') setOpen(false);
            }}
          />
          <div className="w3-pc-sendback__row">
            <button
              type="button"
              className="w3-pc-incl"
              aria-pressed={prompt}
              onClick={() => setPrompt(!prompt)}
            >
              Prompt
            </button>
            <button
              type="button"
              className="w3-pc-incl"
              aria-pressed={diagnostics}
              onClick={() => setDiagnostics(!diagnostics)}
            >
              Diagnostics
            </button>
            <button
              type="button"
              className="w3-pc-incl"
              aria-pressed={transcript}
              onClick={() => setTranscript(!transcript)}
            >
              Whole conversation
            </button>
            <span className="w3-co-gap" />
            <button
              type="button"
              className="w3-st-ghost w3-st-ghost--sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="w3-st-pill w3-co-pill w3-pc-pill--sm"
              disabled={Boolean(blocked)}
              title={blocked ?? undefined}
              onClick={send}
            >
              <Icon name="forward" size="xs" />
              Send back
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function StreamingReply({
  store,
  name,
  url,
}: {
  store: StreamStore;
  name: string;
  url: string | null;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <div className="w3-pc-cm w3-pc-streaming">
      <div className="w3-pc-cm__who">
        <Avatar url={url} name={name} size="xs" />
        <b>{name}</b>
        {snapshot.text ? null : <span className="w3-pc-working">Writing</span>}
      </div>
      {snapshot.reasoning ? <Reasoning text={snapshot.reasoning} defaultOpen /> : null}
      {snapshot.text ? (
        <div className="message__text w3-pc-rp w3-pc-stream-text">{snapshot.text}</div>
      ) : null}
    </div>
  );
}

// ---------- Editing by hand ----------

function PromptEditor({
  sheet,
  preset,
  busy,
  onApply,
  onClose,
}: {
  sheet: Extract<PromptSheet, { kind: 'prompt' | 'json' }>;
  preset: Preset;
  busy: boolean;
  onApply: (preset: Preset, summary: string) => Promise<void>;
  onClose: () => void;
}) {
  const prompt = sheet.kind === 'prompt' ? getPromptById(preset, sheet.identifier) : undefined;
  const entry =
    sheet.kind === 'prompt'
      ? getPromptOrder(preset).find((e) => e.identifier === sheet.identifier)
      : undefined;
  const [content, setContent] = useState(
    sheet.kind === 'json' ? JSON.stringify(preset, null, 4) : (prompt?.content ?? ''),
  );
  const [name, setName] = useState(prompt?.name ?? '');
  const [enabled, setEnabled] = useState(entry?.enabled !== false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const apply = async () => {
    setProblem(null);
    let next: Preset;
    let summary: string;
    if (sheet.kind === 'json') {
      const found = findJsonProblem(content);
      if (found) {
        setProblem(formatJsonProblem(found));
        return;
      }
      next = JSON.parse(content) as Preset;
      summary = 'Edited the JSON by hand';
    } else {
      if (!prompt) return;
      next = updatePrompt(preset, sheet.identifier, { content, name: name.trim() || prompt.name });
      if (entry && entry.enabled !== enabled) {
        next = setPromptOrder(
          next,
          getPromptOrder(next).map((e) =>
            e.identifier === sheet.identifier ? { ...e, enabled } : e,
          ),
        );
      }
      summary = `Edited ${name.trim() || prompt.name} by hand`;
    }
    setSaving(true);
    try {
      await onApply(next, summary);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const unchanged =
    sheet.kind === 'json'
      ? content === JSON.stringify(preset, null, 4)
      : content === (prompt?.content ?? '') &&
        name === (prompt?.name ?? '') &&
        enabled === (entry?.enabled !== false);

  return (
    <div className="w3-pc-sheet">
      <div className="w3-pc-sheet__head">
        {sheet.kind === 'json' ? (
          <b>The whole preset</b>
        ) : (
          <input
            className="w3-pc-sheet__name"
            value={name}
            aria-label="Prompt name"
            onChange={(event) => setName(event.target.value)}
          />
        )}
        <span className="w3-co-gap" />
        {sheet.kind === 'prompt' && entry ? (
          <Switch label="Send this prompt" on={enabled} onChange={setEnabled} />
        ) : null}
      </div>
      <textarea
        className="w3-pc-sheet__text"
        value={content}
        spellCheck={sheet.kind !== 'json'}
        aria-label={sheet.kind === 'json' ? 'The preset as JSON' : 'Prompt text'}
        onChange={(event) => setContent(event.target.value)}
      />
      {problem ? <p className="w3-pc-problem">{problem}</p> : null}
      <div className="w3-pc-sheet__acts">
        <span className="w3-pc-sheet__hint">Applying makes a new revision.</span>
        <span className="w3-co-gap" />
        <button type="button" className="w3-st-ghost w3-st-ghost--sm" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="w3-st-pill w3-co-pill w3-pc-pill--sm"
          disabled={busy || saving || unchanged}
          title={busy ? 'Wait for the Co-Creator to finish' : undefined}
          onClick={() => void apply()}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
