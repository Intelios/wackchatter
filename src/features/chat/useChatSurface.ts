/**
 * Everything a chat surface knows and does, apart from its markup.
 *
 * The chat stage is markup over this hook, which holds the sliding transcript
 * window and its scroll protocol, `/jump`, slash commands, the send path, impersonation,
 * the recap's run, the card reader's state, the render-only text pass (greeting macros,
 * then regex scripts), and the stable per-row callbacks the memoised rows depend on.
 */

import { currentText, type MessageState } from '@shared/chat/message.ts';
import { formatRoll, rollDice } from '@shared/prompt/dice.ts';
import { regexDepths } from '@shared/regex/depth.ts';
import { applyRegexScripts, createRegexCompileCache } from '@shared/regex/engine.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import { REGEX_PLACEMENT } from '@shared/types/regex.ts';
import type { DialogueColorSettings } from '@shared/types/settings.ts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { characterApi } from '../../lib/api.ts';
import { matchPersonaByName, personaDisplayName } from '../persona/personaRoster.ts';
import { needsPortrait, resolveDialogueColor, useAvatarPalette } from './avatarColor.ts';
import type { CardReaderInit } from './CardReader.tsx';
import type { RecapMeta, RecapViewState } from './RecapOverlay.tsx';
import { parseSlashCommand, type SlashCommand } from './slashCommands.ts';
import { createCardStore } from './state/cardStore.ts';
import { windowForJump } from './transcriptWindow.ts';
import type { UseChat } from './useChat.ts';
import { useStickToBottom } from './useStickToBottom.ts';
import { useTranscriptWindow } from './useTranscriptWindow.ts';

export interface ChatSurfaceOptions {
  chat: UseChat;
  avatar: string | null;
  characterAvatarVersion?: number;
  personas: Persona[];
  onSelectPersona: (id: string | null) => void;
  /** Where `/persona` with no name sends you. */
  onOpenPersonas: () => void;
  /** The card's `creator_notes` as stored; macros are resolved here. */
  creatorNotes: string;
  card: CardDataV2 | null;
  onEditCharacter: () => void;
  dialogueColors: DialogueColorSettings;
  regexScripts: readonly RegexScript[];
  /** Writes the impersonated text into the surface's composer. */
  onImpersonated: (text: string) => void;
}

