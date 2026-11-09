/**
 * One Character Co-Creator session in the 3.0 shell: the conversation, the card it builds
 * beside it, the side chat that slides over the conversation, and the examples as faces
 * above it.
 *
 * All behaviour is the Co-Creator's own (`useCocreator`: the reducer, saves, generation,
 * the side chat's frozen snapshot); this is markup over it, plus the two things the 3.0
 * design adds: one-click filing with a compare before anything is replaced, and Finish
 * writing back to the card a session started from.
 */

import { currentInfo, currentText, timestamp } from '@shared/chat/message.ts';
import type { DraftChoices } from '@shared/cocreator/draft.ts';
import { quoteForSideChat } from '@shared/cocreator/sideChat.ts';
import { isSlotFilled } from '@shared/cocreator/stash.ts';
import type { ModelRef, ModelSlot, ModelSlots } from '@shared/models/slots.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type {
  CardSlot,
  CocreatorSession,
  ExampleField,
  SingleCardSlot,
} from '@shared/types/cocreator.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { CoCreatorSettings } from '@shared/types/settings.ts';
import {
  forwardRef,
  type MutableRefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Popover } from '../components/Popover.tsx';
import { QuickCommandsPopover } from '../features/chat/QuickCommandsPopover.tsx';
import { useStickToBottom } from '../features/chat/useStickToBottom.ts';
import { useTranscriptWindow } from '../features/chat/useTranscriptWindow.ts';
import type { CocreatorContext } from '../features/cocreator/context.ts';
import { ExampleSetsPopover } from '../features/cocreator/ExampleSetsPopover.tsx';
import { EXAMPLE_FIELD_LABELS, EXAMPLE_FIELD_ORDER } from '../features/cocreator/examples.ts';
import {
  FinishAttempt,
  FinishConflictError,
  finishSession,
  requiredPortrait,
} from '../features/cocreator/finish.ts';
import { isAnalyseRequest } from '../features/cocreator/prompt.ts';
import { rebaseStash, renderDraftBlock } from '../features/cocreator/seed.ts';
import { parseCocreatorInput } from '../features/cocreator/slashCommands.ts';
import {
  type CocreatorAction,
  cocreatorReducer,
} from '../features/cocreator/state/cocreatorReducer.ts';
import { type UseCocreator, useCocreator } from '../features/cocreator/useCocreator.ts';
import { type LoadedExamples, useExampleCards } from '../features/cocreator/useExampleCards.ts';
import { characterApi, cocreatorApi } from '../lib/api.ts';
import type { PersistenceControls } from '../lib/autosave.ts';
import { CoCreatorCard, type Pending } from './CoCreatorCard.tsx';
import { CoCreatorMessage, type FileActions, type UseSource } from './CoCreatorMessage.tsx';
import { CoCreatorSetup } from './CoCreatorSetup.tsx';
import { filledCount } from './cocreator.ts';
import { Icon } from './icons.tsx';

/** What the island shows of the session. */
export interface DeskReport {
  context: CocreatorContext;
  contextTarget: 'main' | 'side';
  name: string;
  filled: number;
  saving: boolean;
  saveError: string | null;
  /** The session's own pick, or undefined while it follows the Co-Creator's. */
  model: ModelRef | undefined;
  /** What writes now, by name. */
  modelName: string | null;
  /** The side chat's, once it exists. */
  sideReady: boolean;
  sideModel: ModelRef | undefined;
  sideModelName: string | null;
}

/** What the island can ask of the session. */
export interface DeskHandle {
  setModel: (target: 'main' | 'side', ref: ModelRef | null) => void;
  compact: (target: 'main' | 'side') => void;
  setAutoCompaction: (target: 'main' | 'side', automatic: boolean) => void;
  stop: () => void;
}

// ---------- The composer ----------

export interface ComposerHandle {
  append: (text: string) => void;
  focus: () => void;
  clear: () => void;
}

const Composer = forwardRef<
  ComposerHandle,
  {
    label: string;
    placeholder: string;
    busy: boolean;
    busyReason: string;
    blockedReason: string | null;
    quickCommands?: CoCreatorSettings['quickCommands'];
    onQuickCommandsChange?: (commands: NonNullable<CoCreatorSettings['quickCommands']>) => void;
    sideOpen?: boolean;
    onToggleSide?: () => void;
    onSend: (text: string) => boolean;
    onStop: () => void;
  }
