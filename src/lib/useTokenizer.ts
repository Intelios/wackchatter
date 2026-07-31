import { type TokenCounter, memoizeCounter } from '@shared/prompt/token-cache.ts';
import { useEffect, useMemo, useState } from 'react';
import { approximateTokens, encodingForModel, isCounterLoaded, loadCounter } from './tokenizer.ts';

/**
 * A token counter for the given model.
 *
 * Starts on the character-count approximation so the UI has numbers immediately, then
 * swaps in the real encoding once it has loaded. The identity change triggers exactly one
 * re-assembly, which is what refreshes the Prompt Manager's counts.
 *
 * The result is memoized, so repeated assemblies over unchanged message text are free.
 */
export function useTokenizer(model: string, override?: string): TokenCounter {
  const encoding = encodingForModel(model, override);
  const [raw, setRaw] = useState<TokenCounter>(() => approximateTokens);

  useEffect(() => {
    let cancelled = false;

    loadCounter(encoding)
      .then((counter) => {
        // Wrapped in a thunk: setState treats a bare function as an updater.
        if (!cancelled) setRaw(() => counter);
      })
      .catch(() => {
        // An encoding that fails to load leaves the estimate in place; budgeting stays
        // conservative rather than the app losing its token counts entirely.
      });

    return () => {
      cancelled = true;
    };
  }, [encoding]);

  // Reset to the estimate when switching to an encoding we haven't loaded yet, so the
  // counts never silently belong to the previous model.
  useEffect(() => {
    if (!isCounterLoaded(encoding)) setRaw(() => approximateTokens);
  }, [encoding]);

  return useMemo(() => memoizeCounter(raw), [raw]);
}
