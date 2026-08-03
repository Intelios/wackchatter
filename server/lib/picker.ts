/**
 * A native folder chooser.
 *
 * The browser cannot hand a page a real filesystem path — a file input gives you bytes and a
 * name, and showDirectoryPicker gives you a handle. Since the server runs on the user's own
 * machine, it can open the OS dialog instead and report back what they picked.
 *
 * This is the one endpoint whose authority comes from a physical interaction rather than
 * from the request: it accepts no parameters at all. A hostile page can make the dialog
 * appear, which is a nuisance, but it cannot choose the answer. That is the difference
 * between this and the caller-supplied source directory that lib/backgrounds.ts refuses.
 */

import type { BrowseResult } from '../../shared/types/location.ts';

const PROMPT = 'Choose a folder for your WackChatter library';

/** A human is browsing a filesystem, not a machine answering a query. */
const TIMEOUT_MS = 120_000;

/*
 * -STA is required rather than decorative: WinForms dialogs need a single-threaded
 * apartment, and PowerShell 7 defaults to MTA, where ShowDialog() throws. powershell.exe is
 * used over pwsh for the same reason it is always available.
 */
const POWERSHELL_SCRIPT =
  'Add-Type -AssemblyName System.Windows.Forms; ' +
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
  `$d.Description = '${PROMPT}'; ` +
  "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }";

function command(): string[] | null {
  if (process.platform === 'darwin') {
    /*
     * Nothing is interpolated into this script, and nothing may ever be. Bun.spawn takes an
     * argv array so there is no shell, but `-e` is a *script* string: a path substituted in
     * here would be AppleScript injection. If a starting directory is ever wanted, it has to
     * come from the server's own state, never from the request.
     */
    return ['osascript', '-e', `POSIX path of (choose folder with prompt "${PROMPT}")`];
  }
  if (process.platform === 'win32') {
    return ['powershell.exe', '-NoProfile', '-STA', '-Command', POWERSHELL_SCRIPT];
  }
  if (Bun.which('zenity')) {
    return ['zenity', '--file-selection', '--directory', `--title=${PROMPT}`];
  }
  if (Bun.which('kdialog')) {
    return ['kdialog', '--getexistingdirectory', process.env.HOME ?? '.'];
  }
  return null;
}

export function canBrowse(): boolean {
  return command() !== null;
}

/** Only one dialog at a time, or a double-click leaves the user with two of them. */
let open = false;

export async function chooseFolder(): Promise<BrowseResult> {
  const argv = command();
  if (!argv) return { path: null, cancelled: true, timedOut: false };
  if (open) return { path: null, cancelled: true, timedOut: false };

  open = true;
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, TIMEOUT_MS);

  try {
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (timedOut) return { path: null, cancelled: false, timedOut: true };

    /*
     * Cancelling looks different on every platform, and none of them is an error worth
     * reporting: osascript exits 1 with "User canceled. (-128)", the PowerShell dialog exits
     * 0 with nothing on stdout, and zenity and kdialog exit 1 with nothing. Empty output
     * covers all four, so the exit code never has to be interpreted.
     */
    // osascript returns a trailing slash on the POSIX path; nothing else expects one.
    const path = stdout.trim().replace(/\/+$/, '');
    if (!path) return { path: null, cancelled: true, timedOut: false };

    return { path, cancelled: false, timedOut: false };
  } finally {
    clearTimeout(timer);
    open = false;
  }
}
