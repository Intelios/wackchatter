import type { MacroEnvironment } from '@shared/prompt/macros.ts';
import { createMacroRuntime, substituteMacros } from '@shared/prompt/macros.ts';
import type { CharacterDetail } from '@shared/types/card.ts';
import type { CardBudget } from './budget.ts';
import type { StudioSection } from './sections.ts';

export type LintLevel = 'error' | 'warning' | 'info';

export interface LintFinding {
  id: string;
  level: LintLevel;
  section: StudioSection;
  message: string;
}

interface LintText {
  section: StudioSection;
  source: string;
  text: string;
}

function filenameBase(avatar: string): string {
  return avatar.replace(/\.png$/i, '');
}

function lintTexts(detail: CharacterDetail): LintText[] {
  const { data } = detail.card;
  const texts: LintText[] = [
    { section: 'identity', source: 'name', text: data.name },
    { section: 'definition', source: 'description', text: data.description },
    { section: 'definition', source: 'personality', text: data.personality },
    { section: 'definition', source: 'scenario', text: data.scenario },
    { section: 'greetings', source: 'first_mes', text: data.first_mes },
    { section: 'examples', source: 'mes_example', text: data.mes_example },
    { section: 'prompts', source: 'system_prompt', text: data.system_prompt },
    {
      section: 'prompts',
      source: 'post_history_instructions',
      text: data.post_history_instructions,
    },
    { section: 'metadata', source: 'creator_notes', text: data.creator_notes },
    { section: 'metadata', source: 'nickname', text: data.nickname ?? '' },
    {
      section: 'advanced',
      source: 'depth_prompt',
      text: data.extensions.depth_prompt?.prompt ?? '',
    },
  ];

  data.alternate_greetings.forEach((text, index) => {
    texts.push({ section: 'greetings', source: `alternate_greetings.${index + 1}`, text });
  });
  data.group_only_greetings?.forEach((text, index) => {
    texts.push({ section: 'greetings', source: `group_only_greetings.${index + 1}`, text });
  });
  data.character_book?.entries.forEach((entry, index) => {
    texts.push({ section: 'lorebook', source: `book.${index + 1}.content`, text: entry.content });
    entry.keys.forEach((key, keyIndex) => {
      texts.push({
        section: 'lorebook',
        source: `book.${index + 1}.key.${keyIndex + 1}`,
        text: key,
      });
    });
  });
  return texts;
}

/**
 * Card quality and portability checks. Macro diagnostics deliberately go through the prompt
 * macro engine: its warning behaviour is the compatibility contract, not a second regex.
 */
export function lintCard(
  detail: CharacterDetail,
  _budget: CardBudget,
  lorebookNames: readonly string[] = [],
): LintFinding[] {
  const findings: LintFinding[] = [];
  const { data } = detail.card;
  const add = (id: string, level: LintLevel, section: StudioSection, message: string) => {
    findings.push({ id, level, section, message });
  };

  if (!data.name.trim()) add('name-blank', 'error', 'identity', 'Card name is required.');
  if (!data.first_mes.trim()) {
    add(
      'first-message-blank',
      'error',
      'greetings',
      'First message is blank. New chats would open empty.',
    );
  }

  const environment: MacroEnvironment = { char: data.name || 'Character', user: 'User' };
  const runtime = createMacroRuntime();
  const textSources = new Map<string, StudioSection>();
  for (const text of lintTexts(detail)) {
    textSources.set(text.source, text.section);
    substituteMacros(text.text, environment, '', { runtime, source: text.source });
  }
  for (const warning of runtime.warnings) {
    const macro = warning.macro.trim();
    const displayMacro = macro.startsWith('{{') && macro.endsWith('}}') ? macro : `{{${macro}}}`;
    const macroId = displayMacro.replace(/^\{\{|\}\}$/g, '').toLowerCase();
    add(
      `macro-${warning.source}-${macroId}`,
      'error',
      textSources.get(warning.source) ?? 'advanced',
      `Unknown macro ${displayMacro} in ${warning.source}.`,
    );
  }

  data.character_book?.entries.forEach((entry, index) => {
    if (!entry.constant && entry.keys.filter(Boolean).length === 0) {
      add(
        `book-${index}-keys`,
        'error',
        'lorebook',
        `Lorebook entry ${index + 1} has no keys and is not constant.`,
      );
    }
  });

  if (!data.description.trim()) {
    add('description-blank', 'warning', 'definition', 'Description is blank.');
  }
  if (data.mes_example.trim() && !/<START>/i.test(data.mes_example)) {
    add('examples-no-start', 'warning', 'examples', 'Examples do not contain a <START> block.');
  }
  if (data.alternate_greetings.some((greeting) => !greeting.trim())) {
    add('alternate-blank', 'warning', 'greetings', 'One or more alternate greetings are blank.');
  }
  const normalizedGreetings = data.alternate_greetings.map((greeting) =>
    greeting.trim().toLowerCase(),
  );
  if (
    new Set(normalizedGreetings.filter(Boolean)).size !== normalizedGreetings.filter(Boolean).length
  ) {
    add(
      'alternate-duplicate',
      'warning',
      'greetings',
      'One or more alternate greetings are duplicated.',
    );
  }
  if (data.name.trim() && data.name.trim() !== filenameBase(detail.avatar)) {
    add(
      'name-filename',
      'warning',
      'identity',
      'Card name differs from its PNG filename. Rename it before export if that is unintentional.',
    );
  }
  if (!data.creator.trim()) add('creator-blank', 'warning', 'identity', 'Creator is blank.');
  if (!data.character_version.trim()) {
    add('version-blank', 'warning', 'identity', 'Character version is blank.');
  }
  // The server does not surface carrier-image metadata. Imported placeholder files use this
  // conventional filename, which is the only safe pure check until that metadata exists.
  if (/^blank-avatar\.png$/i.test(detail.avatar)) {
    add('avatar-placeholder', 'warning', 'identity', 'Avatar is still the blank placeholder.');
  }
  const linkedBook = data.extensions.world;
  if (typeof linkedBook === 'string' && linkedBook && !lorebookNames.includes(linkedBook)) {
    add(
      'world-missing',
      'warning',
      'advanced',
      `Linked lorebook “${linkedBook}” is not in this library.`,
    );
  }

  if (data.tags.length === 0) add('tags-empty', 'info', 'metadata', 'No tags.');
  if (!data.creator_notes.trim())
    add('creator-notes-empty', 'info', 'metadata', 'No creator notes.');
  if (!data.character_book) add('lorebook-empty', 'info', 'lorebook', 'No embedded lorebook.');

  return findings;
}
