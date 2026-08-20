import { currentText, type MessageState } from '@shared/chat/message.ts';
import { regexDepths } from '@shared/regex/depth.ts';
import { applyRegexScripts, createRegexCompileCache } from '@shared/regex/engine.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import { REGEX_PLACEMENT } from '@shared/types/regex.ts';
import type {
  DialogueColorOverride,
  DialogueColorSettings,
  GuidanceSettings,
  QuickCommand,
} from '@shared/types/settings.ts';
import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { RefreshIcon } from '../../layout/icons.tsx';
import type { RightPanelId } from '../../layout/panels.tsx';
import { characterApi, personaApi } from '../../lib/api.ts';
import { PersonaChip } from '../persona/PersonaChip.tsx';
import { matchPersonaByName } from '../persona/personaRoster.ts';
import { resolveDialogueColor, useAvatarColor } from './avatarColor.ts';
import { CardReader, type CardReaderInit } from './CardReader.tsx';
import { ChatMenu } from './ChatMenu.tsx';
import { Composer, type ComposerHandle } from './Composer.tsx';
import { GuidesPopover } from './GuidesPopover.tsx';
import { MessageBubble } from './MessageBubble.tsx';
import { QuickCommands } from './QuickCommands.tsx';
import { parseSlashCommand, type SlashCommand } from './slashCommands.ts';
import { createCardStore } from './state/cardStore.ts';
import {
  appendTranscriptWindow,
  initialTranscriptWindow,
  prependTranscriptWindow,
  windowForJump,
} from './transcriptWindow.ts';
import type { UseChat } from './useChat.ts';
import { useStickToBottom } from './useStickToBottom.ts';
import './ChatView.css';

/** How far from the top or bottom the reader has to be before the next page appears. */
const LOAD_AHEAD_PX = 800;

interface ChatViewProps {
  chat: UseChat;
  characterName: string;
  avatar: string | null;
  characterAvatarVersion?: number;
  /** Cache-busting versions per persona id — a row's speaker is not always the chat's. */
  personaAvatarVersions?: Readonly<Record<string, number>>;
  /** Every persona, for the composer's switcher and for resolving `/persona <name>`. */
  personas: Persona[];
  /** Most recently switched to, newest first. Orders the switcher. */
  recentPersonaIds: readonly string[];
  /** Sets the app-wide persona and this chat's, together. */
  onSelectPersona: (id: string | null) => void;
  /**
   * The card's `creator_notes` as stored, offered on the greeting. Empty shows nothing.
   * Macros are resolved here, on the display path, not by the caller.
   */
  creatorNotes: string;
  /** How many greetings the card offers, so a scenario list can be lined up with them. */
  greetingCount: number;
  /**
   * The open character's card, for the sheet on their avatar. Already in memory — the chat
   * cannot render without it — so reading it back costs no fetch.
   */
  card: CardDataV2 | null;
  /** Leaves the chat for the character editor, offered from inside the sheet. */
  onEditCharacter: () => void;
  /** False until an endpoint and model are configured. */
  ready: boolean;
  /** Leave the chat and go back to the no-character state. */
  onCloseChat: () => void;
  /** Open the right panel on a given tab, for the menu's jump entries. */
  onOpenPanel: (panel: RightPanelId) => void;
  /** App-wide guided-generation config. The guides themselves live on the chat. */
  guidance: GuidanceSettings;
  onGuidanceChange: (patch: Partial<GuidanceSettings>) => void;
  dialogueColors: DialogueColorSettings;
  /** App-wide user-defined quick commands, inserted into the composer from the chat menu. */
  quickCommands: QuickCommand[];
  onQuickCommandsChange: (commands: QuickCommand[]) => void;
  /** Reads a chat export into this character as a new chat, from the chat menu. */
  onImportChat: (file: File) => void;
  /**
   * Enabled regex scripts. A lookup, not the settings object, for the same reason the
   * dialogue colours are: an unrelated settings change must not re-render the transcript.
   */
  regexScripts: readonly RegexScript[];
}

