/**
 * The character sheet: what the Characters tool shows in place of an editor.
 *
 * Cards are written in the Studio and the Co-Creator, so this is a viewer with the three
 * things only you set, first: where the face strip is cut, your rating, and the colour the
 * character tints the app with. Then the creator's notes, then the card itself, folded.
 * Opening it never changes the open chat.
 */

import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import {
  AUTO_FACE_CROP,
  CHARACTER_RATING_MAX,
  type DialogueColorOverride,
} from '@shared/types/settings.ts';
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { DialogueColorField as ColourSwatches } from '../components/DialogueColorField.tsx';
import { useAvatarPalette } from '../features/chat/avatarColor.ts';
import { Markdown } from '../features/chat/Markdown.tsx';
import { StarIcon } from '../layout/icons.tsx';
import { characterApi } from '../lib/api.ts';
import { Icon } from './icons.tsx';
import {
  cardFolds,
  cardUpdates,
  coverOverflow,
  cropAfterDrag,
  greetingPreview,
  readableCardText,
  readableNotes,
  storedCrop,
} from './sheet.ts';
import './sheet.css';

export { ColourSwatches };

export interface CharacterSheetProps {
  avatar: string;
  /** The library's entry, for the name and picture before the full card arrives. */
  summary: CharacterSummary | undefined;
  /** Bumps when the portrait is replaced, so the picture is not served from cache. */
  avatarVersion: number | undefined;
  /** Who `{{user}}` is when card text is read here. */
  userName: string;
  rating: number | undefined;
  onRating: (value: number | undefined) => void;
  crop: number | undefined;
  onCrop: (value: number | undefined) => void;
  dialogueColor: DialogueColorOverride | undefined;
  dialogueColorsEnabled: boolean;
  onDialogueColor: (value: DialogueColorOverride | undefined) => void;
  countTokens: TokenCounter;
  onBack: () => void;
  onOpenStudio: () => void;
}

/**
 * A value set here, held until the saved setting comes back with it. Settings writes wait
 * for the server, and without the hold a star or a crop would flick back for a moment.
 */
export function useHeld<T>(saved: T): [T, (value: T) => void] {
  const [held, setHeld] = useState<{ value: T } | null>(null);
  useEffect(() => {
    if (
      held &&
      (Object.is(held.value, saved) || JSON.stringify(held.value) === JSON.stringify(saved))
    )
      setHeld(null);
  }, [held, saved]);
  return [held ? held.value : saved, (value: T) => setHeld({ value })];
}

