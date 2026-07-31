import { useSyncExternalStore } from 'react';
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
      {snapshot.reasoning ? (
        <details className="message__reasoning">
          <summary>Thinking</summary>
          <div className="message__reasoning-body">{snapshot.reasoning}</div>
        </details>
      ) : null}
      <div className="message__text message__text--streaming">
        {snapshot.text}
        <span className="message__caret" aria-hidden="true" />
      </div>
    </>
  );
}
