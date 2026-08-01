import { useSyncExternalStore } from 'react';
import { Reasoning } from './Reasoning.tsx';
import type { StreamStore } from './state/streamStore.ts';

/**
 * The only component that re-renders while a reply streams.
 *
 * Rendering plain text rather than markdown is deliberate: a markdown parser re-parses
 * the whole growing string on every tick, which is quadratic over a long reply. The
 * bubble swaps to rendered markdown the moment the generation commits.
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
        {snapshot.text}
        <span className="message__caret" aria-hidden="true" />
      </div>
    </>
  );
}
