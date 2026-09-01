import type { VersionInfo } from '../../lib/api.ts';

/**
 * The Start screen's version line. The behind suffix appears only when there is
 * something to say — 0 and unknown render exactly the line an up-to-date install
 * always showed.
 */
export function versionString(info: VersionInfo): string {
  let display = `WackChatter ${info.version}`;
  if (info.branch && info.revision) {
    display += ` '${info.branch}' (${info.revision})`;
  }
  if (info.commitsBehind != null && info.commitsBehind > 0) {
    const noun = info.commitsBehind === 1 ? 'commit' : 'commits';
    display += ` — ${info.commitsBehind} ${noun} behind`;
  }
  return display;
}
