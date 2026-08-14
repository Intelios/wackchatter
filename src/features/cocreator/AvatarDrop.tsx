import { useRef, useState } from 'react';
import { ImageIcon, TrashIcon } from '../../layout/icons.tsx';
import { cocreatorApi } from '../../lib/api.ts';
import { cropToCardRatio } from '../studio/AvatarStudio.tsx';

interface AvatarDropProps {
  sessionId: string;
  /** Filename under data/cocreator/avatars, or null. */
  avatar: string | null;
  /** Cache key for the image URL — the session's `modified`. */
  cacheKey: number;
  busy: boolean;
  onChanged: (avatar: string | null) => void;
  onError: (message: string) => void;
}

/**
 * Artwork for the card, dropped while designing rather than after.
 *
 * Reuses the Studio's crop so a card's art does not depend on which screen it was dropped
 * onto. There is no image generation here — this is the same drop target, moved earlier in
 * the flow so Finish can produce a finished card in one request.
 */
export function AvatarDrop({
  sessionId,
  avatar,
  cacheKey,
  busy,
  onChanged,
  onError,
}: AvatarDropProps) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [working, setWorking] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  async function accept(file: File | undefined) {
    if (!file || busy || working) return;
    setWorking(true);
    try {
      const saved = await cocreatorApi.setAvatar(sessionId, await cropToCardRatio(file));
      onChanged(saved.avatar);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setWorking(false);
    }
  }

  async function clear() {
    setConfirmClear(false);
    setWorking(true);
    try {
      await cocreatorApi.clearAvatar(sessionId);
      onChanged(null);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="avatar-drop" data-over={over || undefined} data-empty={!avatar || undefined}>
      <button
        type="button"
        className="avatar-drop__target"
        disabled={busy || working}
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void accept(event.dataTransfer.files[0]);
        }}
        title={avatar ? 'Replace the artwork' : 'Drop an image, or click to choose one'}
      >
        {avatar ? (
          <img src={cocreatorApi.avatarUrl(sessionId, cacheKey)} alt="" />
        ) : (
          <span className="avatar-drop__placeholder">
            <ImageIcon />
            {working ? 'Saving…' : 'Add artwork'}
          </span>
        )}
      </button>

      {avatar ? (
        <button
          type="button"
          className="wc-button wc-button--ghost wc-button--danger avatar-drop__clear"
          data-confirming={confirmClear}
          disabled={busy || working}
          onClick={() => (confirmClear ? void clear() : setConfirmClear(true))}
          onBlur={() => setConfirmClear(false)}
          aria-label={confirmClear ? 'Click again to remove' : 'Remove artwork'}
          title={confirmClear ? 'Click again to remove' : 'Remove artwork'}
        >
          <TrashIcon />
        </button>
      ) : null}

      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          void accept(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </div>
  );
}
