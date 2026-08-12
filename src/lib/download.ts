/**
 * Trigger a browser download for a URL.
 *
 * The anchor is synthesised rather than rendered because a download usually has to wait on
 * something first — draining a pending autosave, say — and a plain `<a download>` navigates
 * before any handler can await. `download` is left empty so the server's
 * `content-disposition` names the file.
 */
export function downloadUrl(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
