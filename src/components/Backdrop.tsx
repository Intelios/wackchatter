import { useLayoutEffect, useRef } from 'react';

/**
 * The background image layer, shared by the app shell and the studio shell.
 *
 * Crossfades between pictures: background-image is not animatable, so the outgoing
 * image is parked in a `::before` layer (painted from `--wc-bg-prev`, see
 * AppShell.css) that fades out over the element's new one. The layer inherits the
 * element's blur and overscan for free — the element's own filter and transform
 * apply to everything painted inside it, so the two images line up exactly.
 *
 * The arm is a layout effect so the swap and the fade land in the same frame: the
 * previous image is captured before the new one is painted, `data-crossfade` pins
 * the layer at full opacity with transitions off for one paint, and a double rAF
 * then releases it — the layer fades out over the new image, and the transition
 * never plays on the way in.
 */
export function Backdrop({ url }: { url: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const prevUrlRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const prev = prevUrlRef.current;
    prevUrlRef.current = url;
    // First paint has nothing to fade from; an unchanged url is a re-render, not a swap.
    if (prev === null || prev === url) return;
    element.style.setProperty('--wc-bg-prev', `url("${prev}")`);
    element.dataset.crossfade = 'true';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        delete element.dataset.crossfade;
      });
    });
  }, [url]);

  if (!url) return null;
  return (
    <div
      ref={ref}
      className="shell__backdrop"
      aria-hidden="true"
      style={{ backgroundImage: `url("${url}")` }}
    />
  );
}
