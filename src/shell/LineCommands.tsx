/**
 * Quick commands on the Line: the bolt at its left end. One click lists your commands, one
 * more puts a command's text in the Line, ready to send. Edit opens the shared editor,
 * anchored to the same bolt.
 */

import type { QuickCommand } from '@shared/types/settings.ts';
import { useRef, useState } from 'react';
import { Popover } from '../components/Popover.tsx';
import { QuickCommandsPopover } from '../features/chat/QuickCommandsPopover.tsx';
import { commandLabel, usableCommands } from '../features/chat/quickCommands.ts';
import { Icon } from './icons.tsx';

export function LineCommands({
  commands,
  onInsert,
  onChange,
}: {
  commands: QuickCommand[];
  onInsert: (text: string) => void;
  onChange: (commands: QuickCommand[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const usable = usableCommands(commands);

  return (
    <span className="w3-qc-anchor">
      <Popover
        label="Quick commands"
        icon={null}
        open={open}
        onOpenChange={setOpen}
        role="dialog"
        placement="top-start"
        popupClassName="w3-qc"
        renderTrigger={(trigger) => (
          <button
            {...trigger}
            ref={(node) => {
              trigger.ref(node);
              triggerRef.current = node;
            }}
            type="button"
            className="w3-line__act"
            title="Quick commands"
            onClick={() => {
              setEditing(false);
              setOpen((o) => !o);
            }}
          >
            <Icon name="bolt" size="sm" />
          </button>
        )}
      >
        <div className="w3-qc__head">
          <b>Quick commands</b>
          <span>Click one to put it in the Line</span>
        </div>
        {usable.length ? (
          <div className="w3-qc__list">
            {usable.map((command) => (
              <button
                key={command.id}
                type="button"
                className="w3-qc__item"
                onClick={() => {
                  setOpen(false);
                  onInsert(command.text);
                }}
              >
                <b>{commandLabel(command)}</b>
                <span>{command.text.trim().split('\n')[0]}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="w3-qc__empty">No commands yet. Write one with Edit.</p>
        )}
        <div className="w3-qc__foot">
          <button
            type="button"
            className="w3-qc__edit"
            onClick={() => {
              setOpen(false);
              setEditing(true);
            }}
          >
            <Icon name="pencil" size="xs" />
            Edit
          </button>
        </div>
      </Popover>
      <QuickCommandsPopover
        commands={commands}
        onCommandsChange={onChange}
        open={editing}
        onOpenChange={setEditing}
        triggerRef={triggerRef}
        placement="top-start"
      />
    </span>
  );
}
