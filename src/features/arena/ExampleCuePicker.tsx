/**
 * The example-cue picker: pre-made cues, offered not bundled.
 *
 * "Add cue" gives you a blank; this gives you a starting point — open-ended cues grouped by
 * what they separate models on, because picking a benchmark cue is really picking what to
 * test. A click inserts the text as your own cue (see `exampleCues.ts` for why they are
 * never bundled), so the pool below stays plain user data with no provenance to track.
 *
 * Built on `Popover` via `renderTrigger`, because Popover is the app's only popup mechanism.
 * The popup stays open across adds — populating a pool means taking several — and an
 * example whose exact text is already in the pool shows up disabled rather than refusing
 * the click, per the disabled-beats-refused convention. Matching is by text, not identity:
 * an added cue becomes yours to edit, and an edited cue is no longer that example.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Popover, type PopoverTriggerProps } from '../../components/Popover.tsx';
import { WandIcon } from '../../layout/icons.tsx';
import { IS_MACRO, MACRO_PARTS } from './CueField.tsx';
import { EXAMPLE_CUE_GROUPS } from './exampleCues.ts';

interface ExampleCuePickerProps {
  /** Cue texts already in the pool — those examples present as added and are disabled. */
  existing: ReadonlySet<string>;
  /** Inserts the example as a new cue, exactly as "Add cue" would. */
  onAdd: (text: string) => void;
}

export function ExampleCuePicker({ existing, onAdd }: ExampleCuePickerProps) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const addableButtons = useCallback((): HTMLButtonElement[] => {
    const body = bodyRef.current;
    return body ? [...body.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')] : [];
  }, []);

  /*
   * Two focus moments, one rule: while the popup is open, if focus is not inside it, put it
   * on the first addable cue.
   *
   * On open that lands keyboard users on the first example rather than leaving them on the
   * trigger. The subtler case is an add: the clicked button becomes disabled in the same
   * update, and disabling a focused element drops focus to <body> — without this, one click
   * in and Escape no longer restores to the trigger. A layout effect, not a frame callback,
   * for the backgrounded-window reason every other picker here documents.
   *
   * `existing` in the deps is the re-run trigger rather than a value read: it changes
   * exactly when a cue is added, which is the moment the disabled button drops focus.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: existing is a deliberate re-run trigger
  useLayoutEffect(() => {
    if (!open) return;
    const body = bodyRef.current;
    if (!body || body.contains(document.activeElement)) return;
    addableButtons()[0]?.focus({ preventScroll: true });
  }, [open, existing, addableButtons]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = addableButtons();
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(current + step + buttons.length) % buttons.length]?.focus({ preventScroll: true });
  };

  const renderTrigger = (props: PopoverTriggerProps) => (
    <button
      type="button"
      className="wc-button"
      onClick={() => setOpen(!open)}
      {...props}
      ref={(node) => props.ref(node)}
    >
      <WandIcon />
      Example cues
    </button>
  );

  return (
    <Popover
      label="Example cues"
      icon={null}
      open={open}
      onOpenChange={setOpen}
      popupClassName="arena-examples"
      placement="bottom-end"
      onKeyDown={onKeyDown}
      renderTrigger={renderTrigger}
    >
      <div ref={bodyRef} className="arena-examples__body">
        {EXAMPLE_CUE_GROUPS.map((group) => (
          <section key={group.id} className="arena-examples__group">
            <h3 className="arena-examples__label">{group.label}</h3>
            <p className="arena-examples__note">{group.note}</p>
            <ul className="arena-examples__cues">
              {group.cues.map((text) => {
                const added = existing.has(text);
                return (
                  <li key={text}>
                    <button
                      type="button"
                      className="arena-examples__cue"
                      data-on={added}
                      disabled={added}
                      title={added ? 'Already in your cues' : 'Add this cue to your pool'}
                      onClick={() => onAdd(text)}
                    >
                      {text.split(MACRO_PARTS).map((part, index) =>
                        // Same split, same key reasoning as the composer's mirror: text runs
                        // have no identity of their own beyond their position.
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
                );
              })}
            </ul>
          </section>
        ))}
        <p className="arena-examples__foot">
          Adding one makes it yours — edit or remove it below like any cue. Macros expand per card.
        </p>
      </div>
    </Popover>
  );
}
