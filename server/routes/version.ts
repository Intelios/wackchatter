import { join } from 'node:path';
import { json } from '../lib/http.ts';
import { PROJECT_ROOT } from '../lib/paths.ts';

interface VersionInfo {
  version: string;
  branch: string | null;
  revision: string | null;
}

let cached: VersionInfo | null = null;

async function resolveVersion(): Promise<VersionInfo> {
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
    return json(await resolveVersion());
  }
  return null;
}
