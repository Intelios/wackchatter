/**
 * Picking a cue you already saved in the Pool.
 *
 * The Pool's cues are what a blind round asks; a tournament stage asks one question each, so
 * the cues already written there are exactly the ones a stage should be able to reuse rather
 * than retype. This is a picker, not an editor: a click copies the text into the stage's field
 * and closes — the pool entry is untouched, so editing the copy here never rewrites your pool.
 *
 * The pool is a real library that can be empty, so the trigger is disabled with the reason
 * rather than opening an empty popup. That is the app's disabled-beats-refused rule: a greyed
 * button that explains itself beats a live one that leads nowhere.
 */

import type { ArenaProbe } from '@shared/types/arena.ts';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Popover, type PopoverTriggerProps } from '../../../components/Popover.tsx';
import { LayersIcon } from '../../../layout/icons.tsx';
import { IS_MACRO, MACRO_PARTS } from '../CueField.tsx';

interface SavedCuePickerProps {
  probes: readonly ArenaProbe[];
  /** Fill the stage's cue with this text. The popup closes itself first. */
  onPick: (text: string) => void;
  /** Which stage this fills, for the trigger's accessible name. */
  stageLabel: string;
}

export function SavedCuePicker({ probes, onPick, stageLabel }: SavedCuePickerProps) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const cueButtons = useCallback((): HTMLButtonElement[] => {
    const body = bodyRef.current;
    return body ? [...body.querySelectorAll<HTMLButtonElement>('button')] : [];
  }, []);

  /*
   * Land focus on the first cue when the popup opens, a layout effect for the backgrounded-
   * window reason every picker here documents. Only on open: a pick closes the popup, and the
   * caller moves focus into the stage's field, so there is no second focus moment here.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const body = bodyRef.current;
    if (!body || body.contains(document.activeElement)) return;
    cueButtons()[0]?.focus({ preventScroll: true });
  }, [open, cueButtons]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = cueButtons();
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(current + step + buttons.length) % buttons.length]?.focus({ preventScroll: true });
  };

  const empty = probes.length === 0;
  const disabledReason = empty ? 'No cues in your pool yet — add some in Pool.' : undefined;

  const renderTrigger = (props: PopoverTriggerProps) => (
    <button
      type="button"
      className="wc-button wc-button--ghost arena-savedcues__trigger"
      onClick={() => setOpen(!open)}
      {...props}
      ref={(node) => props.ref(node)}
    >
      <LayersIcon />
      Saved cue
    </button>
  );

  return (
    <Popover
      label={`Use a saved cue for ${stageLabel}`}
      icon={null}
      open={open}
      onOpenChange={setOpen}
      popupClassName="arena-savedcues"
      placement="bottom-end"
      disabled={empty}
      disabledReason={disabledReason}
      onKeyDown={onKeyDown}
      renderTrigger={renderTrigger}
    >
      <div ref={bodyRef} className="arena-savedcues__body">
        <ul className="arena-savedcues__list">
          {probes.map((probe) => (
            <li key={probe.id}>
              <button
                type="button"
                className="arena-savedcues__cue"
                title="Use this cue for this stage"
                onClick={() => {
                  setOpen(false);
                  onPick(probe.text);
                }}
              >
                {probe.text.split(MACRO_PARTS).map((part, index) =>
                  // Same split and key reasoning as the composer's mirror: text runs have no
                  // identity beyond their position.
                  IS_MACRO.test(part) ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: text runs have no other identity
                    <code key={index}>{part}</code>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: text runs have no other identity
                    <span key={index}>{part}</span>
                  ),
                )}
              </button>
            </li>
          ))}
        </ul>
        {empty ? <p className="arena-savedcues__empty">No cues in your pool yet.</p> : null}
      </div>
    </Popover>
  );
}