export function useChatSurface({
  chat,
  avatar,
  characterAvatarVersion,
  personas,
  onSelectPersona,
  onOpenPersonas,
  creatorNotes,
  card,
  onEditCharacter,
  dialogueColors,
  regexScripts,
  onImpersonated,
}: ChatSurfaceOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { scrollToBottom, stopFollowing } = useStickToBottom(scrollRef, contentRef);
  // The message a jump just centred on, held briefly so the row can flash.
  const [flashId, setFlashId] = useState<string | null>(null);

  const { state, generationBlocked } = chat;

  // Declared after useStickToBottom so its listener, which drops the follow at page
  // boundaries, subscribes after the follow's own and wins the same scroll event. The key
  // folds the reload count in: a reload replaces the transcript.
  const {
    start: visibleStart,
    end: visibleEnd,
    setWindowRange,
    suppressLoadAhead,
    programmaticScrollRef,
    snapToEnd,
  } = useTranscriptWindow({
    transcriptKey: state.chatId ? `${state.chatId}#${chat.reloadCount}` : null,
    messageCount: state.messages.length,
    scrollRef,
    contentRef,
    scrollToBottom,
    stopFollowing,
  });

  /*
   * A recap runs in impersonation's mode (a generation with no transcript home), so the
   * mode alone cannot tell the two apart. Tracked here, from the run's own start and end.
   */
  const [recapRunning, setRecapRunning] = useState(false);
  // A generation whose text belongs to the composer rather than the transcript.
  const impersonating = state.status !== 'idle' && state.mode === 'impersonate' && !recapRunning;
  const loadBlocksChat = Boolean(chat.loadError && !state.chatId);
  const characterAvatarUrl = avatar ? characterApi.imageUrl(avatar, characterAvatarVersion) : null;

  const characterOverride = avatar ? dialogueColors.characters[avatar] : undefined;
  const characterAutoColor = useAvatarPalette(
    dialogueColors.enabled && needsPortrait(characterOverride) ? characterAvatarUrl : null,
  );
  const characterDialogue = resolveDialogueColor(
    dialogueColors.enabled,
    characterOverride,
    characterAutoColor,
  );

  // A message keeps the face it was spoken with: each user row resolves its own recorded
  // speaker. A missing record falls back to the chat's persona.
  const chatPersona = chat.persona;
  const resolvePersona = chat.resolvePersona;
  const speakerOf = useCallback(
    (message: MessageState): Persona | null => {
      const id = message.persona_id === undefined ? (chatPersona?.id ?? null) : message.persona_id;
      return resolvePersona(id);
    },
    [resolvePersona, chatPersona],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on chat identity and reloads
  useEffect(() => {
    setFlashId(null);
  }, [state.chatId, chat.reloadCount]);

  const visibleMessages = state.messages.slice(visibleStart, visibleEnd);

  // --- /jump -----------------------------------------------------------------

  const pendingJumpRef = useRef<string | null>(null);
  // Every jump bumps this, and the centring effect is keyed on it rather than on the window
  // bounds: a target already inside the window leaves the bounds unchanged.
  const [jumpSeq, setJumpSeq] = useState(0);

  const jumpTo = useCallback(
    (index: number) => {
      const count = state.messages.length;
      if (count === 0) return;
      const target = Math.min(Math.max(0, index), count - 1);
      const win = windowForJump(target, count);
      pendingJumpRef.current = state.messages[target]?.id ?? null;
      suppressLoadAhead();
      stopFollowing();
      setWindowRange(win);
      setJumpSeq((s) => s + 1);
    },
    [state.messages, stopFollowing, suppressLoadAhead, setWindowRange],
  );

  useEffect(() => {
    const id = chat.nexus.jumpId;
    if (!id) return;
    const index = chat.messages.findIndex((m) => m.id === id);
    if (index >= 0) jumpTo(index);
    chat.nexus.setJumpId(null);
  }, [chat.nexus.jumpId, chat.nexus.setJumpId, chat.messages, jumpTo]);

  // The target only exists once the new window has committed. Centred, not snapped to the
  // top: the reader lands with context above and below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the sequence is the trigger
  useLayoutEffect(() => {
    const id = pendingJumpRef.current;
    if (!id) return;
    pendingJumpRef.current = null;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    const el = content.querySelector(`[data-message-id="${id}"]`);
    if (!el) return;
    const scrollRect = scroll.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    programmaticScrollRef.current = true;
    scroll.scrollTop =
      elRect.top - scrollRect.top + scroll.scrollTop - scroll.clientHeight / 2 + elRect.height / 2;
    setFlashId(id);
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [jumpSeq]);

  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), 2000);
    return () => clearTimeout(timer);
  }, [flashId]);

  // --- The card reader -------------------------------------------------------

  const [cardReader, setCardReader] = useState<CardReaderInit | null>(null);
  const openCardReader = useCallback(
    (init: CardReaderInit = {}) => setCardReader({ query: init.query, sectionId: init.sectionId }),
    [],
  );
  const closeCardReader = useCallback(() => setCardReader(null), []);

  // --- "Previously on…" ------------------------------------------------------

  /*
   * The recap's text belongs to a reading surface, not to the chat: `chat.recap` keeps it
   * out of the transcript and the save queue, so this is its only home while it is shown.
   * `status` starts `active` because opening it is what starts the run.
   */
  const [recapOpen, setRecapOpen] = useState(false);
  const [recapView, setRecapView] = useState<RecapViewState>({
    status: 'active',
    text: '',
    error: null,
  });
  const [recapMeta, setRecapMeta] = useState<RecapMeta | null>(null);

  const runRecap = useCallback(() => {
    setRecapOpen(true);
    setRecapMeta(null);
    setRecapView({ status: 'active', text: '', error: null });
    setRecapRunning(true);
    void chat.recap({
      onText: (text) => setRecapView((prev) => ({ ...prev, text })),
      onMeta: (meta) => setRecapMeta(meta),
      onError: (error) => setRecapView({ status: 'failed', text: '', error }),
      onDone: () => {
        setRecapRunning(false);
        setRecapView((prev) => (prev.status === 'failed' ? prev : { ...prev, status: 'done' }));
      },
    });
  }, [chat]);
  const closeRecap = useCallback(() => setRecapOpen(false), []);

  // A recap belongs to the chat it was written for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on chat identity on purpose — the body only calls setters
  useEffect(() => {
    setRecapOpen(false);
    setRecapView({ status: 'done', text: '', error: null });
    setRecapMeta(null);
  }, [state.chatId]);

  /**
   * Impersonate. The model writes the user's next message; the draft steers it and the
   * result replaces the draft, so it is editable before it is sent.
   */
  const impersonatedRef = useRef(onImpersonated);
  impersonatedRef.current = onImpersonated;
  const impersonate = useCallback(
    (instruction?: string) => {
      void chat.impersonate(instruction, (text) => impersonatedRef.current(text));
    },
    [chat],
  );

  // --- Slash commands --------------------------------------------------------

  const runCommand = useCallback(
    async (command: SlashCommand): Promise<string | null> => {
      const count = state.messages.length;
      switch (command.type) {
        case 'hide':
        case 'unhide': {
          if (count === 0) return 'This chat has no messages yet.';
          const start = command.start === null ? count - 1 : Math.min(command.start, count - 1);
          const end = command.end === null ? start : Math.min(command.end, count - 1);
          const ids = state.messages.slice(start, end + 1).map((message) => message.id);
          chat.setHidden(ids, command.type === 'hide');
          return null;
        }
        case 'jump': {
          if (count === 0) return 'This chat has no messages to jump to.';
          jumpTo(command.index);
          return null;
        }
        // The dice land in the transcript as a message, so the character can read them.
        case 'roll': {
          if (!state.chatId) return 'Open a chat before rolling.';
          if (generationBlocked) return 'Wait for the current reply to finish before rolling.';
          const rolled = rollDice(command.formula);
          if (!rolled) return `Could not roll "${command.formula}".`;
          snapToEnd();
          chat.appendUserMessage(formatRoll(rolled));
          return null;
        }
        case 'rename': {
          if (!state.chatId) return 'No chat is open to rename.';
          chat.renameChat(command.title);
          return null;
        }
        case 'card': {
          openCardReader({ query: command.query });
          return null;
        }
        // An unmatched or ambiguous name is an error that keeps the draft: a wrong guess
        // would be recorded onto every message sent afterwards.
        case 'persona': {
          if (!command.query) {
            onOpenPersonas();
            return null;
          }
          if (command.query.toLowerCase() === 'none') {
            onSelectPersona(null);
            return null;
          }
          const match = matchPersonaByName(personas, command.query);
          if (match.ok) {
            onSelectPersona(match.persona.id);
            return null;
          }
          if (match.reason === 'ambiguous') {
            const names = match.candidates
              .map((persona) => `"${personaDisplayName(persona)}"`)
              .join(', ');
            return `"${command.query}" matches ${match.candidates.length} personas — ${names}. Pick one from the persona switcher.`;
          }
          return personas.length === 0
            ? 'There are no personas yet. Create one from Personas.'
            : `No persona matches "${command.query}".`;
        }
        case 'reload': {
          if (!state.chatId) return 'No chat is open to reload.';
          if (generationBlocked) {
            return 'Wait for the current reply to finish before reloading.';
          }
          try {
            await chat.reloadChat();
          } catch (error) {
            return `Could not reload the chat: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
          return null;
        }
        case 'impersonate': {
          if (!state.chatId) return 'Open a chat before impersonating.';
          if (generationBlocked) {
            return 'Wait for the current reply to finish before impersonating.';
          }
          impersonate(command.instruction);
          return null;
        }
      }
    },
    [
      state.chatId,
      state.messages,
      generationBlocked,
      chat,
      impersonate,
      jumpTo,
      openCardReader,
      onOpenPersonas,
      onSelectPersona,
      personas,
      snapToEnd,
    ],
  );

  /**
   * The composer's one write path. Normal text goes to `chat.send`; a command-shaped line
   * is parsed here so it never reaches the provider. `null` clears the composer; a string
   * is an error that keeps the draft.
   */
  const handleSend = useCallback(
    async (text: string): Promise<string | null> => {
      const parsed = parseSlashCommand(text);
      if (!parsed) {
        snapToEnd();
        void chat.send(text);
        return null;
      }
      if (!parsed.ok) return parsed.error;
      // Commands are deliberately not snapped: `/jump` exists to move away from the end.
      return runCommand(parsed.command);
    },
    [chat, runCommand, snapToEnd],
  );

  const guide = useCallback(
    (text: string) => {
      snapToEnd();
      void chat.guidedRespond(text);
    },
    [chat, snapToEnd],
  );
  const guidedSwipe = useCallback(
    (text: string) => {
      snapToEnd();
      void chat.guidedSwipe(text);
    },
    [chat, snapToEnd],
  );

  // --- Transcript edits (hoisted for memo) ----------------------------------

  /*
   * Stable for the surface's life, so a memoised row is worth anything. Through a ref:
   * `useChat` returns a fresh object every render, and its generation methods turn over
   * whenever a setting changes. These only run from event handlers, after the commit that
   * updated the ref.
   */
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const swipe = useCallback((direction: -1 | 1) => void chatRef.current.swipe(direction), []);
  const swipeTo = useCallback(
    (id: string, index: number) => chatRef.current.swipeTo(id, index),
    [],
  );
  const regenerate = useCallback(() => void chatRef.current.regenerate(), []);
  const continueLast = useCallback(() => void chatRef.current.continueLast(), []);
  const editMessage = useCallback(
    (id: string, text: string) => chatRef.current.editMessage(id, text),
    [],
  );
  const editReasoning = useCallback(
    (id: string, reasoning: string) => chatRef.current.editReasoning(id, reasoning),
    [],
  );
  const deleteMessage = useCallback((id: string) => chatRef.current.deleteMessage(id), []);
  const toggleHidden = useCallback((id: string) => chatRef.current.toggleHidden(id), []);
  const branchFrom = useCallback((id: string) => void chatRef.current.branchFrom(id), []);

  const editCharacterRef = useRef(onEditCharacter);
  editCharacterRef.current = onEditCharacter;
  const editCharacter = useCallback(() => editCharacterRef.current(), []);

  /*
   * The card, out of band: created once and synced from an effect, so the rows that carry
   * the sheet's trigger never see the card change identity while the editor autosaves.
   */
  const [cardStore] = useState(createCardStore);
  useEffect(() => {
    cardStore.set({ avatar, card, render: chat.renderGreeting });
  }, [cardStore, avatar, card, chat.renderGreeting]);

  const lastId = state.messages[state.messages.length - 1]?.id ?? null;
  // A transcript ending on the user's turn is still owed a reply — that is what makes
  // retry available.
  const awaitingReply = Boolean(state.messages[state.messages.length - 1]?.is_user);

  const guides = state.metadata.guides ?? [];
  const guidedSwipeDisabledReason = !lastId
    ? 'Nothing to swipe yet.'
    : awaitingReply
      ? 'Waiting on a reply — guide it instead.'
      : undefined;

  /*
   * Render-only text for the rows on screen: greeting macros, then regex scripts. One memo
   * for the window, one compiled-regex cache, and the only place that can run the greeting's
   * macros BEFORE the scripts see the text. Depth comes from the WHOLE transcript.
   */
  const displayTexts = useMemo(() => {
    const rendered = new Map<string, { text?: string; reasoning?: string }>();
    const first = state.messages[0];
    const greeting =
      first && !first.is_user ? chat.renderGreeting(first.swipes[first.swipe_id] ?? '') : undefined;
    if (greeting !== undefined) rendered.set(first!.id, { text: greeting });

    if (regexScripts.length === 0 || !chat.regexMacros) return rendered;

    const depths = regexDepths(
      state.messages.map((message) => ({
        id: message.id,
        is_system: message.is_system,
        mes: currentText(message),
      })),
    );
    const cache = createRegexCompileCache();
    const options = { macros: chat.regexMacros, cache };

    for (let index = visibleStart; index < visibleEnd; index++) {
      const message = state.messages[index];
      if (!message) continue;
      const context = {
        placement: message.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
        display: true,
        depth: depths.get(message.id),
      };

      const source = rendered.get(message.id)?.text ?? currentText(message);
      const text = applyRegexScripts(source, regexScripts, context, options);

      const rawReasoning = message.swipe_info[message.swipe_id]?.extra?.reasoning;
      const reasoning =
        typeof rawReasoning === 'string' && rawReasoning
          ? applyRegexScripts(
              rawReasoning,
              regexScripts,
              { ...context, placement: REGEX_PLACEMENT.REASONING },
              options,
            )
          : undefined;

      // Only rows the scripts changed get an entry, so untouched rows keep `undefined`.
      const changed = text !== currentText(message);
      const reasoningChanged = reasoning !== undefined && reasoning !== rawReasoning;
      if (changed || reasoningChanged || rendered.has(message.id)) {
        rendered.set(message.id, {
          text: changed || rendered.has(message.id) ? text : undefined,
          reasoning: reasoningChanged ? reasoning : undefined,
        });
      }
    }

    return rendered;
  }, [
    chat.renderGreeting,
    chat.regexMacros,
    state.messages,
    regexScripts,
    visibleStart,
    visibleEnd,
  ]);

  // Creator notes are card text, so they get the greeting's own macro pass.
  const renderedNotes = useMemo(
    () => (creatorNotes.trim() ? chat.renderGreeting(creatorNotes) : creatorNotes),
    [creatorNotes, chat.renderGreeting],
  );

  return {
    scrollRef,
    contentRef,
    flashId,
    visibleStart,
    visibleMessages,
    snapToEnd,
    jumpTo,

    impersonating,
    loadBlocksChat,
    characterAvatarUrl,
    characterDialogue,
    speakerOf,

    cardStore,
    cardReader,
    openCardReader,
    closeCardReader,

    recapOpen,
    recapRunning,
    recapView,
    recapMeta,
    runRecap,
    closeRecap,

    impersonate,
    handleSend,
    guide,
    guidedSwipe,

    swipe,
    swipeTo,
    regenerate,
    continueLast,
    editMessage,
    editReasoning,
    deleteMessage,
    toggleHidden,
    branchFrom,
    editCharacter,

    lastId,
    awaitingReply,
    guides,
    guidedSwipeDisabledReason,
    displayTexts,
    renderedNotes,
  };
}

export type ChatSurface = ReturnType<typeof useChatSurface>;
