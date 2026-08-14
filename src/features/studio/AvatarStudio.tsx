import { useRef, useState } from 'react';
import { ImageIcon, UploadIcon } from '../../layout/icons.tsx';

interface AvatarStudioProps {
  avatarUrl: string;
  name: string;
  onReplace: (image: File) => Promise<void>;
}

/**
 * Centre-crop to the card's 2:3 ratio at 600x900.
 *
 * Exported so the Co-Creator's drop target does the identical thing — a card's artwork must
 * not depend on which screen it was dropped onto.
 */
export async function cropToCardRatio(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('The selected image could not be read.'));
      element.src = url;
    });
    const targetRatio = 2 / 3;
    const sourceRatio = image.naturalWidth / image.naturalHeight;
    const sourceWidth =
      sourceRatio > targetRatio ? image.naturalHeight * targetRatio : image.naturalWidth;
    const sourceHeight =
      sourceRatio > targetRatio ? image.naturalHeight : image.naturalWidth / targetRatio;
    const sourceX = (image.naturalWidth - sourceWidth) / 2;
    const sourceY = (image.naturalHeight - sourceHeight) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 900;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not prepare this image.');
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('Could not encode PNG.'))),
        'image/png',
      );
    });
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'avatar'}.png`, {
      type: 'image/png',
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Center-crops any source image to the 2:3 card portrait and always uploads PNG. */
export function AvatarStudio({ avatarUrl, name, onReplace }: AvatarStudioProps) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function replace(file: File | undefined) {
    if (!file || busy) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onReplace(await cropToCardRatio(file));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset
      className="avatar-studio"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void replace(event.dataTransfer.files[0]);
      }}
    >
      <legend className="wc-visually-hidden">Avatar image</legend>
      <img className="avatar-studio__image" src={avatarUrl} alt={`${name || 'Character'} avatar`} />
      <div className="avatar-studio__actions">
        <button
          type="button"
          className="wc-button"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? <ImageIcon /> : <UploadIcon />}
          {busy ? 'Preparing avatar…' : 'Replace avatar'}
        </button>
        <span className="wc-hint">
          Drop an image or choose one. It is center-cropped to 2:3 and saved as PNG.
        </span>
        {error ? <span className="avatar-studio__error">{error}</span> : null}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="wc-visually-hidden"
        onChange={(event) => {
          void replace(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </fieldset>
  );
}
