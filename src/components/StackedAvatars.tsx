/**
 * A few faces, overlapped, with the rest counted.
 *
 * A group scene has no single avatar — its identity is the cast. Showing the members'
 * faces over one another is how a recents list says "several people are in this" without
 * a label, and it scales: once the stack is full the remainder becomes a `+N` chip rather
 * than a longer row of thumbnails.
 *
 * The stack always occupies the same width — `max` faces' worth — whether the cast is two
 * or five, so a column of rows keeps one text edge. Faces are laid out from the left.
 *
 * Faces are the members' cards. A card that has since been deleted renders as a blank
 * slot rather than a broken image, the same degradation the transcript makes.
 */

import type { CSSProperties } from 'react';
import { UsersIcon } from '../layout/icons.tsx';
import './StackedAvatars.css';

interface StackedAvatarsProps {
  /** Image URLs in cast order. A null entry is a member whose card is gone. */
  urls: readonly (string | null)[];
  /** Names, in the same order, for the faces' titles and the group's accessible name. */
  names?: readonly string[];
  /** How many slots the stack spans, count chip included. */
  max?: number;
  className?: string;
}

export function StackedAvatars({ urls, names, max = 3, className }: StackedAvatarsProps) {
  // The chip takes a slot of its own, so an overflowing stack shows one face fewer.
  const overflowing = urls.length > max;
  const faces = overflowing ? urls.slice(0, max - 1) : urls.slice(0, max);
  const extra = urls.length - faces.length;
  // The slot count is `max` for any cast that fills it, which is what keeps every row's
  // text edge in one column; an empty or one-member stack spans a single face.
  const slots = Math.max(1, Math.min(urls.length || 1, max));
  /*
   * One name for the whole stack: "Mika, Mirei, Niamh" reads, four separate images
   * announced one after another does not. Spread rather than set unconditionally, because
   * `aria-label` on a roleless span is an attribute nothing consumes.
   */
  const described = names?.length ? { role: 'img' as const, 'aria-label': names.join(', ') } : {};

  return (
    <span
      className={`stacked-avatars${className ? ` ${className}` : ''}`}
      style={{ '--wc-stack-faces': slots } as CSSProperties}
      {...described}
    >
      {urls.length === 0 ? (
        <span className="stacked-avatars__face" data-empty>
          <UsersIcon />
        </span>
      ) : (
        faces.map((url, index) => (
          <span
            className="stacked-avatars__face"
            // biome-ignore lint/suspicious/noArrayIndexKey: the faces are positional
            key={index}
            title={names?.[index]}
          >
            {url ? (
              <img src={url} alt="" loading="lazy" />
            ) : (
              <span aria-hidden="true">{names?.[index]?.slice(0, 1).toUpperCase() ?? '?'}</span>
            )}
          </span>
        ))
      )}
      {extra > 0 ? (
        <span className="stacked-avatars__face stacked-avatars__more" title={`${extra} more`}>
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