export function CharacterSheet({
  avatar,
  summary,
  avatarVersion,
  userName,
  rating: savedRating,
  onRating,
  crop: savedCrop,
  onCrop,
  dialogueColor: savedColor,
  dialogueColorsEnabled,
  onDialogueColor,
  countTokens,
  onBack,
  onOpenStudio,
}: CharacterSheetProps) {
  const [detail, setDetail] = useState<CharacterDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const modified = summary?.modified;

  // The full card, fetched here rather than through the controller, so reading a card is
  // never a reason to switch the chat. Refetched when the file changes under us.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `modified` is the file's version; a Studio save must be read again
  useEffect(() => {
    let live = true;
    setLoadError(null);
    characterApi
      .get(avatar)
      .then((next) => {
        if (live) setDetail(next);
      })
      .catch((err: Error) => {
        if (live) setLoadError(err.message);
      });
    return () => {
      live = false;
    };
  }, [avatar, modified]);

  const name = detail?.name ?? summary?.name ?? avatar.replace(/\.png$/i, '');
  const imageUrl = characterApi.imageUrl(avatar, avatarVersion ?? modified);
  const autoColor = useAvatarPalette(imageUrl);
  const data = detail?.card.data;
  const names = { char: name, user: userName };

  const [rating, holdRating] = useHeld(savedRating);
  const [crop, holdCrop] = useHeld(savedCrop);
  const [color, holdColor] = useHeld(savedColor);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `names` is rebuilt every render from its two strings
  const folds = useMemo(
    () =>
      data
        ? cardFolds(data).map((fold) => {
            if (fold.kind === 'text') {
              return {
                ...fold,
                text: readableCardText(fold.text, names),
                tokens: countTokens.countText(fold.text),
              };
            }
            const items = fold.greetings.map((greeting) => {
              const read = readableCardText(greeting, names);
              return {
                text: read,
                ...greetingPreview(read),
                tokens: countTokens.countText(greeting),
              };
            });
            return {
              ...fold,
              items,
              total: items.reduce((sum, item) => sum + item.tokens, 0),
            };
          })
        : [],
    [data, countTokens, names.char, names.user],
  );
  const notes = data?.creator_notes?.trim()
    ? readableNotes(readableCardText(data.creator_notes, names))
    : '';
  const updates = data ? cardUpdates(data, names) : [];
  const book = data?.character_book?.entries?.length ?? 0;
  const tags = data?.tags?.filter((tag) => tag.trim()) ?? [];

  return (
    <div className="w3-sheet">
      <button type="button" className="w3-sheet__back" onClick={onBack}>
        <Icon name="chevronLeft" size="sm" />
        All characters
      </button>

      <section className="w3-sheet__yours" aria-label="Yours">
        <CropStrip
          imageUrl={imageUrl}
          name={name}
          crop={crop ?? AUTO_FACE_CROP}
          moved={crop !== undefined}
          onCommit={(value) => {
            const stored = storedCrop(value);
            holdCrop(stored);
            onCrop(stored);
          }}
        />
        <div className="w3-sheet__field">
          <span>Rating</span>
          <RatingStars
            value={rating}
            onChange={(value) => {
              holdRating(value);
              onRating(value);
            }}
          />
        </div>
        <div className="w3-sheet__field w3-sheet__field--colour">
          <span>Colour</span>
          <ColourSwatches
            value={color}
            autoPalette={autoColor}
            onChange={(value) => {
              holdColor(value);
              onDialogueColor(value);
            }}
          />
        </div>
        {dialogueColorsEnabled ? null : (
          <p className="w3-sheet__hint">
            Dialogue colours are switched off in Settings, so only the app's tint follows this.
          </p>
        )}
      </section>

      <section className="w3-sheet__group" aria-label="From the creator">
        <h3 className="w3-sheet__label">From the creator</h3>
        {loadError ? (
          <p className="w3-sheet__hint">{loadError}</p>
        ) : !detail ? (
          <p className="w3-sheet__hint">Loading…</p>
        ) : notes ? (
          <Markdown text={notes} className="w3-sheet__notes" />
        ) : (
          <p className="w3-sheet__hint">No notes from the creator.</p>
        )}
      </section>

      {updates.length ? (
        <section className="w3-sheet__group" aria-label="Updates">
          <h3 className="w3-sheet__label">Updates</h3>
          <div className="w3-sheet__timeline">
            {updates.map((update, index) => {
              const latest = index === 0;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: updates carry no id of their own
                <article key={index} className="w3-sheet__update" data-latest={latest || undefined}>
                  {update.label ? (
                    <span className="w3-sheet__update-label">{update.label}</span>
                  ) : null}
                  <Markdown text={update.text} className="w3-sheet__update-text" />
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {detail ? (
        <section className="w3-sheet__group" aria-label="The card">
          <h3 className="w3-sheet__label">The card</h3>
          <div>
            {folds.map((fold) =>
              fold.kind === 'greetings' ? (
                <GreetingsFold
                  key={fold.id}
                  label={fold.label}
                  total={fold.total}
                  items={fold.items}
                />
              ) : (
                <Fold key={fold.id} label={fold.label} tokens={fold.tokens} text={fold.text} />
              ),
            )}
          </div>
          <div className="w3-sheet__facts">
            {tags.length ? <span>{tags.join(' · ')}</span> : null}
            <span>
              {book ? `Lorebook · ${book} ${book === 1 ? 'entry' : 'entries'}` : 'No lorebook'}
            </span>
            {data?.character_version ? <span>v{data.character_version}</span> : null}
            {data?.creator ? <span>by {data.creator}</span> : null}
          </div>
        </section>
      ) : null}

      <button type="button" className="w3-sheet__studio" onClick={onOpenStudio}>
        <Icon name="studio" size="sm" />
        Open in Studio
      </button>
    </div>
  );
}

/** One section of the card, closed until asked for. */
function Fold({ label, tokens, text }: { label: string; tokens: number; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w3-sheet__fold" data-open={open || undefined}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {label}
        <small>{tokens.toLocaleString()} tokens</small>
        <Icon name="chevronDown" size="xs" />
      </button>
      {open ? <div className="w3-sheet__fold-text">{text}</div> : null}
    </div>
  );
}

interface GreetingItem {
  text: string;
  lead: string;
  trail: string;
  tokens: number;
}

/**
 * Alternate greetings as a list of openings: each row offers its first two lines, and
 * only the one being read is open. The opening's own text starts where its preview did.
 */
function GreetingsFold({
  label,
  total,
  items,
}: {
  label: string;
  total: number;
  items: GreetingItem[];
}) {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState<number | null>(null);
  return (
    <div className="w3-sheet__fold" data-open={open || undefined}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {label}
        <small>{total.toLocaleString()} tokens</small>
        <Icon name="chevronDown" size="xs" />
      </button>
      {open ? (
        <div className="w3-sheet__greetings">
          {items.map((item, index) => {
            const shown = reading === index;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: greetings carry no id of their own
              <div key={index} className="w3-sheet__greeting" data-open={shown || undefined}>
                <button
                  type="button"
                  className="w3-sheet__greeting-head"
                  aria-expanded={shown}
                  onClick={() => setReading(shown ? null : index)}
                >
                  <span className="w3-sheet__greeting-no">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  {shown ? (
                    <span className="w3-sheet__greeting-label">Opening {index + 1}</span>
                  ) : (
                    <span className="w3-sheet__greeting-copy">
                      <span className="w3-sheet__greeting-lead">{item.lead}</span>
                      {item.trail ? (
                        <span className="w3-sheet__greeting-trail">{item.trail}</span>
                      ) : null}
                    </span>
                  )}
                  <span className="w3-sheet__greeting-tokens">{item.tokens.toLocaleString()}</span>
                  <Icon name="chevronDown" size="xs" />
                </button>
                {shown ? <div className="w3-sheet__greeting-text">{item.text}</div> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The face strip at full size, dragged up or down to choose where the list cuts it. The
 * picture follows the pointer; the arrow keys move it too. Saved when you let go.
 */
function CropStrip({
  imageUrl,
  name,
  crop,
  moved,
  onCommit,
}: {
  imageUrl: string;
  name: string;
  crop: number;
  moved: boolean;
  onCommit: (value: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ y: number; start: number; overflow: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? crop;

  function down(event: PointerEvent<HTMLDivElement>) {
    const el = box.current;
    const img = image.current;
    if (!el || !img || event.button !== 0) return;
    const overflow = coverOverflow(
      { width: el.clientWidth, height: el.clientHeight },
      { width: img.naturalWidth, height: img.naturalHeight },
    );
    drag.current = { y: event.clientY, start: crop, overflow };
    el.setPointerCapture(event.pointerId);
    setLive(crop);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    setLive(cropAfterDrag(state.start, event.clientY - state.y, state.overflow));
  }

  function up() {
    if (!drag.current) return;
    drag.current = null;
    if (live !== null && live !== crop) onCommit(live);
    setLive(null);
  }

  function key(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowUp') onCommit(Math.max(0, crop - step));
    else if (event.key === 'ArrowDown') onCommit(Math.min(100, crop + step));
    else return;
    event.preventDefault();
  }

  return (
    <div className="w3-sheet__crop-wrap">
      <div
        ref={box}
        className="w3-sheet__crop"
        data-dragging={live !== null || undefined}
        role="slider"
        tabIndex={0}
        aria-label={`Where ${name}'s strip is cut`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={`${Math.round(shown)}% down the portrait`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
      >
        <img
          ref={image}
          src={imageUrl}
          alt=""
          draggable={false}
          style={{ objectPosition: `50% ${shown}%` }}
        />
        <span className="w3-sheet__grip" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="w3-sheet__crop-note">
        <span>Drag to move the crop</span>
        {moved ? (
          <button type="button" onClick={() => onCommit(AUTO_FACE_CROP)}>
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Five stars. Clicking the N-th rates N and clicking the current one clears it. The stars
 * that light up pop in one after another, so a change is seen, not just stated.
 */
function RatingStars({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  // Which click this is, so the pop replays on every change, not only the first.
  const [pop, setPop] = useState(0);
  return (
    <div className="w3-sheet__stars" data-pop={pop || undefined}>
      {Array.from({ length: CHARACTER_RATING_MAX }, (_, index) => index + 1).map((star) => {
        const on = value !== undefined && star <= value;
        return (
          <button
            key={`${star}-${pop}`}
            type="button"
            aria-pressed={on}
            aria-label={`${star} ${star === 1 ? 'star' : 'stars'}`}
            data-on={on || undefined}
            style={{ '--i': star - 1 } as React.CSSProperties}
            onClick={() => {
              setPop((count) => count + 1);
              onChange(value === star ? undefined : star);
            }}
          >
            <StarIcon filled={on} />
          </button>
        );
      })}
      <small>{value === undefined ? 'Unrated' : `${value} of ${CHARACTER_RATING_MAX}`}</small>
    </div>
  );
}
