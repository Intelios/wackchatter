/**
 * Quick commands for the Character Co-Creator.
 *
 * App-wide snippets for character design sessions that drop straight into the Co-Creator
 * composer. Stored under `coCreator.quickCommands` in settings, separate from main chat
 * quick commands.
 */

import type { QuickCommand } from '@shared/types/settings.ts';
import { useRef, useState } from 'react';
import { Menu, type MenuEntry } from '../../components/Menu.tsx';
import { BoltIcon, EditIcon } from '../../layout/icons.tsx';
import { QuickCommandsPopover } from '../chat/QuickCommandsPopover.tsx';
import { commandHint, commandLabel, usableCommands } from '../chat/quickCommands.ts';

export interface CocreatorQuickCommandsActions {
  insertCommand: (text: string) => void;
  editQuickCommands: () => void;
}

export function buildCocreatorQuickCommandsMenu(
  quickCommands: QuickCommand[],
  actions: CocreatorQuickCommandsActions,
): MenuEntry[] {
  const usable = usableCommands(quickCommands);

  const commandEntries: MenuEntry[] = usable.map((command) => ({
    key: command.id,
    label: commandLabel(command),
    icon: <BoltIcon />,
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

interface CocreatorQuickCommandsProps {
  quickCommands: QuickCommand[];
  onInsertCommand: (text: string) => void;
  onQuickCommandsChange: (commands: QuickCommand[]) => void;
}

export function CocreatorQuickCommands({
  quickCommands,
  onInsertCommand,
  onQuickCommandsChange,
}: CocreatorQuickCommandsProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const entries = buildCocreatorQuickCommandsMenu(quickCommands, {
    insertCommand: onInsertCommand,
    editQuickCommands: () => setEditorOpen(true),
  });

  return (
    <div className="cocreator-quick-commands">
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
        title="Co-Creator quick commands"
        hint="Named snippets dropped into the Co-Creator message box, ready to send. Nothing ships with the app — these are yours to write."
        emptyHint="No commands yet. Add one, then pick it from the bolt menu — try “Give me 3 alternate opening messages”."
      />
    </div>
  );
}
