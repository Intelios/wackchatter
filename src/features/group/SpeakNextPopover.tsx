/**
 * Who speaks next, in the composer's tray.
 *
 * The tray already answers "who am I" for the person typing (`PersonaChip`). In a group it
 * has to answer the same question on the other side of the exchange: which character is
 * being addressed — for `{{char}}` in the text you are writing, and for the guided reply
 * the wand steers. Picking a member here calls on them, so the chip is also the manual
 * "interrupt the director" door, the job the controls bar's "Speak next" select used to do
 * from a separate row below the transcript.
 *
 * Faces rather than a bare name, because in a group the name is not always the thing you
 * recognise: three cards with the same first name read identically in a `<select>`.
 */

import { type GroupMember, memberLabel } from '@shared/types/group.ts';
import { useLayoutEffect, useRef, useState } from 'react';
import { Popover } from '../../components/Popover.tsx';
import { ChevronIcon, UsersIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import './SpeakNextPopover.css';

interface SpeakNextPopoverProps {
  members: readonly GroupMember[];
  /** The member `{{char}}` currently resolves to. */
  selectedId: string;
  /** Members with a reply already in flight — they cannot speak twice at once. */
  busyIds: readonly string[];
  /** Why calling on anyone is unavailable at all (a summary or a memory run). */
  disabledReason?: string;
  /** The reply limit is spent or the cast is at its concurrency ceiling. */
  busyReason?: string;
  onSpeak: (id: string) => void;
}

export function SpeakNextPopover({
  members,
  selectedId,
  busyIds,
  disabledReason,
  busyReason,
  onSpeak,
}: SpeakNextPopoverProps) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = members.find((member) => member.id === selectedId) ?? null;

  /*
   * A member already mid-reply cannot be called on again, and the whole control locks
   * while a summary or memory run owns the provider. Both are stated on the row or the
   * trigger rather than left to fail silently — disabled beats refused.
   */
  const blockedReason = (member: GroupMember): string | undefined => {
    if (disabledReason) return disabledReason;
    if (member.muted) return 'This member is muted in the cast.';
    if (busyIds.includes(member.id)) return 'They are already replying.';
    return busyReason;
  };

  const enabled = members
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => !blockedReason(member));

  /*
   * Seeding the cursor on open, in the handler rather than an effect: the row the keyboard
   * path should start on is "the first member who can actually be called on", and that is
   * known at the moment the popup opens. An effect would have to re-derive it from a list
   * it also reads, which is the shape that ends up fighting the arrow keys.
   */
  const setOpenState = (next: boolean) => {
    if (next) setCursor(enabled[0]?.index ?? 0);
    setOpen(next);
  };

  useLayoutEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)
      ?.focus({ preventScroll: true });
  }, [open, cursor]);

  const move = (step: number) => {
    if (!enabled.length) return;
    const at = enabled.findIndex(({ index }) => index === cursor);
    const next = at === -1 ? 0 : (at + step + enabled.length) % enabled.length;
    const target = enabled[next] ?? enabled[0];
    if (target) setCursor(target.index);
  };

  return (
    <Popover
      label={
        selected ? `Speak next — ${memberLabel(selected, members)}` : 'Speak next — choose a member'
      }
      icon={null}
      open={open}
      onOpenChange={setOpenState}
      // Upward: the composer sits on the window's bottom edge.
      placement="top-start"
      role="listbox"
      className="speak-next"
      popupClassName="speak-next__popup"
      disabledReason={disabledReason}
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          className="speak-next__trigger"
          data-empty={!selected || undefined}
          onClick={() => setOpen(!open)}
        >
          {selected ? (
            <MemberFace member={selected} />
          ) : (
            <span className="speak-next__face" data-empty>
              <UsersIcon />
            </span>
          )}
          <span className="speak-next__name">{selected ? selected.name : 'Speak next'}</span>
          <ChevronIcon className="speak-next__chevron" />
        </button>
      )}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          // The cursor is seeded onto an enabled row and the arrow keys skip the blocked
          // ones, but a reply can settle while the popup is open and free or busy a row —
          // so the fallback matters rather than being defensive noise.
          const member =
            enabled.find(({ index }) => index === cursor)?.member ?? enabled[0]?.member;
          if (member) {
            onSpeak(member.id);
            setOpen(false);
          }
        }
      }}
    >
      <div className="speak-next__list" role="presentation" ref={listRef}>
        {members.map((member, index) => {
          const reason = blockedReason(member);
          return (
            <button
              type="button"
              key={member.id}
              data-index={index}
              role="option"
              aria-selected={index === cursor}
              aria-disabled={reason ? true : undefined}
              className="speak-next__row"
              data-cursor={index === cursor || undefined}
              data-current={member.id === selectedId || undefined}
              disabled={Boolean(reason)}
              title={reason}
              onMouseEnter={() => {
                if (!reason) setCursor(index);
              }}
              onClick={() => {
                onSpeak(member.id);
                setOpen(false);
              }}
            >
              <MemberFace member={member} />
              <span className="speak-next__row-name">{memberLabel(member, members)}</span>
              {/* The two reasons a row is dim read very differently — "muted" is a choice,
                  "replying" is a moment — so the state is named rather than just greyed. */}
              {member.muted ? <span className="speak-next__state">muted</span> : null}
              {!member.muted && busyIds.includes(member.id) ? (
                <span className="speak-next__state">replying</span>
              ) : null}
              {member.id === selectedId ? <span className="speak-next__you">macro</span> : null}
            </button>
          );
        })}
      </div>
      <p className="speak-next__foot">
        {disabledReason ?? 'Calling on a member has them reply next, as {{char}}.'}
      </p>
    </Popover>
  );
}

/** The member's card image, falling back to their initial when the card is gone. */
function MemberFace({ member }: { member: GroupMember }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="speak-next__face">
      {broken ? (
        <span aria-hidden="true">{member.name.slice(0, 1).toUpperCase()}</span>
      ) : (
        <img
          src={characterApi.imageUrl(member.characterId)}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
        />
      )}
    </span>
  );
}
