import { currentInfo, currentText, timestamp } from '@shared/chat/message.ts';
import { isSlotFilled } from '@shared/cocreator/stash.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type {
  CardSlot,
  CocreatorSession,
  ExampleField,
  SingleCardSlot,
} from '@shared/types/cocreator.ts';
import { SINGLE_SLOTS } from '@shared/types/cocreator.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { CoCreatorSettings } from '@shared/types/settings.ts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PersistenceControls } from '../../lib/autosave.ts';
import { AvatarDrop } from './AvatarDrop.tsx';
import { SLOT_LABELS } from './blocks.ts';
import { CocreatorComposer } from './CocreatorComposer.tsx';
import { CocreatorSetup } from './CocreatorSetup.tsx';
import { DesignMessage } from './DesignMessage.tsx';
import { ExamplesPanel } from './ExamplesPanel.tsx';
import { finishSession } from './finish.ts';
import { isAnalyseRequest, renderStashRequest } from './prompt.ts';
import { StashPanel } from './StashPanel.tsx';
import { type CocreatorAction, cocreatorReducer } from './state/cocreatorReducer.ts';
import { useCocreator } from './useCocreator.ts';
import { useExampleCards } from './useExampleCards.ts';

interface CocreatorDeskProps {
  session: CocreatorSession;
  defaults: CoCreatorSettings;
  connections: Connection[];
  activeConnectionId: string | null;
  presets: PresetSummary[];
  activePresetId: string | null;
  activePreset: Preset | null;
  tokenizerEncoding?: 'auto' | 'o200k_base' | 'cl100k_base';
  onDefaultsChange: (patch: Partial<CoCreatorSettings>) => void;
  /** The library, for the example picker. */
  characters: readonly CharacterSummary[];
  streamingFps: number;
  registerPersistence: (controls: PersistenceControls | null) => void;
  onStatusChange: (status: string) => void;
  /** Hand the finished card to the Studio. */
  onFinished: (avatar: string) => void;
  onError: (message: string) => void;
}