interface TranscriptWindowState {
  chatId: string | null;
  start: number;
  end: number;
}

export function ChatView({
  chat,
  characterName,
  avatar,
  characterAvatarVersion,
  personaAvatarVersions,
  personas,
  recentPersonaIds,
  onSelectPersona,
  creatorNotes,
  greetingCount,
  card,
  onEditCharacter,
  ready,
  onCloseChat,
  onOpenPanel,
  guidance,
  onGuidanceChange,
  dialogueColors,
  quickCommands,
  onQuickCommandsChange,
  onImportChat,
  regexScripts,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { scrollToBottom, stopFollowing } = useStickToBottom(scrollRef, contentRef);
  const [window, setWindow] = useState<TranscriptWindowState>({ chatId: null, start: 0, end: 0 });
  // The first rendered message and where its top sat relative to the viewport, captured
  // before a prepend so the same document position can be restored after it commits.
  const restorePrependScroll = useRef<{ messageId: string; offset: number } | null>(null);

  // The write path from quick commands into the composer's private draft.
  const composerRef = useRef<ComposerHandle>(null);

  const { state, stream, busy, generationBlocked } = chat;
  const loadBlocksChat = Boolean(chat.loadError && !state.chatId);
  const characterAvatarUrl = avatar ? characterApi.imageUrl(avatar, characterAvatarVersion) : null;

  const characterOverride = avatar ? dialogueColors.characters[avatar] : undefined;
  const characterAutoColor = useAvatarColor(
    dialogueColors.enabled && characterOverride === undefined ? characterAvatarUrl : null,
  );
  const characterDialogue = resolveDialogueColor(
    dialogueColors.enabled,
    characterOverride,
    characterAutoColor,
  );

  // Who "you" are can change mid-conversation, but a message keeps the face it was
  // spoken with: each user row resolves its own recorded speaker rather than borrowing
  // the chat's current persona. A missing record — a legacy message, from before
  // speakers were stamped — falls back to the chat's persona, its behaviour so far.
  const chatPersona = chat.persona;
  const resolvePersona = chat.resolvePersona;
  const speakerOf = useCallback(
    (message: MessageState): Persona | null => {
      const id = message.persona_id === undefined ? (chatPersona?.id ?? null) : message.persona_id;
      return resolvePersona(id);
    },
    [resolvePersona, chatPersona],
  );

  // Jump to the end when a different chat is opened, and again after a reload — a reload
  // replaces the transcript, so the old window position would point at the wrong rows.
  // Keyed on the chat plus the reload count, by design.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on chat identity and reloads
  useEffect(() => {
    const initial = initialTranscriptWindow(state.messages.length);
    setWindow({ chatId: state.chatId, start: initial.start, end: initial.end });
    scrollToBottom();
  }, [state.chatId, chat.reloadCount]);

  // A chat can render its loaded messages before the chat-change effect has set state.
  // Deriving the initial tail page here prevents that first paint from mounting every
  // Markdown bubble in a long chat.
  const fallbackWindow = initialTranscriptWindow(state.messages.length);
  const visibleStart =
    window.chatId === state.chatId
      ? Math.min(window.start, state.messages.length)
      : fallbackWindow.start;
  const visibleEnd =
    window.chatId === state.chatId
      ? Math.min(window.end, state.messages.length)
      : fallbackWindow.end;
  const visibleMessages = state.messages.slice(visibleStart, visibleEnd);

  // While the window is not anchored to the tail, bottom-follow must stay off: the
  // "bottom" of the scroll container is a page boundary, not the transcript's end, and an
  // auto-scroll there would cascade page loads with no reader action. A ref so the scroll
  // listener can read it without re-subscribing on every message.
  const atEndRef = useRef(true);
  atEndRef.current = visibleEnd >= state.messages.length;

  // Prepending adds DOM above the reader. Restore the same document position after the
  // layout commits, rather than leaving them unexpectedly at the oldest newly loaded row.
  //
  // Anchored to the first rendered message rather than a height difference: the newer
  // load-ahead can append below in the same commit, and a `scrollHeight` delta cannot
  // tell "grew above" from "grew below". The message's new top is measured after the
  // commit, so the restore is exact regardless of what else moved.
  useLayoutEffect(() => {
    const restore = restorePrependScroll.current;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!restore || !scroll || !content) return;
    const el = content.querySelector(`[data-message-id="${restore.messageId}"]`);
    if (el) {
      const scrollRect = scroll.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      scroll.scrollTop += elRect.top - scrollRect.top - restore.offset;
    }
    restorePrependScroll.current = null;
  });

  // --- /jump -----------------------------------------------------------------

  const pendingJumpRef = useRef<string | null>(null);
  // After a jump, the load-ahead must stand down until the reader actually scrolls: the
  // jump's own centering scroll lands inside the load-ahead band, and letting the band
  // logic fire there would cascade page loads and restores that walk the viewport away
  // from the target. `programmaticScrollRef` marks the centering scroll itself so the
  // listener does not mistake it for a reader scroll.
  const suppressLoadAheadRef = useRef(false);
  const programmaticScrollRef = useRef(false);

  const jumpTo = useCallback(
    (index: number) => {
      const count = state.messages.length;
      if (count === 0) return;
      const target = Math.min(Math.max(0, index), count - 1);
      const win = windowForJump(target, count);
      pendingJumpRef.current = state.messages[target]?.id ?? null;
      suppressLoadAheadRef.current = true;
      stopFollowing();
      setWindow({ chatId: state.chatId, start: win.start, end: win.end });
    },
    [state.chatId, state.messages, stopFollowing],
  );

  // The target only exists in the DOM once the new window has committed, so the scroll
  // waits for this layout effect. Centred, not snapped to the top: the reader lands with
  // context above and below, and a jump to the very start still shows the first message.
  // Declared before the load-ahead effects so their scroll captures happen after the
  // centering — otherwise a prepend queued by the same commit would restore the viewport
  // to the pre-jump position and the jump would land somewhere else entirely.
  // Keyed on the window bounds, by design — a jump is a window change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the window is the trigger
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
    // Released after the scroll event this just queued has been dispatched.
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [window.start, window.end]);

  // --- Sending ---------------------------------------------------------------

  /**
   * Put the reader at the end of the transcript, because that is what sending asks for.
   *
   * Reading back a few messages drops the bottom-follow — right while reading, wrong the
   * moment you send, since the message you just wrote and the reply after it would arrive
   * below the fold. The window is re-anchored too, not just the scroll: a window that is
   * not at the tail never renders the new rows at all, so a send from the middle of a long
   * chat would otherwise have nowhere to land. An already-tail-anchored window is left
   * alone, pages loaded above it included — it is only the end that has to be visible.
   */
  const snapToEnd = useCallback(() => {
    suppressLoadAheadRef.current = false;
    setWindow((current) =>
      current.chatId === state.chatId && current.end >= state.messages.length
        ? current
        : { chatId: state.chatId, ...initialTranscriptWindow(state.messages.length) },
    );
    // Marked like the jump's centering scroll, and for the opposite reason: this
    // container's listener still reads the pre-snap `atEndRef`, so it would answer our own
    // scroll by dropping the follow the snap just re-engaged. Released after the scroll
    // event this queues has been dispatched.
    programmaticScrollRef.current = true;
    // Lands on the current layout; anything the window snap or the new message adds is
    // growth the re-engaged follow picks up through the ResizeObserver.
    scrollToBottom();
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [state.chatId, state.messages.length, scrollToBottom]);

  const loadOlderMessages = useCallback(() => {
    if (visibleStart === 0) return;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    const first = content?.querySelector<HTMLElement>('[data-message-id]');
    if (scroll && first) {
      const scrollRect = scroll.getBoundingClientRect();
      const firstRect = first.getBoundingClientRect();
      restorePrependScroll.current = {
        messageId: first.dataset.messageId!,
        offset: firstRect.top - scrollRect.top,
      };
    }
    setWindow((current) =>
      current.chatId === state.chatId
        ? {
            chatId: current.chatId,
            ...prependTranscriptWindow(
              { start: current.start, end: current.end },
              state.messages.length,
            ),
          }
        : current,
    );
  }, [visibleStart, state.chatId, state.messages.length]);

  const loadNewerMessages = useCallback(() => {
    if (visibleEnd >= state.messages.length) return;
    setWindow((current) =>
      current.chatId === state.chatId
        ? {
            chatId: current.chatId,
            ...appendTranscriptWindow(
              { start: current.start, end: current.end },
              state.messages.length,
            ),
          }
        : current,
    );
  }, [visibleEnd, state.chatId, state.messages.length]);

  // Scrolling up loads the next older page on the way — the reader is never made to ask.
  // A bounded window appends the next page when they reach its bottom, but only when the
  // window is not at the transcript's end: there the stick-to-bottom follow owns the
  // edge, and the two would cascade page loads against each other.
  //
  // The jump's centering scroll is marked programmatic, so it neither counts as a reader
  // scroll nor clears the jump's load-ahead suppression — the first real scroll does both.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onScroll = () => {
      if (programmaticScrollRef.current) return;
      suppressLoadAheadRef.current = false;
      if (!atEndRef.current) stopFollowing();
      if (scroll.scrollTop < LOAD_AHEAD_PX) loadOlderMessages();
      if (atEndRef.current) return;
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < LOAD_AHEAD_PX) {
        loadNewerMessages();
      }
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => scroll.removeEventListener('scroll', onScroll);
  }, [loadOlderMessages, loadNewerMessages, stopFollowing]);

  // The listeners run on scroll events; a page too short to scroll never fires one. After
  // a chat opens, a page lands, or a jump lands, keep loading while the reader is still
  // inside the load-ahead band. Declared after the restore effect so a load queued here
  // is restored on the next commit, not this one. A jump suppresses both until the reader
  // scrolls — the centering scroll is not a request for more pages.
  useLayoutEffect(() => {
    if (suppressLoadAheadRef.current) return;
    const scroll = scrollRef.current;
    if (!scroll || visibleStart === 0) return;
    // The chat-change effect has not synced the window yet; its scrollToBottom still runs.
    if (window.chatId !== state.chatId) return;
    if (scroll.scrollTop >= LOAD_AHEAD_PX) return;
    loadOlderMessages();
  }, [visibleStart, window.chatId, state.chatId, loadOlderMessages]);

  useLayoutEffect(() => {
    if (suppressLoadAheadRef.current) return;
    const scroll = scrollRef.current;
    if (!scroll || atEndRef.current) return;
    if (window.chatId !== state.chatId) return;
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= LOAD_AHEAD_PX) return;
    loadNewerMessages();
  }, [window, state.chatId, loadNewerMessages]);

  // A window anchored to the tail follows it. Without this, a reply streaming into a
  // window whose end was computed before the growth would land past the rendered rows and
  // be invisible — the transcript would look like the model said nothing.
  const lastCountRef = useRef(state.messages.length);
  useEffect(() => {
    const previous = lastCountRef.current;
    lastCountRef.current = state.messages.length;
    if (window.chatId !== state.chatId) return;
    if (state.messages.length > previous && window.end >= previous) {
      setWindow((current) =>
        current.chatId === state.chatId && current.end >= previous
          ? { ...current, end: state.messages.length }
          : current,
      );
    }
  }, [state.messages.length, window.chatId, state.chatId, window.end]);

  // --- The card reader -------------------------------------------------------

  /*
   * Three separate doors open it: Expand from the popover on an avatar, `/card`, and the
   * chat menu. Plain state — a re-render of this component costs the transcript nothing,
   * because every bubble prop is already referentially stable — with one hoisted opener so
   * the bubbles can reach it without taking a new prop identity every render.
   *
   * Declared above `runCommand` rather than beside the other hoisted callbacks: a
   * dependency array is evaluated during render, so a `const` declared further down would
   * still be in its temporal dead zone when that array is built.
   */
  const [cardReader, setCardReader] = useState<CardReaderInit | null>(null);
  const openCardReader = useCallback(
    (init: CardReaderInit = {}) => setCardReader({ query: init.query, sectionId: init.sectionId }),
    [],
  );
  const closeCardReader = useCallback(() => setCardReader(null), []);

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
        case 'rename': {
          if (!state.chatId) return 'No chat is open to rename.';
          chat.renameChat(command.title);
          return null;
        }
        // Reading, not mutating — so unlike its neighbours it needs no open chat and no
        // messages, and it cannot fail. `/card` on its own opens the reader; with an
        // argument it opens it already searching.
        case 'card': {
          openCardReader({ query: command.query });
          return null;
        }
        /*
         * Like `/card`, this reads rather than mutates the transcript, so it needs no open
         * chat and no messages. Unlike `/card` it can fail: the name has to resolve against
         * the live library, and a wrong guess would be recorded onto every message sent
         * afterwards. So an unmatched or ambiguous name is an error that keeps the draft.
         */
        case 'persona': {
          if (!command.query) {
            onOpenPanel('persona');
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
            const names = match.candidates.map((persona) => `"${persona.name}"`).join(', ');
            return `"${command.query}" matches ${match.candidates.length} personas — ${names}. Use the composer's persona chip to pick one.`;
          }
          return personas.length === 0
            ? 'There are no personas yet. Create one from the persona panel.'
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
      }
    },
    [
      state.chatId,
      state.messages,
      generationBlocked,
      chat,
      jumpTo,
      openCardReader,
      onOpenPanel,
      onSelectPersona,
      personas,
    ],
  );

  /**
   * The composer's one write path. Normal text goes to `chat.send`; a command-shaped
   * line is parsed here so it never reaches the provider. A `null` return clears the
   * composer; a string is an error that keeps the draft so nothing is lost.
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

  // --- Transcript edits (hoisted for memo) ----------------------------------

  /*
   * Hoisted so `memo` on MessageBubble is worth anything.
   *
   * Recreating these inline gives every row a new prop identity on every render, which
   * makes the memo compare unequal every time and re-render the whole transcript. Keyed on
   * the message id rather than closed over the message, so one stable callback serves
   * every row.
   *
   * All nine go through a ref rather than a dependency array, and the reason is that the
   * obvious `[chat]` does not work: `useChat` returns a fresh object literal on every
   * render, so keying on it rebuilt all nine every time and the memo below has never once
   * bailed out. Keying on the individual methods instead — `[chat.swipe]` and friends —
   * fixes the every-render case but not the rest: `swipe`, `regenerate` and `continueLast`
   * all descend from `generate`, whose own dependency list carries the stream and most of
   * the settings, so they still turn over whenever a setting changes. A ref is the only
   * version that is stable for the component's life, which is what the memo needs.
   *
   * Assigned during render rather than in an effect, matching `editCharacterRef` below:
   * these are only ever invoked from event handlers, which cannot run before the commit
   * that would have updated the ref, so there is no window in which reading it is stale.
   */
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const swipe = useCallback((direction: -1 | 1) => void chatRef.current.swipe(direction), []);
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

  /*
   * The same treatment, for the same reason, on a callback from `App` rather than from
   * `chat`: the only honest version of it closes over the selected avatar and a
   * `transitionToCharacter` that itself depends on `chat`, so a dependency array would hand
   * every row a new prop on every render.
   */
  const editCharacterRef = useRef(onEditCharacter);
  editCharacterRef.current = onEditCharacter;
  const editCharacter = useCallback(() => editCharacterRef.current(), []);

  /*
   * The card, out of band.
   *
   * Created once and synced from an effect, so the bubbles that carry the sheet's trigger
   * never see the card change identity — see `state/cardStore.ts` for what a plain prop
   * would cost while someone is typing in the character editor. `set` ignores a snapshot
   * that matches the one it holds, so running this on every render is free.
   */
  const [cardStore] = useState(createCardStore);
  useEffect(() => {
    cardStore.set({ avatar, card, render: chat.renderGreeting });
  }, [cardStore, avatar, card, chat.renderGreeting]);

  const lastId = state.messages[state.messages.length - 1]?.id ?? null;
  // A transcript ending on the user's turn is one still owed a reply — after a failure,
  // an abort, or deleting the reply. That is what makes retry available.
  const awaitingReply = Boolean(state.messages[state.messages.length - 1]?.is_user);

  const guides = state.metadata.guides ?? [];
  // Guided swipe needs a reply to make an alternate of. Both cases really do differ from
  // "no chat", so they get their own reasons rather than one vague "unavailable".
  const guidedSwipeDisabledReason = !lastId
    ? 'Nothing to swipe yet.'
    : awaitingReply
      ? 'Waiting on a reply — guide it instead.'
      : undefined;

  /*
   * Render-only text for the rows on screen: greeting macros, then regex scripts.
   *
   * One memo rather than a pass inside each bubble. The bubbles are memoised, and handing
   * them the script array — a new identity every time settings reload — plus a depth number
   * would churn every row on screen; doing it here also means one compiled-regex cache for
   * the whole window, and it is the only place that can run the greeting's macros BEFORE
   * the scripts see the text.
   *
   * `chat.renderGreeting`, not `chat`: the hook returns a fresh object literal every render,
   * so depending on it would re-run this unconditionally. The callback is memoised on the
   * character, preset, persona, chat state and variables, which is exactly what this needs.
   *
   * Only the visible window is transformed, but depth comes from the WHOLE transcript — a
   * script pinned to "the last three messages" has to mean that regardless of how far the
   * reader has scrolled.
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

      // Only rows the scripts actually changed get an entry, so every untouched bubble
      // keeps receiving `undefined` and its memo behaves exactly as it did before.
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

  /*
   * Creator notes are card text like any other, so they get the greeting's own macro pass.
   *
   * A card writes "{{user}} wakes up in {{char}}'s kitchen" in its notes and means the two
   * names — the notes sit beside a greeting whose macros are already resolved, so leaving
   * braces in the popover reads as a bug rather than as fidelity. Same resolver, so the
   * same fresh-runtime rule applies: a {{setvar}} in the notes cannot write to the chat.
   *
   * Before the scenario split rather than after it. A notes line hiding a macro whose value
   * spans lines would then leave a run of the wrong length, and `readScenarioNotes` renders
   * the notes whole — the fallback it is built to take, and better than a wrong highlight.
   */
  const renderedNotes = useMemo(
    () => (creatorNotes.trim() ? chat.renderGreeting(creatorNotes) : creatorNotes),
    [creatorNotes, chat.renderGreeting],
  );

  return (
    <div className="chat-view">
      {/* Portals itself into the shell's overlay root, over the chat column. */}
      {cardReader ? (
        <CardReader
          store={cardStore}
          init={cardReader}
          onClose={closeCardReader}
          onEditCharacter={editCharacter}
          busy={busy}
        />
      ) : null}

      <div className="chat-view__scroll" ref={scrollRef}>
        <div className="chat-view__content" ref={contentRef}>
          {state.messages.length === 0 ? (
            <div className="wc-empty">
              <span>No messages yet. Say something to {characterName}.</span>
            </div>
          ) : (
            visibleMessages.map((message, index) => {
              const messageIndex = visibleStart + index;
              const shared = {
                message,
                streaming: state.streamingId === message.id,
                mode: state.mode,
                stream,
                isLast: message.id === lastId,
                busy,
                summaryRunning: chat.summaryStatus.running,
                displayText: displayTexts.get(message.id)?.text,
                displayReasoning: displayTexts.get(message.id)?.reasoning,
                // Row 0 only: the notes explain which greeting you are looking at, and
                // nothing below the opening message is a greeting.
                creatorNotes: messageIndex === 0 ? renderedNotes : undefined,
                greetingCount: messageIndex === 0 ? greetingCount : undefined,
                onSwipe: swipe,
                onRegenerate: regenerate,
                onContinue: continueLast,
                onRetry: regenerate,
                onEdit: editMessage,
                onEditReasoning: editReasoning,
                onDelete: deleteMessage,
                onToggleHidden: toggleHidden,
                onBranch: branchFrom,
              };
              if (message.is_user) {
                const speaker = speakerOf(message);
                return (
                  <UserMessageBubble
                    key={message.id}
                    {...shared}
                    persona={speaker}
                    avatarVersion={speaker ? personaAvatarVersions?.[speaker.id] : undefined}
                    // Lookups, not the settings object: an unrelated settings change
                    // must not re-render every user row.
                    dialogueEnabled={dialogueColors.enabled}
                    override={speaker ? dialogueColors.personas[speaker.id] : undefined}
                  />
                );
              }
              return (
                <MessageBubble
                  key={message.id}
                  {...shared}
                  avatarUrl={characterAvatarUrl}
                  dialogueActive={characterDialogue.active}
                  dialogueColor={characterDialogue.color}
                  // Character rows only. A persona has no card, so a user row's avatar
                  // stays a picture rather than becoming a control that opens someone
                  // else's description.
                  cardStore={cardStore}
                  onEditCharacter={editCharacter}
                  onOpenCardReader={openCardReader}
                />
              );
            })
          )}
        </div>
      </div>

      {/*
        The dock: everything pinned below the transcript, OUTSIDE the scroll container.
        That placement is the anchor — a composer rendered inside `.chat-view__scroll`
        scrolls away with the messages, which is exactly the regression this undoes. It
        still grows with the draft; growth shrinks the transcript's viewport instead of
        extending a page, and `useStickToBottom` re-pins the bottom as it does, so the
        message above stays readable beside what you are typing.
      */}
      <div className="chat-view__dock">
        {state.error ? (
          <div className="chat-view__error" role="alert">
            <span className="chat-view__error-text">{state.error}</span>
            {/* The whole point of a failure notice: a way to try again without retyping. */}
            {awaitingReply ? (
              <button
                type="button"
                className="wc-button chat-view__retry"
                onClick={() => void chat.regenerate()}
                disabled={busy || !ready}
              >
                <RefreshIcon />
                Retry
              </button>
            ) : null}
          </div>
        ) : null}

        {chat.saveError ? (
          <div className="chat-view__error" role="alert">
            <span className="chat-view__error-text">
              Could not save this chat: {chat.saveError}
            </span>
            <button
              type="button"
              className="wc-button chat-view__retry"
              onClick={() => void chat.retrySave()}
              disabled={busy || chat.saving}
            >
              <RefreshIcon />
              Retry save
            </button>
          </div>
        ) : null}

        {chat.loadError ? (
          <div className="chat-view__error" role="alert">
            <span className="chat-view__error-text">
              Could not load this character's chats: {chat.loadError}
            </span>
            <button
              type="button"
              className="wc-button chat-view__retry"
              onClick={chat.retryLoad}
              disabled={busy}
            >
              <RefreshIcon />
              Retry load
            </button>
          </div>
        ) : null}

        <Composer
          ref={composerRef}
          onSend={handleSend}
          // The other two composer submits. Both put new text at the end of the transcript,
          // so both earn the same snap as an ordinary send.
          onGuide={(text) => {
            snapToEnd();
            void chat.guidedRespond(text);
          }}
          onGuidedSwipe={(text) => {
            snapToEnd();
            void chat.guidedSwipe(text);
          }}
          guidedSwipeDisabledReason={guidedSwipeDisabledReason}
          onStop={chat.summaryStatus.running ? chat.cancelSummary : chat.abort}
          busy={generationBlocked}
          disabled={!ready || loadBlocksChat}
          // Who you are writing as. `chat.persona` rather than the raw setting, because a
          // loaded chat adopts its own recorded persona — the chip has to show the one that
          // will actually be stamped onto the next message.
          identity={
            <PersonaChip
              personas={personas}
              active={chat.persona}
              recentIds={recentPersonaIds}
              avatarVersions={personaAvatarVersions ?? {}}
              onSelect={onSelectPersona}
              onManage={() => onOpenPanel('persona')}
            />
          }
          // Deliberately not gated on `ready`: closing or starting a chat has to work
          // before a connection is configured.
          leading={
            <>
              <ChatMenu
                chat={chat}
                onCloseChat={onCloseChat}
                onOpenPanel={onOpenPanel}
                onImportChat={onImportChat}
                onOpenCard={openCardReader}
              />
              <QuickCommands
                quickCommands={quickCommands}
                onInsertCommand={(text) => composerRef.current?.insert(text)}
                onQuickCommandsChange={onQuickCommandsChange}
              />
            </>
          }
          // Persistent guides sits with the draft actions, not with the menus: it and the
          // wand are one idea — a standing instruction and a per-turn one — and they used
          // to sit on opposite sides of the field with the whole input between them.
          trailing={
            <GuidesPopover
              guides={guides}
              onGuidesChange={(next) => chat.updateMetadata({ guides: next })}
              guidance={guidance}
              onGuidanceChange={onGuidanceChange}
              disabled={!state.chatId}
            />
          }
          placeholder={
            loadBlocksChat
              ? 'Retry loading this character before sending a message.'
              : ready
                ? `Message ${characterName}…`
                : 'Configure an endpoint and model in the Connections panel first.'
          }
        />
      </div>
    </div>
  );
}

