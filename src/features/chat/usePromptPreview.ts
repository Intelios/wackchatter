import { type AssembleResult, assemblePrompt } from '@shared/prompt/assemble.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { ChatMessage, Persona } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import { useEffect, useState } from 'react';

const DEBOUNCE_MS = 200;

export interface PromptPreviewInput {
  preset: Preset;
  character: CardDataV2;
  persona: Persona | null;
  messages: ChatMessage[];
  countTokens: TokenCounter;
}

/**
 * Assemble the prompt that *would* be sent, for the Prompt Manager's live token counts.
 *
 * Takes the inputs individually rather than an options object so the dependency list is
 * complete: an object rebuilt every render would either re-run this constantly or, if
 * keyed on its fields, go stale the moment someone added one.
 *
 * Debounced, and deliberately unaware of the composer's text — retyping a message would
 * otherwise re-run assembly on every keystroke for numbers that cannot change.
 */
export function usePromptPreview(input: PromptPreviewInput | null): AssembleResult | null {
  const [result, setResult] = useState<AssembleResult | null>(null);

  const preset = input?.preset;
  const character = input?.character;
  const persona = input?.persona;
  const messages = input?.messages;
  const countTokens = input?.countTokens;

  useEffect(() => {
    if (!preset || !character || !messages || !countTokens) {
      setResult(null);
      return;
    }

    const timer = setTimeout(() => {
      try {
        setResult(assemblePrompt({ preset, character, persona, messages, countTokens }));
      } catch {
        // A preset mid-edit can be momentarily invalid; the counts simply stall.
        setResult(null);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [preset, character, persona, messages, countTokens]);

  return result;
}
