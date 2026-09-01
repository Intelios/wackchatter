import { join } from 'node:path';
import { json } from '../lib/http.ts';
import { PROJECT_ROOT } from '../lib/paths.ts';
import { createBehindChecker } from '../lib/updates.ts';

interface LocalVersion {
  version: string;
  branch: string | null;
  revision: string | null;
}

interface VersionInfo extends LocalVersion {
  commitsBehind: number | null;
}

/*
 * The local facts are cached for the process lifetime: an update via update.sh restarts
 * the server, so they cannot change under a running one. The behind count is the one
 * field that moves on its own — it lives in the TTL-gated checker instead.
 */
let cached: LocalVersion | null = null;

const behind = createBehindChecker(PROJECT_ROOT);

async function resolveVersion(): Promise<LocalVersion> {
  if (cached) return cached;

  let version = '0.0.0';
  try {
    const pkg = await Bun.file(join(PROJECT_ROOT, 'package.json')).json();
    version = pkg.version ?? version;
  } catch {}

  let branch: string | null = null;
  let revision: string | null = null;
  try {
    const opts = { cwd: PROJECT_ROOT, stdout: 'pipe' as const, stderr: 'ignore' as const };
    const [branchProc, revProc] = await Promise.all([
      Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], opts),
      Bun.spawn(['git', 'rev-parse', '--short', 'HEAD'], opts),
    ]);
    await Promise.all([branchProc.exited, revProc.exited]);
    if (branchProc.exitCode === 0) branch = (await new Response(branchProc.stdout).text()).trim();
    if (revProc.exitCode === 0) revision = (await new Response(revProc.stdout).text()).trim();
  } catch {}

  cached = { version, branch, revision };
  return cached;
}

export async function handleVersionRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  if (segments.length === 0 && request.method === 'GET') {
    // Not awaited: the refresh is a network fetch, and the count is a hint, not a fact
    // this response needs. The first requester sees null; the next one the number.
    void behind.maybeRefresh();
    const local = await resolveVersion();
    const payload: VersionInfo = { ...local, commitsBehind: behind.current()?.value ?? null };
    return json(payload);
  }
  return null;
}
