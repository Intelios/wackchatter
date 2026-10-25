import { useSyncExternalStore } from 'react';
import { Reasoning } from '../chat/Reasoning.tsx';
import type { StreamStore } from '../chat/state/streamStore.ts';
import '../chat/MessageBubble.css';
import '../chat/Composer.css';

/**
 * The working bubble both conversations show while a reply streams.
 *
 * It reuses the main chat's bubble classes and its Reasoning box, and adds the one thing
 * the main chat keeps on its composer: the lime scan light patrolling the border while
 * the model works. A turn that is between provider requests (a tool executing) has no
 * text to show, so the ring plus a quiet status word is what says "still going".
 *
 * This is the preset Co-Creator's one streaming leaf, exactly as the main chat's
 * `StreamingText`: the growing text lives in the external stream store and reaches this
 * component alone through `useSyncExternalStore`, so a reply that arrives over sixty
 * frames re-renders sixty leaves and nothing above them.
 */
export function StreamingBubble({
  name,
  initial,
  store,
  note,
}: {
  name: string;
  initial: string;
  store: StreamStore;
  /** The status word shown before the first token arrives. */
  note: string;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <article className="message preset-cc-streaming" data-role="assistant">
      <div className="message__bubble">
        <header className="message__head">
          <div className="message__avatar">
            <span aria-hidden="true">{initial.slice(0, 1).toUpperCase()}</span>
          </div>
          <div className="message__ident">
            <span className="message__name">{name}</span>
            <span className="message__stream-note" role="status">
              {snapshot.text || snapshot.reasoning ? 'responding' : note}
            </span>
          </div>
        </header>
        {snapshot.reasoning ? <Reasoning text={snapshot.reasoning} defaultOpen /> : null}
        <div className="message__text message__text--streaming">
          {snapshot.text}
          {/*
           * Only while tokens actually trickle in, the same bargain as the main chat: a
           * non-streamed reply lands in one piece, and a caret blinking at an empty bubble
           * for the whole wait would indicate nothing.
           */}
          {snapshot.incremental ? <span className="message__caret" aria-hidden="true" /> : null}
        </div>
      </div>
    </article>
  );
}
