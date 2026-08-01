/**
 * The image formats this app accepts, and their content types.
 *
 * Shared rather than per-feature: persona avatars and backgrounds accept the same set,
 * and two copies of the list would drift the moment one of them gained a format.
 */

import { extname } from 'node:path';

export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function isImageFilename(filename: string): boolean {
  return Boolean(IMAGE_TYPES[extname(filename).toLowerCase()]);
}

export function contentTypeFor(filename: string): string {
  return IMAGE_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}
