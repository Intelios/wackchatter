/**
 * Fetching an image the app already serves back into a `File`, so it can be re-uploaded to
 * another endpoint.
 *
 * Shared by the Co-Creator's Finish (stash art onto a new card) and the persona converter
 * (a character's portrait onto the persona derived from it). Both want the same policy on
 * failure, stated once below.
 */

/**
 * Returns null on any failure rather than throwing.
 *
 * Artwork is worth losing before the thing it decorates: a failed fetch finishes the save
 * without a picture rather than aborting the whole output. Named `avatar.png` because the
 * upload endpoints check the filename extension (`isImageFilename`) before the bytes.
 */
export async function fetchPngFile(url: string): Promise<File | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return new File([await response.blob()], 'avatar.png', { type: 'image/png' });
  } catch {
    return null;
  }
}
