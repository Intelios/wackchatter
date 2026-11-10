/**
 * What ⌘K searches: characters (recent first), the open character's chats, the tools, the
 * apps and your personas. Shared by the chat and the home screen so search is the same
 * everywhere.
 */

import type { CharacterSummary } from '@shared/types/card.ts';
import type { ChatSummary } from '@shared/types/chat.ts';
import type { AppController, SettingsChapter, ToolId } from '../app/useAppController.ts';
import { personaApi } from '../lib/api.ts';
import type { SearchItem } from './IslandPanes.tsx';
import { introLine } from './intro.ts';
import { TOOLS } from './MarginTools.tsx';
import { SETTING_INDEX, SETTINGS_CHAPTERS } from './settings.ts';

export function buildSearchItems(options: {
  controller: AppController;
  /** Shown first, in this order. */
  recentCharacters: readonly CharacterSummary[];
  /** The open character's chats; none on the home screen. */
  chats: readonly ChatSummary[];
  characterName: string;
  avatarUrlOf: (avatar: string) => string;
  tools: readonly ToolId[];
  openTool: (id: ToolId) => void;
  /** Opens a tool without toggling it shut when it is already open. */
  showTool?: (id: ToolId) => void;
  onOpenChat: (id: string) => void;
}): SearchItem[] {
  const { controller, recentCharacters, avatarUrlOf } = options;
  const { library } = controller;
  const items: SearchItem[] = [];
  const character = (summary: CharacterSummary): SearchItem => ({
    key: `c:${summary.avatar}`,
    kind: 'Character',
    label: summary.name,
    sub: introLine(summary.description) || undefined,
    face: { name: summary.name, url: avatarUrlOf(summary.avatar) },
    run: () => controller.selectCharacter(summary.avatar),
  });
  for (const summary of recentCharacters) items.push(character(summary));
  for (const summary of library.characters) {
    if (!recentCharacters.includes(summary)) items.push(character(summary));
  }
  for (const summary of options.chats) {
    items.push({
      key: `chat:${summary.id}`,
      kind: 'Chat',
      label: summary.title,
      sub: `${options.characterName} · ${summary.messageCount} messages`,
      icon: 'chat',
      run: () => options.onOpenChat(summary.id),
    });
  }
  for (const id of options.tools) {
    items.push({
      key: `t:${id}`,
      kind: 'Tool',
      label: TOOLS[id].title,
      icon: TOOLS[id].icon,
      run: () => options.openTool(id),
    });
  }
  items.push(
    {
      key: 'a:studio',
      kind: 'App',
      label: 'Studio',
      sub: 'Organise and edit your library',
      icon: 'studio',
      run: () => void controller.enterStudio(),
    },
    {
      key: 'a:cocreator',
      kind: 'App',
      label: 'Co-Creator',
      sub: 'Write a character or preset with a model',
      icon: 'sparkles',
      run: () => void controller.enterCoCreator(),
    },
    {
      key: 'a:arena',
      kind: 'App',
      label: 'Model Arena',
      sub: 'Compare models blind',
      icon: 'arena',
      run: () => void controller.enterArena(),
    },
    {
      key: 'a:stats',
      kind: 'App',
      label: 'Stats',
      sub: 'Usage in TokenTrail',
      icon: 'stats',
      run: () => void controller.enterStats(),
    },
  );
  // Settings, found by name: they open the Settings tool on their chapter, lit up.
  if (options.tools.includes('settings')) {
    const openSetting = (chapter: SettingsChapter, focus: string | null) => {
      controller.setSettingsPage({ chapter, focus });
      (options.showTool ?? options.openTool)('settings');
    };
    for (const entry of SETTING_INDEX) {
      const chapter = SETTINGS_CHAPTERS.find((c) => c.id === entry.chapter);
      items.push({
        key: `s:${entry.key}`,
        kind: 'Setting',
        label: entry.label,
        sub: `Settings · ${chapter?.title ?? ''}`,
        terms: entry.words,
        icon: chapter?.icon ?? 'gear',
        run: () => openSetting(entry.chapter, entry.key),
      });
    }
    for (const connection of controller.app.settings?.connections ?? []) {
      items.push({
        key: `s:conn:${connection.id}`,
        kind: 'Setting',
        label: connection.name,
        sub: 'Settings · Connections',
        icon: 'plug',
        run: () => openSetting('connections', null),
      });
    }
  }
  for (const p of library.personas) {
    items.push({
      key: `p:${p.id}`,
      kind: 'Persona',
      label: p.variantLabel ? `${p.name} (${p.variantLabel})` : p.name,
      sub: introLine(p.description) || undefined,
      face: {
        name: p.name,
        url: p.avatar
          ? personaApi.avatarUrl(p.id, library.personaAvatarVersions[p.id] ?? p.avatar)
          : null,
        me: true,
      },
      run: () => controller.selectPersona(p.id),
    });
  }
  return items;
}
