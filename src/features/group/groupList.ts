import type { CharacterSummary } from '@shared/types/card.ts';
import type { ChatSummary } from '@shared/types/chat.ts';
import type { GroupTemplate } from '@shared/types/group.ts';

export type GroupSortOption = 'recent' | 'name' | 'members';

/**
 * Filters and sorts group cast templates based on search query and sort criteria.
 */
export function filterAndSortGroups(
  groups: readonly GroupTemplate[],
  query: string,
  sort: GroupSortOption,
): GroupTemplate[] {
  const q = query.trim().toLowerCase();
  let list = groups.filter((g) => {
    if (!q) return true;
    if (g.name.toLowerCase().includes(q)) return true;
    if (g.scenario?.toLowerCase().includes(q)) return true;
    if (g.members.some((m) => m.name.toLowerCase().includes(q))) return true;
    return false;
  });

  if (sort === 'recent') {
    list = [...list].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  } else if (sort === 'name') {
    list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === 'members') {
    list = [...list].sort((a, b) => b.members.length - a.members.length);
  }
  return list;
}

/**
 * Filters and sorts group scenes (chats) based on search query and sort criteria.
 */
export function filterAndSortScenes(
  scenes: readonly ChatSummary[],
  characters: readonly CharacterSummary[],
  query: string,
  sort: GroupSortOption,
): ChatSummary[] {
  const q = query.trim().toLowerCase();
  let list = scenes.filter((s) => {
    if (!q) return true;
    if (s.title.toLowerCase().includes(q)) return true;
    if (s.lastMessage?.toLowerCase().includes(q)) return true;
    const memberIds = s.groupMembers ?? [];
    if (
      memberIds.some((id) => {
        const char = characters.find((c) => c.avatar === id);
        return char?.name.toLowerCase().includes(q);
      })
    )
      return true;
    return false;
  });

  if (sort === 'recent') {
    list = [...list].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  } else if (sort === 'name') {
    list = [...list].sort((a, b) => a.title.localeCompare(b.title));
  } else if (sort === 'members') {
    list = [...list].sort((a, b) => (b.groupMembers?.length ?? 0) - (a.groupMembers?.length ?? 0));
  }
  return list;
}
