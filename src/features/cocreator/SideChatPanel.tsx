import type { MessageState } from '@shared/chat/message.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { CardSlot } from '@shared/types/cocreator.ts';
import type { CoCreatorSettings } from '@shared/types/settings.ts';
import { type Ref, useLayoutEffect, useRef, useState } from 'react';
import { useStickToBottom } from '../chat/useStickToBottom.ts';
import { useTranscriptWindow } from '../chat/useTranscriptWindow.ts';
import { CocreatorComposer, type CocreatorComposerHandle } from './CocreatorComposer.tsx';
import { DesignMessage } from './DesignMessage.tsx';
import { SideChatSetup } from './SideChatSetup.tsx';
import { parseCocreatorInput } from './slashCommands.ts';
import type { UseCocreator } from './useCocreator.ts';

interface SideChatPanelProps {
  design: UseCocreator;
  defaults: CoCreatorSettings;
  connections: Connection[];
  active: boolean;
  examplesReady: boolean;
  composerRef: Ref<CocreatorComposerHandle>;
  onDefaultsChange: (patch: Partial<CoCreatorSettings>) => void;
  onReset: () => void;
  onClose: () => void;
  onInsert: (text: string) => void;
  isFilled: (slot: CardSlot) => boolean;
  onUse: (
    message: MessageState,
    slot: CardSlot,
    text: string,
    source: 'block' | 'message' | 'selection',
    label?: string,
  ) => void;
}

