/**
 * Quick commands for the main chat interface.
 *
 * App-wide snippets dropped straight into the composer, ready to send. Stored under
 * `quickCommands` in settings.
 */

import type { QuickCommand } from '@shared/types/settings.ts';
import { useRef, useState } from 'react';
import { Menu, type MenuEntry } from '../../components/Menu.tsx';
import { BoltIcon, EditIcon } from '../../layout/icons.tsx';
import { QuickCommandsPopover } from './QuickCommandsPopover.tsx';
import { commandHint, commandLabel, usableCommands } from './quickCommands.ts';

export interface QuickCommandsActions {
  insertCommand: (text: string) => void;
  editQuickCommands: () => void;
}

export function buildQuickCommandsMenu(
  quickCommands: QuickCommand[],
  actions: QuickCommandsActions,
): MenuEntry[] {
  const usable = usableCommands(quickCommands);

  const commandEntries: MenuEntry[] = usable.map((command) => ({
    key: command.id,
    label: commandLabel(command),
    icon: <BoltIcon />,
    // The hint repeats the label on unnamed commands, so it only joins a real name.
    hint: command.name.trim() ? commandHint(command) : undefined,
    onSelect: () => actions.insertCommand(command.text),
  }));

  return [
    ...commandEntries,
    ...(commandEntries.length > 0 ? [{ kind: 'separator' as const }] : []),
    {
      label: 'Edit quick commands…',
      icon: <EditIcon />,
      onSelect: actions.editQuickCommands,
    },
  ];
}

export interface QuickCommandsProps {
  quickCommands: QuickCommand[];
  /** Places a command's text in the composer, ready to send. */
  onInsertCommand: (text: string) => void;
  onQuickCommandsChange: (commands: QuickCommand[]) => void;
}

export function QuickCommands({
  quickCommands,
  onInsertCommand,
  onQuickCommandsChange,
}: QuickCommandsProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const entries = buildQuickCommandsMenu(quickCommands, {
    insertCommand: onInsertCommand,
    editQuickCommands: () => setEditorOpen(true),
  });

  return (
    <div className="chat-quick-commands">
      <Menu
        label="Quick commands"
        icon={<BoltIcon />}
        entries={entries}
        triggerRef={triggerRef}
        placement="top-start"
      />
      <QuickCommandsPopover
        commands={quickCommands}
        onCommandsChange={onQuickCommandsChange}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        triggerRef={triggerRef}
        placement="top-start"
      />
    </div>
  );
}
