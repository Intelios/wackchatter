import type { CardDataV2 } from '../types/card.ts';

/**
 * An empty card's data: every V2 field present and blank. The server wraps it for "create
 * new character"; the Preset Co-Creator uses it bare for a test with no character card,
 * where the name is all `{{char}}` needs and every other field assembles to nothing.
 */
export function blankCardData(name: string): CardDataV2 {
  return {
    name,
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
  };
}