/** The design conversation. Examples and the stash join it in the next phases. */
export function CocreatorDesk({
  session,
  defaults,
  connections,
  activeConnectionId,
  presets,
  activePresetId,
  activePreset,
  tokenizerEncoding,
  onDefaultsChange,
  characters,
  streamingFps,
  registerPersistence,
  onStatusChange,
  onFinished,
  onError,
}: CocreatorDeskProps) {
  const exampleBlockRef = useRef('');
  const design = useCocreator({
    session,
    defaults,
    connections,
    activeConnectionId,
    presets,
    activePresetId,
    activePreset,
    tokenizerEncoding,
    exampleBlockRef,
    streamingFps,
  });

  const { countTokens } = design;

  const loadedExamples = useExampleCards(design.state.examples, countTokens);
  // The latest-value ref pattern the rest of this codebase uses: assigning during render
  // keeps the next generation on the block the panel is currently showing.
  exampleBlockRef.current = loadedExamples.text;

  const stateRef = useRef(design.state);
  stateRef.current = design.state;

  const [setupOpen, setSetupOpen] = useState(false);
  const [setupMode, setSetupMode] = useState<'session' | 'defaults'>('session');
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const programmatic = useRef(false);
  const { persistence, saving, saveError, state, busy, blockedReason } = design;

  useEffect(() => {
    registerPersistence(persistence);
    return () => registerPersistence(null);
  }, [persistence, registerPersistence]);

  useEffect(() => {
    onStatusChange(saveError ? saveError : saving ? 'Saving…' : '');
  }, [saving, saveError, onStatusChange]);

  /*
   * Follow the tail.
   *
   * A layout effect, not an effect: on mount it runs before paint, so opening a session with
   * history does not flash the top of the transcript before jumping. The transcript is short
   * enough that chat's windowing scheme would be machinery with no problem to solve — a
   * design session is tens of turns, not hundreds.
   *
   * Only scrolls when the user is already at the bottom — scrolling up to read something
   * pauses the follow until they come back down.
   */
  const pinBottom = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    programmatic.current = true;
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, []);

  // Track whether the user is still at the bottom.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const onScroll = () => {
      if (programmatic.current) return;
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      following.current = distance <= 80;
    };

    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  // Follow content growth React never re-rendered the list for (per-token streaming).
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      if (following.current) pinBottom();
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, [pinBottom]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the trigger
  useLayoutEffect(() => {
    if (following.current) pinBottom();
  }, [state.messages.length, state.status, pinBottom]);

  /**
   * File a piece of the transcript into a slot.
   *
   * Provenance is captured here rather than in the reducer because this is the only place
   * that knows which message and swipe the text was read from — and that is the whole point
   * of recording it: with free model swapping, a finished card can be three models' work.
   */
  const handleUse = useCallback(
    (
      messageId: string,
      swipeIndex: number,
      model: string | undefined,
      slot: CardSlot,
      text: string,
      source: 'block' | 'message' | 'selection',
      label?: string,
    ) => {
      design.dispatch({
        type: 'stash/set',
        slot,
        text,
        provenance: {
          messageId,
          swipeIndex,
          at: timestamp(),
          source,
          ...(model ? { model } : {}),
          ...(label ? { label } : {}),
        },
      });
    },
    [design],
  );

  const isFilled = useCallback((slot: CardSlot) => isSlotFilled(state.stash, slot), [state.stash]);

  /** Show the assistant the stash — as a visible turn, never as a hidden prompt addition. */
  const showStashToModel = useCallback(() => {
    const slots: { label: string; text: string }[] = [];
    for (const slot of SINGLE_SLOTS) {
      const entry = state.stash[slot];
      if (entry?.text) slots.push({ label: SLOT_LABELS[slot], text: entry.text });
    }
    state.stash.alternate_greetings.forEach((entry, index) => {
      slots.push({ label: `${SLOT_LABELS.alternate_greeting} #${index + 1}`, text: entry.text });
    });
    if (state.stash.tags.length) {
      slots.push({ label: SLOT_LABELS.tags, text: state.stash.tags.map((e) => e.text).join(', ') });
    }
    void design.send(renderStashRequest(slots));
  }, [design, state.stash]);

  const analysed = useMemo(
    () =>
      state.messages.some(
        (message) =>
          message.is_user &&
          (currentInfo(message).extra?.coCreatorAction === 'analyseExamples' ||
            isAnalyseRequest(currentText(message))),
      ),
    [state.messages],
  );

  const [finishing, setFinishing] = useState(false);

  /**
   * Create the card, then hand off.
   *
   * Flush first, and let a failed flush abort — the same bargain every navigation edge in
   * this app makes. Recording which card the session produced rides the ordinary autosave
   * rather than a second write path, so there is only one way a session reaches the server.
   */
  const finish = useCallback(async () => {
    setFinishing(true);
    try {
      await design.flushSaves();
      const avatar = await finishSession({
        sessionId: session.id,
        stash: stateRef.current.stash,
        avatar: stateRef.current.avatar,
        cacheKey: session.modified,
      });
      // Flushed against the state the reducer produces, not the ref: React has not
      // re-rendered yet, so `stateRef` still holds the pre-dispatch revision and the flush
      // would find nothing dirty — leaving `finishedAvatar` to a debounced save racing the
      // navigation below. Same pattern `useCocreator.send` uses to generate from a turn it
      // has only just dispatched.
      const recorded: CocreatorAction = { type: 'finished/recorded', avatar };
      const next = cocreatorReducer(stateRef.current, recorded);
      design.dispatch(recorded);
      await design.flushSaves(next);
      onFinished(avatar);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setFinishing(false);
    }
  }, [design, session.id, session.modified, onFinished, onError]);

  const lastIndex = state.messages.length - 1;

  return (
    <>
      <CocreatorSetup
        design={design}
        defaults={defaults}
        connections={connections}
        activeConnectionId={activeConnectionId}
        presets={presets}
        activePresetId={activePresetId}
        onDefaultsChange={onDefaultsChange}
        open={setupOpen}
        onOpenChange={setSetupOpen}
        mode={setupMode}
        onModeChange={setSetupMode}
      />
      <div className="cocreator-desk">
        <ExamplesPanel
          selection={state.examples}
          loaded={loadedExamples}
          characters={characters}
          exampleSets={defaults.exampleSets ?? []}
          busy={busy}
          analysed={analysed}
          onAdd={(avatar) => design.dispatch({ type: 'examples/add', avatar })}
          onRemove={(avatar) => design.dispatch({ type: 'examples/remove', avatar })}
          onSetField={(field: ExampleField, on) =>
            design.dispatch({ type: 'examples/setField', field, on })
          }
          onApplySet={(set) =>
            design.dispatch({
              type: 'examples/applySet',
              cards: set.cards,
              fields: set.fields,
            })
          }
          onExampleSetsChange={(sets) => onDefaultsChange({ exampleSets: sets })}
          onAnalyse={() =>
            void design.send(design.analysisPrompt, { coCreatorAction: 'analyseExamples' })
          }
        />

        <div className="cocreator-transcript">
          <div className="cocreator-transcript__scroll" ref={scrollRef}>
            <div className="cocreator-transcript__list" ref={contentRef}>
              {state.messages.length === 0 ? (
                <p className="wc-empty">
                  Describe the character you have in mind, and work it out together.
                </p>
              ) : (
                state.messages.map((message, index) => (
                  <DesignMessage
                    key={message.id}
                    message={message}
                    canReroll={index === lastIndex && !message.is_user}
                    canRetry={index === lastIndex && message.is_user}
                    streaming={state.streamingId === message.id && state.status !== 'idle'}
                    stream={design.stream}
                    busy={busy}
                    countTokens={countTokens}
                    isFilled={isFilled}
                    onUse={(slot, text, source, label) =>
                      handleUse(
                        message.id,
                        message.swipe_id,
                        message.swipe_info[message.swipe_id]?.extra?.model as string | undefined,
                        slot,
                        text,
                        source,
                        label,
                      )
                    }
                    onSelectSwipe={(id, swipeIndex) =>
                      design.dispatch({ type: 'swipe/select', id, index: swipeIndex })
                    }
                    onReroll={() => void design.reroll()}
                    onRetry={() => void design.retry()}
                    onEdit={(id, text) => design.dispatch({ type: 'message/edited', id, text })}
                    onDelete={(id) => design.dispatch({ type: 'message/deleted', id })}
                  />
                ))
              )}

              {state.error ? (
                <p className="cocreator-transcript__error" role="alert">
                  {state.error}
                </p>
              ) : null}
            </div>
          </div>

          <CocreatorComposer
            busy={busy}
            blockedReason={blockedReason}
            onSend={(text) => void design.send(text)}
            onStop={design.abort}
            quickCommands={defaults.quickCommands ?? []}
            onQuickCommandsChange={(quickCommands) => onDefaultsChange({ quickCommands })}
          />
        </div>

        <StashPanel
          stash={state.stash}
          countTokens={countTokens}
          busy={busy}
          onEditSlot={(slot: SingleCardSlot, text) =>
            design.dispatch({ type: 'stash/editSlot', slot, text })
          }
          onEditGreeting={(index, text) =>
            design.dispatch({ type: 'stash/editGreeting', index, text })
          }
          onMoveGreeting={(from, to) =>
            design.dispatch({ type: 'stash/reorderGreetings', from, to })
          }
          onRemoveGreeting={(index) => design.dispatch({ type: 'stash/removeGreeting', index })}
          onRemoveTag={(index) => design.dispatch({ type: 'stash/removeTag', index })}
          onClearSlot={(slot) => design.dispatch({ type: 'stash/clear', slot })}
          onShowModel={showStashToModel}
          onFinish={() => void finish()}
          finishing={finishing}
          avatarSlot={
            <AvatarDrop
              sessionId={session.id}
              avatar={state.avatar}
              cacheKey={session.modified}
              busy={busy || finishing}
              onChanged={(avatar) =>
                design.dispatch(
                  avatar ? { type: 'avatar/set', filename: avatar } : { type: 'avatar/cleared' },
                )
              }
              onError={onError}
            />
          }
        />
      </div>
    </>
  );
}
