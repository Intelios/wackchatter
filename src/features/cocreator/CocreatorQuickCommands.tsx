/**
 * Quick commands for the Character Co-Creator.
 *
 * App-wide snippets for character design sessions that drop straight into the Co-Creator
 * composer. Stored under `coCreator.quickCommands` in settings, separate from main chat
 * quick commands.
 */

import type { QuickCommand } from '@shared/types/settings.ts';
import { useRef, useState } from 'react';
import { Menu } from '../../components/Menu.tsx';
import { BoltIcon } from '../../layout/icons.tsx';
import { buildQuickCommandsMenu, type QuickCommandsActions } from '../chat/QuickCommands.tsx';
import { QuickCommandsPopover } from '../chat/QuickCommandsPopover.tsx';

export type CocreatorQuickCommandsActions = QuickCommandsActions;
export const buildCocreatorQuickCommandsMenu = buildQuickCommandsMenu;

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
