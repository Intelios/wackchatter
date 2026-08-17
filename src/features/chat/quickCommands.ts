/**
 * Quick command list edits.
 *
 * Pure and separate from the popover for the same reason `buildChatMenu` is separate from
 * `ChatMenu`: there is no DOM harness in this project, so the logic worth testing has to
 * live somewhere a test can reach it.
 *
 * Every function returns a new array. The settings patch replaces the list wholesale, so
 * an in-place edit would neither persist nor re-render.
 */

import type { QuickCommand } from '@shared/types/settings.ts';

/** The lowest free `Command N`, so deleting the middle one and adding does not collide. */
export function nextCommandName(commands: QuickCommand[]): string {
  const taken = new Set(
    commands
      .map((command) => /^Command (\d+)$/.exec(command.name)?.[1])
      .filter((n): n is string => n !== undefined),
  );

  let n = 1;
  while (taken.has(String(n))) n += 1;
  return `Command ${n}`;
}

export function addCommand(commands: QuickCommand[], id: string): QuickCommand[] {
  return [...commands, { id, name: nextCommandName(commands), text: '' }];
}

export function updateCommand(
  commands: QuickCommand[],
  id: string,
  patch: Partial<Omit<QuickCommand, 'id'>>,
): QuickCommand[] {
  return commands.map((command) => (command.id === id ? { ...command, ...patch } : command));
}

export function removeCommand(commands: QuickCommand[], id: string): QuickCommand[] {
  return commands.filter((command) => command.id !== id);
}

/** Blank text inserts nothing, so blank commands stay out of the menu. */
export function usableCommands(commands: QuickCommand[]): QuickCommand[] {
  return commands.filter((command) => command.text.trim());
}

/** The menu label: the name, falling back to a snippet of the text for unnamed commands. */
export function commandLabel(command: QuickCommand): string {
  return command.name.trim() || snippet(command.text);
}

function snippet(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '').trim();
  return line.length > 32 ? `${line.slice(0, 32)}…` : line;
}