>(function Composer(
  {
    label,
    placeholder,
    busy,
    busyReason,
    blockedReason,
    quickCommands,
    onQuickCommandsChange,
    sideOpen,
    onToggleSide,
    onSend,
    onStop,
  },
  ref,
) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const focus = useCallback(() => input.current?.focus({ preventScroll: true }), []);
  useImperativeHandle(
    ref,
    () => ({
      append: (text) => {
        setDraft((current) => (current.trimEnd() ? `${current.trimEnd()}\n${text}` : text));
        setTimeout(focus, 0);
      },
      focus,
      clear: () => setDraft(''),
    }),
    [focus],
  );
  // Grows with what is written, up to a third of the window, then scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is the trigger
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight / 3)}px`;
  }, [draft]);
  const commandShaped = Boolean(onToggleSide) && draft.trimStart().startsWith('/');
  const blocked = commandShaped ? null : blockedReason;
  const submit = () => {
    const text = draft.trim();
    if (!text || busy || blocked) return;
    if (onSend(text)) setDraft('');
  };
  return (
    <div className="w3-co-composer">
      {quickCommands && onQuickCommandsChange ? (
        <div className="w3-co-chips">
          {quickCommands
            .filter((command) => command.text.trim())
            .map((command) => (
              <button
                key={command.id}
                type="button"
                className="w3-co-chip"
                title={command.text}
                onClick={() => {
                  setDraft((current) =>
                    current.trimEnd() ? `${current.trimEnd()}\n${command.text}` : command.text,
                  );
                  setTimeout(focus, 0);
                }}
              >
                {command.name || command.text.slice(0, 30)}
              </button>
            ))}
          <button
            ref={editRef}
            type="button"
            className="w3-co-chip w3-co-chip--edit"
            onClick={() => setEditing(true)}
          >
            {quickCommands.length ? 'Edit' : '+ Quick commands'}
          </button>
          <QuickCommandsPopover
            commands={quickCommands}
            onCommandsChange={onQuickCommandsChange}
            open={editing}
            onOpenChange={setEditing}
            triggerRef={editRef}
            placement="top-start"
            title="Co-Creator quick commands"
            hint="Named snippets that drop into the message box, ready to send."
            emptyHint="No commands yet. Try “Give me three more greetings”."
          />
        </div>
      ) : null}
      <div className="w3-co-box">
        <textarea
          ref={input}
          value={draft}
          rows={2}
          aria-label={label}
          placeholder={busy ? `${busyReason}. You can keep writing.` : (blocked ?? placeholder)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="w3-co-box__acts">
          {onToggleSide ? (
            <button
              type="button"
              className="w3-co-iconbtn"
              aria-pressed={sideOpen}
              aria-label="Side chat"
              title="Side chat · /side <question>"
              onClick={onToggleSide}
            >
              <Icon name="layers" size="sm" />
            </button>
          ) : null}
          {busy ? (
            <button
              type="button"
              className="w3-co-send"
              aria-label="Stop"
              title={`Stop · ${busyReason}`}
              onClick={onStop}
            >
              <Icon name="stop" size="sm" />
            </button>
          ) : (
            <button
              type="button"
              className="w3-co-send"
              aria-label="Send"
              disabled={!draft.trim() || Boolean(blocked)}
              title={blocked ?? 'Send'}
              onClick={submit}
            >
              <Icon name="send" size="sm" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

// ---------- Examples: faces above the conversation ----------

function Examples({
  design,
  loaded,
  characters,
  defaults,
  analysed,
  onDefaultsChange,
  onAnalyse,
}: {
  design: UseCocreator;
  loaded: LoadedExamples;
  characters: readonly CharacterSummary[];
  defaults: CoCreatorSettings;
  analysed: boolean;
  onDefaultsChange: (patch: Partial<CoCreatorSettings>) => void;
  onAnalyse: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [setsOpen, setSetsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selection = design.state.examples;
  const busy = design.busy;
  const byAvatar = useMemo(() => new Map(characters.map((c) => [c.avatar, c])), [characters]);
  const available = useMemo(() => {
    const attached = new Set(selection.cards);
    const needle = query.trim().toLowerCase();
    return characters
      .filter((c) => !attached.has(c.avatar))
      .filter((c) => !needle || c.name.toLowerCase().includes(needle))
      .slice(0, 40);
  }, [characters, selection.cards, query]);
  const url = (avatar: string) => characterApi.imageUrl(avatar, byAvatar.get(avatar)?.modified);
  const names = selection.cards.map((a) => byAvatar.get(a)?.name ?? a);
  const fields = EXAMPLE_FIELD_ORDER.filter((f) => selection.fields[f]).map((f) =>
    EXAMPLE_FIELD_LABELS[f].toLowerCase(),
  );

  return (
    <Popover
      label="Examples"
      icon={null}
      open={open}
      onOpenChange={setOpen}
      placement="bottom-start"
      role="dialog"
      popupClassName="w3-co-expop"
      renderTrigger={(props) => (
        <button {...props} type="button" className="w3-co-writing" onClick={() => setOpen(!open)}>
          {selection.cards.length ? (
            <>
              <span className="w3-co-faces">
                {selection.cards.slice(0, 4).map((avatar) => (
                  <img key={avatar} src={url(avatar)} alt="" draggable={false} />
                ))}
              </span>
              Writing like <b>{names.join(', ')}</b>
              {fields.length ? <span>· {fields.join(', ')}</span> : null}
            </>
          ) : (
            <>
              <Icon name="users" size="sm" />
              Add cards to write like
            </>
          )}
        </button>
      )}
    >
      <div className="w3-co-expop__body">
        <h4>Writing like</h4>
        {selection.cards.map((avatar) => {
          const gone = loaded.missing.includes(avatar);
          const rendered = loaded.examples.find((e) => e.avatar === avatar);
          return (
            <div key={avatar} className="w3-co-exrow" data-gone={gone || undefined}>
              <img src={url(avatar)} alt="" draggable={false} />
              <span>
                <b>{byAvatar.get(avatar)?.name ?? avatar}</b>
                <small>
                  {gone
                    ? 'No longer in your library'
                    : rendered
                      ? `${rendered.tokens.toLocaleString()} tokens`
                      : '…'}
                </small>
              </span>
              <button
                type="button"
                aria-label={`Stop writing like ${byAvatar.get(avatar)?.name ?? avatar}`}
                disabled={busy}
                onClick={() => design.dispatch({ type: 'examples/remove', avatar })}
              >
                <Icon name="close" size="xs" />
              </button>
            </div>
          );
        })}
        <label className="w3-st-search">
          <Icon name="search" size="sm" />
          <input
            value={query}
            placeholder="Add a card"
            aria-label="Find a card to add"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {query.trim() || !selection.cards.length ? (
          <div className="w3-co-expick">
            {available.length ? (
              available.map((c) => (
                <button
                  key={c.avatar}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    design.dispatch({ type: 'examples/add', avatar: c.avatar });
                    setQuery('');
                  }}
                >
                  <img
                    src={characterApi.imageUrl(c.avatar, c.modified)}
                    alt=""
                    loading="lazy"
                    draggable={false}
                  />
                  {c.name}
                </button>
              ))
            ) : (
              <p>No other card matches.</p>
            )}
          </div>
        ) : null}
        {selection.cards.length ? (
          <>
            <h4>From each</h4>
            <div className="w3-co-fields">
              {EXAMPLE_FIELD_ORDER.map((field: ExampleField) => (
                <button
                  key={field}
                  type="button"
                  className="w3-chip"
                  aria-pressed={selection.fields[field]}
                  disabled={busy}
                  onClick={() =>
                    design.dispatch({
                      type: 'examples/setField',
                      field,
                      on: !selection.fields[field],
                    })
                  }
                >
                  {EXAMPLE_FIELD_LABELS[field]}
                </button>
              ))}
            </div>
          </>
        ) : null}
        <div className="w3-co-expop__foot">
          <ExampleSetsPopover
            sets={defaults.exampleSets ?? []}
            currentCards={selection.cards}
            currentFields={selection.fields}
            characters={characters}
            open={setsOpen}
            onOpenChange={setSetsOpen}
            onApplySet={(set) =>
              design.dispatch({ type: 'examples/applySet', cards: set.cards, fields: set.fields })
            }
            onSetsChange={(exampleSets) => onDefaultsChange({ exampleSets })}
            disabled={busy}
          />
          <button
            type="button"
            className="w3-st-ghost w3-st-ghost--sm"
            disabled={busy || !selection.cards.length}
            onClick={() => {
              setOpen(false);
              onAnalyse();
            }}
          >
            {analysed ? 'Analyse again' : 'Analyse them'}
          </button>
        </div>
      </div>
    </Popover>
  );
}

// ---------- The desk ----------

export function CoCreatorDesk({
  session,
  seedName,
  defaults,
  connections,
  models,
  onModelSlotChange,
  presets,
  activePresetId,
  activePreset,
  tokenizerEncoding,
  onDefaultsChange,
  characters,
  streamingFps,
  registerPersistence,
  handle,
  onReport,
  onFinished,
  onError,
}: {
  session: CocreatorSession;
  /** The card Finish writes back to, by name; null for a new card. */
  seedName: string | null;
  defaults: CoCreatorSettings;
  connections: Connection[];
  models: ModelSlots;
  onModelSlotChange: (slot: ModelSlot, ref: ModelRef | null) => void;
  presets: PresetSummary[];
  activePresetId: string | null;
  activePreset: Preset | null;
  tokenizerEncoding?: 'auto' | 'o200k_base' | 'cl100k_base';
  onDefaultsChange: (patch: Partial<CoCreatorSettings>) => void;
  characters: readonly CharacterSummary[];
  streamingFps: number;
  registerPersistence: (controls: PersistenceControls | null) => void;
  handle: MutableRefObject<DeskHandle | null>;
  onReport: (report: DeskReport) => void;
  onFinished: (avatar: string) => void;
  onError: (message: string) => void;
}) {
  const exampleBlockRef = useRef('');
  const examplesReadyRef = useRef(false);
  const mainRef = useRef<ComposerHandle>(null);
  const sideRef = useRef<ComposerHandle>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [sideError, setSideError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [lit, setLit] = useState<CardSlot | null>(null);
  const [finishing, setFinishing] = useState(false);
  const finishingRef = useRef(false);
  const finishAttempt = useRef<FinishAttempt | null>(null);
  const [finishReview, setFinishReview] = useState<FinishConflictError | null>(null);
  const [finishChoices, setFinishChoices] = useState<DraftChoices>({});
  const [armedReset, setArmedReset] = useState(false);

  const design = useCocreator({
    session,
    defaults,
    connections,
    models,
    presets,
    activePresetId,
    activePreset,
    tokenizerEncoding,
    exampleBlockRef,
    examplesReadyRef,
    streamingFps,
  });
  const { state, blockedReason, countTokens } = design;
  const busy =
    design.busy ||
    finishing ||
    Boolean(finishAttempt.current?.result) ||
    state.sessionId !== session.id;
  const loaded = useExampleCards(state.examples, countTokens);
  exampleBlockRef.current = loaded.text;
  examplesReadyRef.current = !loaded.loading;
  useEffect(() => design.refreshContext(loaded.text), [loaded.text, design.refreshContext]);
  const stateRef = useRef(state);
  stateRef.current = state;
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft changes invalidate choices made against the previous draft
  useEffect(() => {
    setFinishReview(null);
    setFinishChoices({});
  }, [state.stash, state.avatar, state.targetAvatar]);
  const busyReason = design.compacting
    ? 'Compacting the conversation'
    : state.activeConversation === 'side'
      ? 'The side chat is writing'
      : 'The Co-Creator is writing';

  useEffect(() => {
    registerPersistence({
      ...design.persistence,
      flush: async () => {
        if (finishingRef.current) throw new Error('Wait for Finish to complete before leaving.');
        await design.persistence.flush();
        if (finishAttempt.current?.result && !finishAttempt.current.recorded)
          throw new Error(
            'The character was saved, but the session still needs to be recorded. Retry finishing before leaving.',
          );
      },
    });
    return () => registerPersistence(null);
  }, [design.persistence, registerPersistence]);

  const name = state.stash.name?.text.trim() || session.title;
  const filled = filledCount(state.stash);
  const model = state.settings.model;
  const modelName = design.connection?.model ?? null;
  const sideReady = Boolean(state.sideChat);
  const sideModel = state.sideChat?.settings.model;
  const sideModelName = design.sideConnection?.model ?? null;
  const context = sideOpen ? design.sideCompactionContext : design.mainContext;
  useEffect(() => {
    onReport({
      context,
      contextTarget: sideOpen ? 'side' : 'main',
      name,
      filled,
      saving: design.saving,
      saveError: design.saveError,
      model,
      modelName,
      sideReady,
      sideModel,
      sideModelName,
    });
  }, [
    onReport,
    name,
    filled,
    design.saving,
    design.saveError,
    model,
    modelName,
    sideReady,
    sideModel,
    sideModelName,
    context,
    sideOpen,
  ]);
  handle.current = {
    compact: (target) => {
      void design.compact(target);
    },
    setAutoCompaction: design.setAutoCompaction,
    stop: design.abort,
    setModel: (target, ref) =>
      design.dispatch(
        target === 'main'
          ? { type: 'settings/patch', patch: { model: ref ?? undefined } }
          : { type: 'side/settings', patch: { model: ref ?? undefined } },
      ),
  };

  // Opening the side chat never snapshots examples that are still loading.
  useEffect(() => {
    if (sideOpen && !state.sideChat && !loaded.loading) design.openSideChat();
  }, [sideOpen, state.sideChat, loaded.loading, design.openSideChat]);

  // --- The main transcript, windowed and following its tail ---
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const main = useStickToBottom(scrollRef, contentRef);
  const mainWindow = useTranscriptWindow({
    transcriptKey: session.id,
    messageCount: state.messages.length,
    scrollRef,
    contentRef,
    scrollToBottom: main.scrollToBottom,
    stopFollowing: main.stopFollowing,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the trigger
  useLayoutEffect(() => {
    if (main.isFollowing.current) main.scrollToBottom();
  }, [state.messages.length, state.status, main.scrollToBottom, main.isFollowing]);

  // --- The side transcript ---
  const sideScroll = useRef<HTMLDivElement>(null);
  const sideContent = useRef<HTMLDivElement>(null);
  const side = useStickToBottom(sideScroll, sideContent);
  const sideMessages = state.sideChat?.messages ?? [];
  const sideWindow = useTranscriptWindow({
    transcriptKey: `${state.sessionId}:${state.sideChat?.snapshot.capturedAt ?? 'none'}`,
    messageCount: sideMessages.length,
    scrollRef: sideScroll,
    contentRef: sideContent,
    scrollToBottom: side.scrollToBottom,
    stopFollowing: side.stopFollowing,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the trigger
  useLayoutEffect(() => {
    if (sideOpen && side.isFollowing.current) side.scrollToBottom();
  }, [sideOpen, sideMessages.length, state.status, side.scrollToBottom, side.isFollowing]);

  // --- Filing into the card ---

  const flash = useCallback((slot: CardSlot) => {
    setLit(slot);
    setTimeout(() => setLit((current) => (current === slot ? null : current)), 1800);
  }, []);

  /**
   * File text into a field, with where it came from. Provenance is captured here because
   * this is the only place that knows the message and take it was read from.
   */
  const file = useCallback(
    (
      messageId: string,
      swipeIndex: number,
      model: string | undefined,
      slot: CardSlot,
      text: string,
      source: UseSource,
      label?: string,
      conversation?: 'side',
      greetingId?: string,
    ) => {
      const provenance = {
        messageId,
        swipeIndex,
        at: timestamp(),
        source,
        ...(model ? { model } : {}),
        ...(label ? { label } : {}),
        ...(conversation ? { conversation } : {}),
      };
      if (greetingId)
        design.dispatch({ type: 'stash/replaceGreeting', id: greetingId, text, provenance });
      else design.dispatch({ type: 'stash/set', slot, text, provenance });
      setPending(null);
      flash(slot);
    },
    [design, flash],
  );

  const filesFor = (
    message: { id: string; swipe_id: number; swipe_info: { extra?: Record<string, unknown> }[] },
    conversation?: 'side',
  ): FileActions => {
    const model = message.swipe_info[message.swipe_id]?.extra?.model as string | undefined;
    const go = (slot: CardSlot, text: string, source: UseSource, label?: string) =>
      file(message.id, message.swipe_id, model, slot, text, source, label, conversation);
    return {
      greetings: [
        ...(state.stash.first_mes
          ? [
              {
                id: state.stash.first_mes.id,
                label: 'First message',
                text: state.stash.first_mes.text,
              },
            ]
          : []),
        ...state.stash.alternate_greetings.map((entry, index) => ({
          id: entry.id,
          label: `Alternate greeting ${index + 1}`,
          text: entry.text,
        })),
      ],
      onReplaceGreeting: (id, text, source) => {
        const first = stateRef.current.stash.first_mes?.id === id;
        const entry = first
          ? stateRef.current.stash.first_mes
          : stateRef.current.stash.alternate_greetings.find((e) => e.id === id);
        if (!entry) return;
        const slot = first ? 'first_mes' : 'alternate_greeting';
        pendingFile.current = () =>
          file(
            message.id,
            message.swipe_id,
            model,
            slot,
            text,
            source,
            undefined,
            conversation,
            id,
          );
        setPending({
          slot,
          text,
          source,
          greetingId: id,
          targetLabel: first
            ? 'First message'
            : `Alternate greeting ${stateRef.current.stash.alternate_greetings.findIndex((e) => e.id === id) + 1}`,
        });
      },
      isFilled: (slot) => isSlotFilled(stateRef.current.stash, slot),
      keptText: (slot) =>
        slot === 'alternate_greeting'
          ? (stateRef.current.stash.alternate_greetings.find((e) => e.text.trim())?.text ?? null)
          : slot === 'tags'
            ? null
            : (stateRef.current.stash[slot as SingleCardSlot]?.text ?? null),
      onUse: go,
      onCompare: (slot, text, source, label) => {
        pendingFile.current = () => go(slot, text, source, label);
        setPending({ slot, text, source, ...(label ? { label } : {}) });
      },
    };
  };
  const pendingFile = useRef<(() => void) | null>(null);

  // --- Sending ---

  const openSide = () => {
    setSideOpen(true);
    design.openSideChat();
    setTimeout(() => sideRef.current?.focus(), 50);
  };
  const quoteInSide = (text: string) => {
    if (!text.trim()) return;
    openSide();
    sideRef.current?.append(quoteForSideChat(text));
  };
  const send = (text: string, extra?: Parameters<typeof design.send>[1]) => {
    mainWindow.snapToEnd();
    void design.send(text, extra);
  };
  const submitMain = (text: string): boolean => {
    const input = parseCocreatorInput(text);
    setInputError(null);
    if (input.type === 'error') {
      setInputError(input.message);
      return false;
    }
    if (input.type === 'openSide') {
      openSide();
      return true;
    }
    if (input.type === 'sendSide') {
      openSide();
      if (design.sendSide(input.text)) return true;
      setInputError(
        loaded.loading
          ? 'Wait for the examples to load before asking the side chat.'
          : (design.sideBlockedReason ??
              'The side chat is busy. Your question is still in the box.'),
      );
      return false;
    }
    if (busy || blockedReason) return false;
    send(input.text);
    return true;
  };

  const analysed = useMemo(
    () =>
      state.messages.some(
        (m) =>
          m.is_user &&
          (currentInfo(m).extra?.coCreatorAction === 'analyseExamples' ||
            isAnalyseRequest(currentText(m))),
      ),
    [state.messages],
  );

  // --- Finish ---

  const finish = async (mode: 'update' | 'create') => {
    if (finishingRef.current || design.busy) return;
    finishingRef.current = true;
    setFinishing(true);
    try {
      await design.flushSaves();
      if (!finishAttempt.current) finishAttempt.current = new FinishAttempt();
      const attempt = finishAttempt.current;
      const avatar = await attempt.run(
        () =>
          finishSession({
            sessionId: session.id,
            mode,
            stash: stateRef.current.stash,
            baseline: stateRef.current.baseline,
            portraitChanged: stateRef.current.portraitChanged,
            avatar: stateRef.current.avatar,
            cacheKey: session.modified,
            ...(finishReview
              ? { review: { version: finishReview.latest.version, choices: finishChoices } }
              : {}),
          }),
        async (saved, publicationId) => {
          let current = stateRef.current;
          if (current.publication?.id !== publicationId) {
            if (current.avatar) {
              const image = await requiredPortrait(
                characterApi.imageUrl(saved.detail.avatar, saved.detail.modified),
              );
              const art = await cocreatorApi.setAvatar(session.id, image);
              const action: CocreatorAction = { type: 'avatar/set', filename: art.avatar! };
              current = cocreatorReducer(current, action);
              design.dispatch(action);
            }
            const recorded: CocreatorAction = {
              type: 'finished/recorded',
              avatar: saved.detail.avatar,
              publicationId,
              baseline: { card: saved.detail.card, portraitVersion: saved.portraitVersion },
              stash: rebaseStash(current.stash, saved.detail),
            };
            current = cocreatorReducer(current, recorded);
            design.dispatch(recorded);
          }
          await design.flushSaves(current);
        },
      );
      onFinished(avatar);
    } catch (error) {
      if (error instanceof FinishConflictError) {
        setFinishReview(error);
        setFinishChoices({});
      } else onError((error as Error).message);
    } finally {
      finishingRef.current = false;
      setFinishing(false);
    }
  };

  const lastIndex = state.messages.length - 1;
  const lastSide = sideMessages.length - 1;
  const sideBlocked = !state.sideChat ? 'Getting the side chat ready…' : design.sideBlockedReason;

  return (
    <div className="w3-co-desk">
      <section className="w3-co-convo">
        <div className="w3-co-convo__head">
          <Examples
            design={design}
            loaded={loaded}
            characters={characters}
            defaults={defaults}
            analysed={analysed}
            onDefaultsChange={onDefaultsChange}
            onAnalyse={() => send(design.analysisPrompt, { coCreatorAction: 'analyseExamples' })}
          />
          <span className="w3-co-gap" />
          <CoCreatorSetup
            design={design}
            defaults={defaults}
            models={models}
            presets={presets}
            activePresetId={activePresetId}
            onModelSlotChange={onModelSlotChange}
            onDefaultsChange={onDefaultsChange}
          />
        </div>

        <div className="w3-co-scroll" ref={scrollRef}>
          <div className="w3-co-list" ref={contentRef}>
            {state.messages.length === 0 ? (
              <p className="w3-co-empty">
                {state.baseline
                  ? 'What would you like to change about this character?'
                  : 'Describe who you have in mind.'}
              </p>
            ) : (
              state.messages.slice(mainWindow.start, mainWindow.end).map((message, index) => {
                const at = mainWindow.start + index;
                return (
                  <CoCreatorMessage
                    key={message.id}
                    message={message}
                    who="Co-Creator"
                    canReroll={at === lastIndex && !message.is_user}
                    canRetry={at === lastIndex && message.is_user}
                    streaming={
                      state.activeConversation === 'main' &&
                      state.streamingId === message.id &&
                      state.status !== 'idle'
                    }
                    stream={design.stream}
                    busy={busy}
                    busyReason={busyReason}
                    countTokens={countTokens}
                    files={filesFor(message)}
                    onAskSide={quoteInSide}
                    onSelectSwipe={(id, swipe) =>
                      design.dispatch({ type: 'swipe/select', id, index: swipe })
                    }
                    onReroll={() => void design.reroll()}
                    onRetry={() => void design.retry()}
                    onContinue={() => void design.continueReply()}
                    onEdit={(id, text) => design.dispatch({ type: 'message/edited', id, text })}
                    onDelete={(id) => design.dispatch({ type: 'message/deleted', id })}
                  />
                );
              })
            )}
            {inputError || state.error ? (
              <p className="w3-co-error" role="alert">
                {inputError || state.error}
              </p>
            ) : null}
          </div>
        </div>

        <Composer
          ref={mainRef}
          label="Message the Co-Creator"
          placeholder="Tell the Co-Creator what to write, or what to change"
          busy={busy}
          busyReason={busyReason}
          blockedReason={blockedReason}
          quickCommands={defaults.quickCommands ?? []}
          onQuickCommandsChange={(quickCommands) => onDefaultsChange({ quickCommands })}
          sideOpen={sideOpen}
          onToggleSide={() => (sideOpen ? setSideOpen(false) : openSide())}
          onSend={submitMain}
          onStop={design.abort}
        />

        {sideOpen ? (
          <aside className="w3-co-side" aria-label="Side chat">
            <header className="w3-co-side__head">
              <div>
                <b>Side chat</b>
                <small>
                  {state.sideChat
                    ? `Sees the conversation as it was at ${new Date(state.sideChat.snapshot.capturedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, and your examples. Nothing reaches the card unless you use it.`
                    : 'Getting ready…'}
                  {design.sideContext &&
                  design.sideContext.droppedMainMessages + design.sideContext.droppedSideMessages >
                    0
                    ? ` ${design.sideContext.droppedMainMessages + design.sideContext.droppedSideMessages} older messages don't fit its model.`
                    : ''}
                </small>
              </div>
              <button
                type="button"
                className="w3-st-ghost w3-st-ghost--sm"
                data-armed={armedReset || undefined}
                disabled={busy || loaded.loading || !state.sideChat}
                title="Clear the side chat and let it see the conversation as it is now"
                onClick={() => {
                  if (!armedReset) return setArmedReset(true);
                  setArmedReset(false);
                  setSideError(null);
                  if (design.openSideChat(true)) sideRef.current?.clear();
                }}
                onBlur={() => setArmedReset(false)}
              >
                {armedReset ? 'Click again' : 'Start fresh'}
              </button>
              <button
                type="button"
                className="w3-co-iconbtn"
                aria-label="Close the side chat"
                onClick={() => setSideOpen(false)}
              >
                <Icon name="close" size="sm" />
              </button>
            </header>
            <div className="w3-co-side__scroll" ref={sideScroll}>
              <div className="w3-co-list" ref={sideContent}>
                {!sideMessages.length ? (
                  <p className="w3-co-empty">
                    Ask anything on the side. Only what you bring back reaches the conversation.
                  </p>
                ) : null}
                {sideMessages.slice(sideWindow.start, sideWindow.end).map((message, index) => {
                  const at = sideWindow.start + index;
                  return (
                    <CoCreatorMessage
                      key={message.id}
                      message={message}
                      who="Side chat"
                      canReroll={at === lastSide && !message.is_user}
                      canRetry={at === lastSide && message.is_user}
                      streaming={
                        state.activeConversation === 'side' &&
                        state.streamingId === message.id &&
                        busy
                      }
                      stream={design.stream}
                      busy={busy}
                      busyReason={busyReason}
                      countTokens={design.sideCountTokens}
                      files={filesFor(message, 'side')}
                      onInsert={(text) => mainRef.current?.append(text)}
                      onSelectSwipe={(id, swipe) =>
                        design.dispatch({ type: 'swipe/select', target: 'side', id, index: swipe })
                      }
                      onReroll={() => {
                        sideWindow.snapToEnd();
                        void design.rerollSide();
                      }}
                      onRetry={() => {
                        sideWindow.snapToEnd();
                        void design.retrySide();
                      }}
                      onContinue={() => {
                        sideWindow.snapToEnd();
                        void design.continueSide();
                      }}
                      onEdit={(id, text) =>
                        design.dispatch({ type: 'message/edited', target: 'side', id, text })
                      }
                      onDelete={(id) =>
                        design.dispatch({ type: 'message/deleted', target: 'side', id })
                      }
                    />
                  );
                })}
                {sideError || state.sideChat?.error || sideBlocked ? (
                  <p className="w3-co-error" role="alert">
                    {sideError || state.sideChat?.error || sideBlocked}
                  </p>
                ) : null}
              </div>
            </div>
            <Composer
              ref={sideRef}
              label="Ask on the side"
              placeholder="Ask on the side"
              busy={busy}
              busyReason={busyReason}
              blockedReason={sideBlocked}
              onSend={(text) => {
                const input = parseCocreatorInput(text);
                if (input.type === 'error') {
                  setSideError(input.message);
                  return false;
                }
                setSideError(null);
                if (input.type === 'openSide') return true;
                const accepted = design.sendSide(input.text);
                if (accepted) sideWindow.snapToEnd();
                return accepted;
              }}
              onStop={design.abort}
            />
          </aside>
        ) : null}
      </section>

      <CoCreatorCard
        stash={state.stash}
        title={session.title}
        seedName={seedName}
        canUpdate={Boolean(
          state.targetAvatar && characters.some((c) => c.avatar === state.targetAvatar),
        )}
        hasTarget={Boolean(state.targetAvatar || state.baseline || state.publication)}
        draftBlock={renderDraftBlock(state.stash, state.baseline?.card ?? null)}
        baseline={state.baseline}
        finishReview={finishReview}
        finishChoices={finishChoices}
        onFinishChoice={(field, choice) =>
          setFinishChoices((current) => ({ ...current, [field]: choice }))
        }
        pendingFinish={Boolean(finishAttempt.current?.result)}
        sessionId={session.id}
        avatar={state.avatar}
        cacheKey={session.modified}
        countTokens={countTokens}
        pending={pending}
        lit={lit}
        busy={busy}
        finishing={finishing}
        edits={{
          editSlot: (slot, text) => design.dispatch({ type: 'stash/editSlot', slot, text }),
          editGreeting: (index, text) =>
            design.dispatch({ type: 'stash/editGreeting', index, text }),
          moveGreeting: (from, to) => design.dispatch({ type: 'stash/reorderGreetings', from, to }),
          removeGreeting: (index) => design.dispatch({ type: 'stash/removeGreeting', index }),
          removeTag: (index) => design.dispatch({ type: 'stash/removeTag', index }),
          clearSlot: (slot) => design.dispatch({ type: 'stash/clear', slot }),
        }}
        onKeep={() => {
          pendingFile.current = null;
          setPending(null);
        }}
        onAccept={() => {
          pendingFile.current?.();
          pendingFile.current = null;
        }}
        onAsk={(label) => mainRef.current?.append(`Write the ${label.toLowerCase()}.`)}
        onAvatar={(avatar) =>
          design.dispatch(
            avatar ? { type: 'avatar/set', filename: avatar } : { type: 'avatar/cleared' },
          )
        }
        onError={onError}
        onFinish={(mode) => void finish(mode)}
      />
    </div>
  );
}
