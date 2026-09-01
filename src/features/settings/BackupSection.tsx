/**
 * Backing the library up.
 *
 * The data directory has always been one portable unit — this is the button that admits it.
 * It sits beside the trash bin and the data location for the reason given there: a
 * destination is a claim about how often you need something, and you back your library up
 * about as often as you move it.
 *
 * There is deliberately no restore button, and its absence is the design rather than a gap.
 * An unzipped backup is a library like any other, so Data location directly below already
 * restores one by adopting it — a path that is built and tested. The instructions here are
 * the only place anyone will ever learn that, which is why they are always visible instead
 * of appearing after a download: by the time they are needed, this app is running on a
 * machine that has lost its library.
 */

import type { BackupPlan } from '@shared/types/backup.ts';
import { useCallback, useEffect, useState } from 'react';
import { CheckField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { DownloadIcon } from '../../layout/icons.tsx';
import { libraryApi } from '../../lib/api.ts';
import { downloadUrl } from '../../lib/download.ts';
import { formatBytes } from './dataLocation.ts';
import './BackupSection.css';

export function BackupSection() {
  const [plan, setPlan] = useState<BackupPlan | null>(null);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  /*
   * Section unmounts its children when collapsed, so this walks the library when someone
   * opens the panel and never otherwise. Re-run when the checkbox flips: including the keys
   * changes the file count, and a count that disagrees with the archive is worse than none.
   */
  const refresh = useCallback(async (secrets: boolean) => {
    try {
      setPlan(await libraryApi.check(secrets));
      setError('');
    } catch (err) {
      setPlan(null);
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh(includeSecrets);
  }, [refresh, includeSecrets]);

  function handleDownload() {
    if (!plan) return;
    /*
     * One message covering both phases, because the page cannot tell them apart. The server
     * builds the whole archive before it answers — draining pending writes, walking the
     * library, snapshotting the database — and only then does the browser start downloading
     * it. An anchor reports neither transition back here, so a timed second message would
     * be guessing, and it would guess wrong on exactly the large libraries that need it.
     *
     * The browser's own progress bar takes over from there, and is a real one: the archive
     * is a finished file by the time it is served, so the response carries a content-length.
     */
    setStatus(
      'Preparing your backup, then your browser will download it. A large library takes a moment.',
    );
    downloadUrl(libraryApi.exportUrl(includeSecrets));
  }

  return (
    <Section title="Backup" badge={plan ? formatBytes(plan.bytes) : undefined}>
      <p className="wc-hint backup__summary">
        {plan
          ? `${plan.files} files · ${formatBytes(plan.bytes)}. Everything in one zip: characters, chats, presets, personas, lorebooks, backgrounds and the deleted-chat bin.`
          : 'Everything in one zip: characters, chats, presets, personas, lorebooks, backgrounds and the deleted-chat bin.'}
      </p>

      <CheckField
        label="Include API keys"
        checked={includeSecrets}
        onChange={setIncludeSecrets}
        hint={
          'Off by default. The zip goes to your downloads folder with no protection on it, ' +
          'so anyone who opens it can read your keys in plain text. Leave this off and you ' +
          're-enter them once after restoring.'
        }
      />

      <div className="backup__actions">
        <button
          type="button"
          className="wc-button"
          onClick={handleDownload}
          disabled={!plan}
          title={plan ? undefined : (error ?? 'Working out what is in your library.')}
        >
          <DownloadIcon />
          {plan ? `Download backup · ${formatBytes(plan.bytes)}` : 'Download backup'}
        </button>
      </div>

      {error ? (
        <p className="wc-hint" role="alert">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="wc-hint" role="status">
          {status}
        </p>
      ) : null}

      <p className="backup__restore">
        <strong>To restore:</strong> unzip the file anywhere, then point{' '}
        <strong>Data location</strong> below at the folder inside it. WackChatter recognises it as a
        library and adopts it — nothing is moved, and the chat database comes back whole.
      </p>
    </Section>
  );
}
