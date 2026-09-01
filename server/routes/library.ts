/**
 * Backing the whole library up.
 *
 * A group of its own rather than a branch of /api/backups: that one is the deleted-chat
 * trash bin, where a slot is something you restore a single chat from. This is the entire
 * library on its way out of the app, and the two would only be confused for each other.
 */

import { contentDisposition, errorResponse, json } from '../lib/http.ts';
import { BackupError, type BackupOptions, planBackup, startBackup } from '../lib/library.ts';

/** Long enough for any loopback download, short enough that temp does not fill up. */
const ARCHIVE_TTL_MS = 15 * 60 * 1000;

function optionsFrom(request: Request): BackupOptions {
  return { secrets: new URL(request.url).searchParams.get('secrets') === '1' };
}

export async function handleLibraryRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;
  if (segments[0] !== 'export') return null;

  /*
   * /api/library/export/check — the preflight.
   *
   * A separate GET because the download itself is an anchor navigation, which can neither
   * be awaited nor return JSON. Fetching the count first is what lets the panel put a size
   * on the button, and what gives the failures a user can actually hit somewhere to land.
   */
  if (segments[1] === 'check' && segments.length === 2) {
    if (method !== 'GET') return null;
    return json(planBackup(optionsFrom(request)));
  }

  // /api/library/export
  if (segments.length === 1) {
    if (method !== 'GET') return null;
    try {
      const { plan, path, dispose } = await startBackup(optionsFrom(request));

      /*
       * The archive is disposable the moment the download finishes, but nothing here can
       * observe that — a file body has no completion hook. So it goes on a timer far longer
       * than any loopback transfer needs, and sweepStaleArchives() collects whatever a crash
       * leaves behind. Unref'd so a pending backup never holds the process open.
       */
      setTimeout(dispose, ARCHIVE_TTL_MS).unref();

      /*
       * Bun serves a file body in constant memory and fills in content-length itself, which
       * is what gives the browser a real percentage rather than a bare byte counter. Handing
       * back a stream instead would make Bun buffer the whole archive — see lib/library.ts.
       */
      return new Response(Bun.file(path), {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': contentDisposition(plan.filename),
          'cache-control': 'no-store',
        },
      });
    } catch (error) {
      // Every failure that can be reported is raised before this Response exists — once the
      // 200 is on the wire a throw can only produce a truncated archive.
      if (error instanceof BackupError) return errorResponse(error.message, error.status);
      throw error;
    }
  }

  return null;
}
