import type { DialogueColorOverride } from '@shared/types/settings.ts';
import { useEffect, useState } from 'react';
import { createPaletteCache } from './paletteCache.ts';
import {
  type PortraitPalette,
  resolveSpeakerColors,
  selectAvatarPalette,
} from './portraitPalette.ts';

export { contrastRatio } from '@shared/colors/color.ts';
export { needsPortrait, type PortraitPalette, resolveSpeakerColors } from './portraitPalette.ts';

async function extractAvatarPalette(url: string): Promise<PortraitPalette | null> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Avatar could not be loaded.'));
    image.src = url;
  });
  const scale = Math.min(1, 96 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return selectAvatarPalette(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
    canvas.width,
    canvas.height,
  );
}

const cache = createPaletteCache(extractAvatarPalette);
export const cachedAvatarPalette = cache.get;
export const peekAvatarPalette = cache.peek;

export function useAvatarPalette(url: string | null): PortraitPalette | null {
  const [state, setState] = useState<{ url: string | null; palette: PortraitPalette | null }>(
    () => ({
      url,
      palette: url ? (cache.peek(url) ?? null) : null,
    }),
  );
  useEffect(() => {
    let cancelled = false;
    if (!url) {
      setState({ url, palette: null });
      return;
    }
    const known = cache.peek(url);
    if (known !== undefined) {
      setState({ url, palette: known });
      return;
    }
    void cache.get(url).then((palette) => {
      if (!cancelled) setState({ url, palette });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (state.url === url) return state.palette;
  return url ? (cache.peek(url) ?? null) : null;
}

export function resolveDialogueColor(
  enabled: boolean,
  override: DialogueColorOverride | undefined,
  portrait: PortraitPalette | string | null,
) {
  return resolveSpeakerColors(enabled, override, portrait).dialogue;
}
