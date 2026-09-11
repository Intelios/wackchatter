import type { NexusNodeKind } from '@shared/nexus/types.ts';
import { useId } from 'react';

/** Shared geometry and stroke weight keep the six marks legible at map scale. */
const MARKS: Record<NexusNodeKind, string> = {
  person: 'M0 -7a3 3 0 1 0 0 6a3 3 0 1 0 0 -6 M-6 7v-1a6 6 0 0 1 12 0v1',
  place: 'M0 8S-6 1-6 -2a6 6 0 0 1 12 0C6 1 0 8 0 8 M0 -4a2 2 0 1 0 0 4a2 2 0 1 0 0 -4',
  object: 'M0 -8L7 -4v8L0 8l-7 -4v-8Z M-7 -4L0 0l7 -4 M0 0v8 M-3.5 -6l7 4',
  event: 'M1 -8L-6 1h5l-1 7L6 -1H1Z',
  group:
    'M0 -7a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0 -5 M-4 7V5a4 4 0 0 1 8 0v2 M-6 -4a2 2 0 0 0 0 4 M6 -4a2 2 0 0 1 0 4 M-8 6V4a3 3 0 0 1 3 -3 M8 6V4a3 3 0 0 0 -3 -3',
  concept: 'M-3 3C-3 0-6 0-6 -3a6 6 0 0 1 12 0C6 0 3 0 3 3Z M-3 6h6 M-1 9h2',
};

export function NexusNodeArt({ kind }: { kind: NexusNodeKind }) {
  const id = useId();
  return (
    <>
      <defs>
        <radialGradient id={`${id}-core`} cx="32%" cy="22%" r="85%">
          <stop offset="0" className="nexus-core-light" />
          <stop offset="0.55" className="nexus-core-mid" />
          <stop offset="1" className="nexus-core-dark" />
        </radialGradient>
        <radialGradient id={`${id}-halo`}>
          <stop offset="0.45" stopColor="var(--nexus-color)" stopOpacity="0.5" />
          <stop offset="1" stopColor="var(--nexus-color)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle className="nexus-node-shock-ring" r="17" />
      <circle className="nexus-halo" r="31" fill={`url(#${id}-halo)`} />
      <circle className="nexus-node-orbit" r="22" />
      <circle className="nexus-node-core" r="17" fill={`url(#${id}-core)`} />
      <path className="nexus-node-rim" d="M-15 3A15.3 15.3 0 0 1 7 -13.6" />
      <path className="nexus-node-rim nexus-node-rim--lower" d="M9 12.4A15.3 15.3 0 0 1 -4 14.8" />
      <g className="nexus-symbol">
        <path d={MARKS[kind]} />
      </g>
    </>
  );
}
