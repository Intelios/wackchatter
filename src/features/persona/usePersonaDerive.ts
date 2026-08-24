/**
 * The converter's run loop: card in, draft persona out.
 *
 * One non-streaming provider call per roll. Nothing here writes anything — the draft lives in
 * the component until the user saves it — so a failed or cancelled roll leaves no trace.
 */

import {
  buildDerivationMessages,
  DEFAULT_PERSONA_DERIVE_PROMPT,
  type DerivedPersona,
  type PersonaSourceProfile,
  parseDerivedPersona,
  renderPersonaDescription,
} from '@shared/persona/derive.ts';
import { resolveGreetingMacros } from '@shared/prompt/greeting.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { CardDataV2, CharacterSummary } from '@shared/types/card.ts';
import type { MacroVariableMap } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { characterApi, streamGenerate } from '../../lib/api.ts';

/** A derived persona is ~150 tokens. The headroom is for a model that pads its JSON. */
const MAX_DERIVE_TOKENS = 600;

export interface DeriveResult {
  name: string;
  description: string;
}

export interface DeriveStatus {
  running: boolean;
  error: string | null;
}

interface UsePersonaDeriveOptions {
  connection: Connection | null;
  preset: Preset | null;
  globalVariables: MacroVariableMap;
}

/**
 * Resolve the card's macros **per field**, never over a joined string.
 *
 * That is assembly's rule ("macros substitute per prompt object and per message at
 * materialisation time, never one pass over a joined string") and joining first is the
 * obvious way to write this, which is why it is called out here.
 *
 * Two deliberate arguments:
 *  - `persona: null` — passing the *current* persona would inject one persona's description
 *    into the source for deriving another, and write the reader's name into a card whose
 *    opening addresses `{{user}}`. Null leaves `{{persona}}` empty and `{{user}}` as 'User'.
 *  - `seed: avatar` — `{{random}}` and `{{pick}}` are seeded, so a per-card seed makes the
 *    resolved source identical across re-rolls. The only thing a re-roll varies is the model.
 */
function resolveProfile(
  card: CardDataV2,
  avatar: string,
  preset: Preset,
  globalVariables: MacroVariableMap,
): PersonaSourceProfile {
  const resolve = (text: string | undefined): string | undefined => {
    if (!text?.trim()) return undefined;
    return resolveGreetingMacros(text, {
      character: card,
      preset,
      persona: null,
      messages: [],
      globalVariables,
      seed: avatar,
    });
  };

  return {
    name: card.name,
    description: resolve(card.description),
    personality: resolve(card.personality),
    firstMessage: resolve(card.first_mes),
  };
}

export function usePersonaDerive({ connection, preset, globalVariables }: UsePersonaDeriveOptions) {
  const [status, setStatus] = useState<DeriveStatus>({ running: false, error: null });
  const abortRef = useRef<AbortController | null>(null);
  /**
   * The resolved source, cached for the life of the converter view. Belt and braces with the
   * per-card seed: every take reads byte-identical source text.
   */
  const profileRef = useRef<{ avatar: string; profile: PersonaSourceProfile } | null>(null);

  // Without the abort, leaving the panel keeps the provider generating — and billing.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus({ running: false, error: null });
  }, []);

  /** Drop the cached source, so picking a different card re-reads it. */
  const reset = useCallback(() => {
    profileRef.current = null;
    setStatus({ running: false, error: null });
  }, []);

  const derive = useCallback(
    async (character: CharacterSummary): Promise<DeriveResult | null> => {
      if (abortRef.current) return null;
      if (!connection?.baseUrl || !connection.model) {
        setStatus({
          running: false,
          error: 'The active connection needs an endpoint and a model.',
        });
        return null;
      }
      if (!preset) {
        setStatus({ running: false, error: 'The active preset has not loaded yet.' });
        return null;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setStatus({ running: true, error: null });

      try {
        let cached = profileRef.current;
        if (cached?.avatar !== character.avatar) {
          const detail = await characterApi.get(character.avatar);
          if (controller.signal.aborted) return null;
          cached = {
            avatar: character.avatar,
            profile: resolveProfile(detail.card.data, character.avatar, preset, globalVariables),
          };
          profileRef.current = cached;
        }

        const body = buildRequestBody({
          messages: buildDerivationMessages({
            derivePrompt: DEFAULT_PERSONA_DERIVE_PROMPT,
            card: cached.profile,
          }),
          preset,
          connection,
          stream: false,
          maxTokens: MAX_DERIVE_TOKENS,
        });

        const result = await streamGenerate(
          body,
          controller.signal,
          { onTick: () => {} },
          '',
          connection.id,
        );
        // A non-streaming reply can resolve in the same turn as the abort, so the signal is
        // re-read after the await rather than only before it.
        if (controller.signal.aborted) return null;

        const parsed: DerivedPersona = parseDerivedPersona(result.content, character.name);
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.fields.length === 0) {
          throw new Error('The model returned no usable details for this card.');
        }

        setStatus({ running: false, error: null });
        return { name: parsed.name, description: renderPersonaDescription(parsed.fields) };
      } catch (error) {
        if (controller.signal.aborted) return null;
        setStatus({
          running: false,
          error: error instanceof Error ? error.message : 'The conversion failed.',
        });
        return null;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [connection, preset, globalVariables],
  );

  return { status, derive, cancel, reset };
}
