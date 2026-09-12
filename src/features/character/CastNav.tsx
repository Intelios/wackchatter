import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MessagesIcon, UsersIcon } from '../../layout/icons.tsx';
import './CastNav.css';

export type CastTab = 'characters' | 'groups';

export interface CastNavProps {
  active: CastTab;
  onChange: (tab: CastTab) => void;
  disabled?: boolean;
}

/**
 * Segmented control switching between the Character library and Groups browser.
 * Features an animated sliding indicator that tracks the active tab.
 */
export function CastNav({ active, onChange, disabled }: CastNavProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Map<CastTab, HTMLButtonElement>>(new Map());
  const [rect, setRect] = useState<{ x: number; width: number } | null>(null);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const button = buttonRefs.current.get(active);
    if (!container || !button) {
      setRect(null);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    setRect({
      x: buttonRect.left - containerRect.left,
      width: buttonRect.width,
    });
  }, [active]);

  useLayoutEffect(() => {
    measure();
    if (!readyRef.current) {
      readyRef.current = true;
      requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    }
  }, [measure]);

  useEffect(() => {
    const observer = new ResizeObserver(measure);
    for (const button of buttonRefs.current.values()) observer.observe(button);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className="cast-nav-wrapper">
      <div ref={containerRef} className="cast-nav" role="tablist" aria-label="Cast navigation">
        {rect ? (
          <span
            aria-hidden="true"
            className="cast-nav__indicator"
            data-active={true}
            data-ready={ready}
            style={{
              transform: `translateX(${rect.x}px)`,
              width: `${rect.width}px`,
            }}
          />
        ) : null}
        <button
          ref={(el) => {
            if (el) buttonRefs.current.set('characters', el);
            else buttonRefs.current.delete('characters');
          }}
          type="button"
          role="tab"
          className="cast-nav__button"
          aria-selected={active === 'characters'}
          disabled={disabled}
          onClick={() => onChange('characters')}
        >
          <UsersIcon />
          <span>Characters</span>
        </button>
        <button
          ref={(el) => {
            if (el) buttonRefs.current.set('groups', el);
            else buttonRefs.current.delete('groups');
          }}
          type="button"
          role="tab"
          className="cast-nav__button"
          aria-selected={active === 'groups'}
          disabled={disabled}
          onClick={() => onChange('groups')}
        >
          <MessagesIcon />
          <span>Groups</span>
        </button>
      </div>
    </div>
  );
}