type UserMessageBubbleProps = Omit<
  ComponentProps<typeof MessageBubble>,
  'avatarUrl' | 'dialogueActive' | 'dialogueColor'
> & {
  /** The persona this message was sent as, already resolved from its recorded id. */
  persona: Persona | null;
  avatarVersion: number | undefined;
  dialogueEnabled: boolean;
  /** This speaker's colour override, if any. */
  override: DialogueColorOverride | undefined;
};

/**
 * A user row with its speaker's presentation resolved per message.
 *
 * The avatar-colour extraction is a hook, so it cannot run in the transcript loop for an
 * arbitrary number of speakers — it lives here, one leaf per row. Repeat rows for one
 * persona hit the module-level colour cache, so the extraction still runs once per avatar.
 */
const UserMessageBubble = memo(function UserMessageBubble({
  persona,
  avatarVersion,
  dialogueEnabled,
  override,
  ...rest
}: UserMessageBubbleProps) {
  // Keyed on the filename so replacing the image busts the cache instead of showing the
  // old one until a reload.
  const avatarUrl = persona?.avatar
    ? personaApi.avatarUrl(persona.id, avatarVersion ?? persona.avatar)
    : null;
  const autoColor = useAvatarColor(dialogueEnabled && override === undefined ? avatarUrl : null);
  const dialogue = resolveDialogueColor(dialogueEnabled, override, autoColor);

  return (
    <MessageBubble
      {...rest}
      avatarUrl={avatarUrl}
      dialogueActive={dialogue.active}
      dialogueColor={dialogue.color}
    />
  );
});
