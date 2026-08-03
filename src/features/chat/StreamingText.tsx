import { Fragment, type ReactNode, useSyncExternalStore } from 'react';
import { Reasoning } from './Reasoning.tsx';
import { streamSegments } from './dialogue.ts';
import type { StreamStore } from './state/streamStore.ts';

/**
 * The only component that re-renders while a reply streams.
 *
 * Rendering a hand-rolled pass rather than markdown is deliberate: a markdown parser
 * re-parses the whole growing string on every tick, which is quadratic over a long
 * reply. `streamSegments` approximates the two transforms users notice mid-stream —
 * dialogue colouring and asterisk emphasis — in a single linear pass. The bubble swaps
 * to rendered markdown the moment the generation commits, which stays authoritative.
 */
export function StreamingText({ store }: { store: StreamStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return (
    <>
      {/*
       * Open while streaming, collapsed once settled. Reasoning arrives before any content
       * does, so a collapsed box during that window would leave the bubble looking frozen
       * with nothing to watch.
       */}
      {snapshot.reasoning ? <Reasoning text={snapshot.reasoning} defaultOpen /> : null}
      <div className="message__text message__text--streaming">
        {streamSegments(snapshot.text).map((segment, index) => {
          if (segment.hidden) return null;
          let content: ReactNode = segment.text;
          if (segment.dialogue) {
            content = <span className="message__dialogue">{content}</span>;
          }
          for (const kind of [...segment.emphasis].reverse()) {
            content = kind === 'strong' ? <strong>{content}</strong> : <em>{content}</em>;
          }
          return <Fragment key={`${index}:${segment.text}`}>{content}</Fragment>;
        })}
        <span className="message__caret" aria-hidden="true" />
      </div>
    </>
  );
}
