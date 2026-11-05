/**
 * Which interface renders the app while 3.0 is being built: the new shell, or the 2.x one.
 *
 * A per-browser preference, not a setting. It exists only until the new shell reaches
 * parity, when the 2.x interface and this switch are deleted together, so it stays out of
 * settings.json, which would otherwise carry a dead key forever.
 */

import { useCallback, useEffect, useState } from 'react';

export type UiChoice = '3' | 'legacy';

const KEY = 'wackchatter.ui';

function read(): UiChoice {
  try {
    return globalThis.localStorage?.getItem(KEY) === 'legacy' ? 'legacy' : '3';
  } catch {
    return '3';
  }
}

export function useUiChoice() {
  const [ui, setUi] = useState<UiChoice>(read);

  const choose = useCallback((next: UiChoice) => {
    setUi(next);
    try {
      globalThis.localStorage?.setItem(KEY, next);
    } catch {
      // Private windows can refuse storage; the choice still holds for this session.
    }
  }, []);

  // Ctrl+Shift+U flips between the two, from either one.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'u') {
        event.preventDefault();
        choose(read() === '3' ? 'legacy' : '3');
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [choose]);

  return [ui, choose] as const;
}
