import { Fragment, type ReactNode, useSyncExternalStore } from 'react';
import { streamSegments } from './dialogue.ts';
import { Reasoning } from './Reasoning.tsx';
import type { StreamStore } from './state/streamStore.ts';

/**
 * The only component that re-renders while a reply streams.
 *
 * Rendering a hand-rolled pass rather than markdown is deliberate: a markdown parser
 * re-parses the whole growing string on every tick, which is quadratic over a long
 * reply. `streamSegments` approximates the two transforms users notice mid-stream —
 * dialogue colouring and asterisk emphasis — in a single linear pass. The bubble swaps
 * to rendered markdown the moment the generation commits, which stays authoritative.
 *
 * Regex scripts do not run here either, for the same reason and one more: most useful ones
 * are anchored, or match a closing delimiter that does not exist until the reply ends. A
 * script that strips a `<think>` block would show the raw block for the whole stream and
 * then snap — flicker that reads as a bug. Scripts ride the swap to markdown instead.
 */
export function StreamingText({
  store,
  hideReasoning,
}: {
  store: StreamStore;
  /**
   * Suppress the thinking block. The recap overlay sets this: it renders a settled recap
   * through Markdown, which never shows reasoning, so a box that appears mid-stream and
   * vanishes at the swap reads as a flicker rather than as information.
   */
  hideReasoning?: boolean;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const segments = streamSegments(snapshot.text);
  let offset = 0;

  return (
    <>
      {/*
       * Open while streaming, collapsed once settled. Reasoning arrives before any content
       * does, so a collapsed box during that window would leave the bubble looking frozen
       * with nothing to watch.
       */}
      {snapshot.reasoning && !hideReasoning ? (
        <Reasoning text={snapshot.reasoning} defaultOpen />
      ) : null}
      <div className="message__text message__text--streaming">
        {segments.map((segment) => {
          // The source offset stays stable as a stream grows, unlike an array index when
          // emphasis delimiters split or merge adjacent display segments.
          const key = `${offset}:${segment.text}`;
          offset += segment.text.length;
          if (segment.hidden) return null;
          let content: ReactNode = segment.text;
          if (segment.dialogue) {
            content = <span className="message__dialogue">{content}</span>;
          }
          for (const kind of [...segment.emphasis].reverse()) {
            content = kind === 'strong' ? <strong>{content}</strong> : <em>{content}</em>;
          }
          return <Fragment key={key}>{content}</Fragment>;
        })}
        {/*
         * Only while tokens actually trickle in. With streaming off the reply lands in
         * one piece, so the caret would sit blinking at an empty bubble for the whole
         * wait — motion that indicates nothing. The Stop button carries the busy state.
         */}
        {snapshot.incremental ? <span className="message__caret" aria-hidden="true" /> : null}
      </div>
    </>
  );
}