export function SideChatPanel({
  design,
  defaults,
  connections,
  active,
  examplesReady,
  composerRef,
  onDefaultsChange,
  onReset,
  onClose,
  onInsert,
  isFilled,
  onUse,
}: SideChatPanelProps) {
  const side = design.state.sideChat;
  const [confirmReset, setConfirmReset] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { scrollToBottom, stopFollowing, isFollowing } = useStickToBottom(scrollRef, contentRef);
  const messages = side?.messages ?? [];
  const { start, end, snapToEnd } = useTranscriptWindow({
    transcriptKey: `${design.state.sessionId}:${side?.snapshot.capturedAt ?? 'empty'}`,
    messageCount: messages.length,
    scrollRef,
    contentRef,
    scrollToBottom,
    stopFollowing,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: active and message/status changes trigger layout
  useLayoutEffect(() => {
    if (active && isFollowing.current) scrollToBottom();
  }, [active, messages.length, design.state.status, scrollToBottom, isFollowing]);
  const busyReason =
    design.state.activeConversation === 'side'
      ? 'Side chat is generating'
      : 'Main chat is generating';
  const context = design.sideContext;
  const blockedReason = !side ? 'Preparing main context…' : design.sideBlockedReason;

  return (
    <section className="cocreator-side" aria-label="Side chat">
      <header className="cocreator-side__header">
        <span
          className="cocreator-side__model"
          title={
            design.sideConnection
              ? `${design.sideConnection.name} · ${design.sideConnection.model}`
              : 'Choose a side model in settings'
          }
        >
          {design.sideConnection?.model || 'Choose a side model'}
        </span>
        <SideChatSetup
          design={design}
          defaults={defaults}
          connections={connections}
          onDefaultsChange={onDefaultsChange}
        />
        <button type="button" className="wc-button wc-button--ghost" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="cocreator-side__context">
        <details onToggle={(event) => setContextOpen(event.currentTarget.open)}>
          <summary>
            {side
              ? `Context snapshot · ${new Date(side.snapshot.capturedAt).toLocaleString()}`
              : 'Preparing context snapshot…'}
          </summary>
          {side && contextOpen ? (
            <div className="cocreator-side__snapshot">
              <p className="wc-hint">
                Frozen main instructions, examples and {side.snapshot.messages.length} messages.
                Start fresh to capture later changes.
              </p>
              <h3>Main instructions</h3>
              <pre>{side.snapshot.systemPrompt}</pre>
              {side.snapshot.exampleBlock ? (
                <>
                  <h3>Attached examples</h3>
                  <pre>{side.snapshot.exampleBlock}</pre>
                </>
              ) : null}
              <h3>Main conversation</h3>
              <pre>
                {side.snapshot.messages
                  .map((m) => `${m.role === 'user' ? 'You' : 'Design assistant'}:\n${m.content}`)
                  .join('\n\n')}
              </pre>
            </div>
          ) : null}
        </details>
        {context ? (
          <p className="wc-hint" role="status">
            {context.totalTokens.toLocaleString()} prompt tokens · {context.droppedMainMessages}{' '}
            main / {context.droppedSideMessages} side messages omitted
          </p>
        ) : null}
        <button
          type="button"
          className="wc-button wc-button--ghost"
          data-confirming={confirmReset}
          disabled={design.busy || !examplesReady || !side}
          title={
            design.busy
              ? busyReason
              : !examplesReady
                ? 'Waiting for attached examples'
                : confirmReset
                  ? 'Click again to clear side history and capture fresh context'
                  : 'Clear side history and capture fresh context'
          }
          onClick={() => {
            if (confirmReset) {
              onReset();
              setInputError(null);
              setConfirmReset(false);
            } else setConfirmReset(true);
          }}
          onBlur={() => setConfirmReset(false)}
        >
          {confirmReset ? 'Click again to start fresh' : 'Start fresh'}
        </button>
      </div>
      <div className="cocreator-side__scroll" ref={scrollRef}>
        <div className="cocreator-side__messages" ref={contentRef}>
          {!messages.length ? (
            <p className="wc-empty">
              Ask for a name, explore an idea, or work out an answer. Only what you choose to bring
              back reaches the main conversation.
            </p>
          ) : null}
          {messages.slice(start, end).map((message, index) => (
            <DesignMessage
              key={message.id}
              message={message}
              canReroll={start + index === messages.length - 1 && !message.is_user}
              canRetry={start + index === messages.length - 1 && message.is_user}
              streaming={
                design.state.activeConversation === 'side' &&
                design.state.streamingId === message.id &&
                design.busy
              }
              stream={design.stream}
              busy={design.busy}
              busyReason={busyReason}
              countTokens={design.sideCountTokens}
              isFilled={isFilled}
              onUse={(slot, text, source, label) => onUse(message, slot, text, source, label)}
              onInsert={onInsert}
              onSelectSwipe={(id, index) =>
                design.dispatch({ type: 'swipe/select', target: 'side', id, index })
              }
              onReroll={() => {
                snapToEnd();
                void design.rerollSide();
              }}
              onRetry={() => {
                snapToEnd();
                void design.retrySide();
              }}
              onContinue={() => {
                snapToEnd();
                void design.continueSide();
              }}
              onEdit={(id, text) =>
                design.dispatch({ type: 'message/edited', target: 'side', id, text })
              }
              onDelete={(id) => design.dispatch({ type: 'message/deleted', target: 'side', id })}
            />
          ))}
          {inputError || side?.error || blockedReason ? (
            <p className="cocreator-transcript__error" role="alert">
              {inputError || side?.error || blockedReason}
            </p>
          ) : null}
        </div>
      </div>
      <CocreatorComposer
        ref={composerRef}
        autoFocus={false}
        label="Side chat message"
        placeholder="Ask a side question…"
        busy={design.busy}
        busyReason={busyReason}
        blockedReason={blockedReason}
        onSend={(text) => {
          const input = parseCocreatorInput(text);
          if (input.type === 'error') {
            setInputError(input.message);
            return false;
          }
          setInputError(null);
          if (input.type === 'openSide') return true;
          const accepted = design.sendSide(input.text);
          if (accepted) snapToEnd();
          return accepted;
        }}
        onStop={design.abort}
        quickCommands={defaults.quickCommands ?? []}
        onQuickCommandsChange={(quickCommands) => onDefaultsChange({ quickCommands })}
      />
    </section>
  );
}
