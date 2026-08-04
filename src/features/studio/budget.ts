import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardDataV2 } from '@shared/types/card.ts';

export interface CardBudget {
  /** Counts by editable field, including each alternate greeting. */
  fields: Record<string, number>;
  /** Card text which is permanently present in the prompt. */
  permanent: number;
  /** The opening message is one message, rather than permanent context. */
  greeting: number;
  /** Enabled constant embedded-book entries are always injected. */
  lorebookConstant: number;
  total: number;
}

function textCount(count: TokenCounter, value: string | undefined): number {
  return value?.trim() ? count.countText(value) : 0;
}

/** Measure the card surfaces independently so field labels and the total cannot drift. */
export function measureCard(data: CardDataV2, count: TokenCounter): CardBudget {
  const description = textCount(count, data.description);
  const personality = textCount(count, data.personality);
  const scenario = textCount(count, data.scenario);
  const firstMes = textCount(count, data.first_mes);
  const mesExample = textCount(count, data.mes_example);
  const systemPrompt = textCount(count, data.system_prompt);
  const postHistoryInstructions = textCount(count, data.post_history_instructions);
  const fields: Record<string, number> = {
    name: textCount(count, data.name),
    creator: textCount(count, data.creator),
    character_version: textCount(count, data.character_version),
    description,
    personality,
    scenario,
    first_mes: firstMes,
    mes_example: mesExample,
    system_prompt: systemPrompt,
    post_history_instructions: postHistoryInstructions,
    creator_notes: textCount(count, data.creator_notes),
    nickname: textCount(count, data.nickname),
    depth_prompt: textCount(count, data.extensions.depth_prompt?.prompt),
  };

  data.alternate_greetings.forEach((greeting, index) => {
    fields[`alternate_greetings.${index}`] = textCount(count, greeting);
  });
  data.group_only_greetings?.forEach((greeting, index) => {
    fields[`group_only_greetings.${index}`] = textCount(count, greeting);
  });

  const lorebookConstant = (data.character_book?.entries ?? [])
    .filter((entry) => entry.constant && entry.enabled !== false)
    .reduce((total, entry) => total + textCount(count, entry.content), 0);

  const permanent =
    description + personality + scenario + mesExample + systemPrompt + postHistoryInstructions;
  const greeting = firstMes;

  return {
    fields,
    permanent,
    greeting,
    lorebookConstant,
    total: permanent + greeting + lorebookConstant,
  };
}
