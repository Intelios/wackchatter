/**
 * Quick commands — user-defined snippets the chat menu's flyout inserts into the composer.
 *
 * This is only the editor. It opens from the flyout's "Edit quick commands…" entry, and it
 * anchors to the burger button: its Popover root is stretched over the ChatMenu wrapper —
 * exactly that button's box — so the popup's ordinary CSS anchoring grows it from the
 * right place without a visible trigger of its own. Everything about this feature lives
 * in the burger menu; the composer never grew a button for it.
 *
 * The list edits are in `quickCommands.ts`, so what remains here is markup and one confirm.
 */

import type { QuickCommand } from '@shared/types/settings.ts';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Popover } from '../../components/Popover.tsx';
import { PlusIcon, TrashIcon } from '../../layout/icons.tsx';
import { addCommand, removeCommand, updateCommand } from './quickCommands.ts';
import './QuickCommandsPopover.css';

interface QuickCommandsPopoverProps {
  commands: QuickCommand[];
  onCommandsChange: (commands: QuickCommand[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The burger button — the anchor this popup grows from. */
  triggerRef: RefObject<HTMLButtonElement | null>;
}

export function QuickCommandsPopover({
  commands,
  onCommandsChange,
  open,
  onOpenChange,
  triggerRef,
}: QuickCommandsPopoverProps) {
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // The menu selection that opened this restores focus to the burger button AFTER the
  // action runs, so the first field waits one tick to take it.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      bodyRef.current
        ?.querySelector<HTMLElement>('input, textarea, button')
        ?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <Popover
      label="Quick commands"
      icon={null}
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setConfirmingDelete(null);
      }}
      className="popover--editor"
      popupClassName="quick-commands"
      placement="top-start"
      role="dialog"
      triggerRef={triggerRef}
      renderTrigger={() => null}
    >
      <div className="quick-commands__body" ref={bodyRef}>
        <div className="quick-commands__head">
          <h2 className="quick-commands__title">Quick commands</h2>
          <p className="quick-commands__hint">
            Named snippets the chat menu drops into the message box, ready to send. Nothing ships
            with the app — these are yours to write.
          </p>
        </div>

        {commands.length === 0 ? (
          <p className="quick-commands__empty">
            No commands yet. Add one, then pick it from the chat menu — try “Generate an ending”.
          </p>
        ) : (
          <ul className="quick-commands__list">
            {commands.map((command) => (
              <li className="quick-command" key={command.id}>
                <div className="quick-command__row">
                  <input
                    className="wc-input quick-command__name"
                    value={command.name}
                    aria-label="Command name"
                    placeholder="Name"
                    onChange={(event) =>
                      onCommandsChange(
                        updateCommand(commands, command.id, { name: event.target.value }),
                      )
                    }
                  />

                  {/* Two-click confirm in place, not a dialog: the chat stays live. */}
                  <button
                    type="button"
                    className="wc-button wc-button--ghost quick-command__delete"
                    data-confirming={confirmingDelete === command.id || undefined}
                    onClick={() => {
                      if (confirmingDelete === command.id) {
                        onCommandsChange(removeCommand(commands, command.id));
                        setConfirmingDelete(null);
                      } else {
                        setConfirmingDelete(command.id);
                      }
                    }}
                    onBlur={() => setConfirmingDelete((id) => (id === command.id ? null : id))}
                    title={
                      confirmingDelete === command.id ? 'Click again to delete' : 'Delete command'
                    }
                  >
                    {confirmingDelete === command.id ? 'Sure?' : <TrashIcon />}
                  </button>
                </div>

                <textarea
                  className="wc-input quick-command__text"
                  value={command.text}
                  rows={3}
                  aria-label={`${command.name || 'Command'} text`}
                  placeholder="What should land in the message box?"
                  onChange={(event) =>
                    onCommandsChange(
                      updateCommand(commands, command.id, { text: event.target.value }),
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          className="wc-button quick-commands__add"
          onClick={() => onCommandsChange(addCommand(commands, crypto.randomUUID()))}
        >
          <PlusIcon />
          Add command
        </button>
      </div>
    </Popover>
  );
}
