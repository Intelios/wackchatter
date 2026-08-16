import { type RefObject, useCallback, useEffect, useRef } from 'react';

/** How close to the bottom still counts as "following along". */
const THRESHOLD_PX = 80;

/**
 * Keep a scroll container pinned to the bottom while the user is already there.
 *
 * Autoscroll cannot ride on render: during streaming only the leaf text node re-renders,
 * so nothing above it ever gets a chance to scroll. A ResizeObserver watches the content
 * box directly instead.
 *
 * Scrolling up to read stops the follow until the user comes back down, so a long reply
 * never yanks the view away mid-sentence.
 */
export function useStickToBottom<T extends HTMLElement>(
  scrollRef: RefObject<T | null>,
  contentRef: RefObject<HTMLElement | null>,
) {
  const following = useRef(true);
  /**
   * Set while we move the scroll ourselves. Without it, our own scroll event is measured
   * against the pre-growth position, reads as "miles from the bottom", and switches
   * following off — so a freshly opened chat would sit at the top and never recover.
   */
  const programmatic = useRef(false);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    programmatic.current = true;
    element.scrollTop = element.scrollHeight;
    following.current = true;
    // Released after the scroll event this just queued has been dispatched.
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, [scrollRef]);

  /**
   * Drop the follow, so streaming growth no longer pulls the container to its bottom.
   *
   * A jump to an old message reads from the middle of the transcript: following must be
   * off, or the next reply to stream yanks the reader back to the newest page. The user
   * re-engages the follow the ordinary way, by scrolling to the bottom.
   */
  const stopFollowing = useCallback(() => {
    following.current = false;
  }, []);

  // Track whether the user is still at the bottom.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const onScroll = () => {
      if (programmatic.current) return;
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      following.current = distance <= THRESHOLD_PX;
    };

    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  // Follow content growth, including growth React never re-rendered the list for.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      if (following.current) scrollToBottom();
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, [contentRef, scrollToBottom]);

  // Follow scroll container viewport resize (e.g. composer expansion/collapse, window resize, panel movement)
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    let lastHeight = scrollEl.clientHeight;
    const observer = new ResizeObserver(() => {
      const newHeight = scrollEl.clientHeight;
      if (newHeight === lastHeight) return;
      lastHeight = newHeight;
      if (following.current) scrollToBottom();
    });

    observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [scrollRef, scrollToBottom]);

  return { scrollToBottom, stopFollowing, isFollowing: following };
}
