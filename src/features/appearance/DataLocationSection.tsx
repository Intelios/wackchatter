import type { LocationInfo, LocationVerdict } from '@shared/types/location.ts';
import { useCallback, useEffect, useState } from 'react';
import { TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { locationApi } from '../../lib/api.ts';
import { describeCurrent, describeVerdict } from './dataLocation.ts';
import './DataLocationSection.css';

interface DataLocationSectionProps {
  /** The preset draft is the one thing that could be lost to the reload after a move. */
  unsavedPreset?: boolean;
}

/**
 * Where the library lives, and how to move it.
 *
 * Kept out of a panel of its own: a top-bar destination is a claim about how often you need
 * something, and you relocate your data about once. This is the same reasoning that put the
 * tokenizer and streaming rate under Advanced.
 */
export function DataLocationSection({ unsavedPreset = false }: DataLocationSectionProps) {
  const [info, setInfo] = useState<LocationInfo | null>(null);
  const [draft, setDraft] = useState('');
  const [verdict, setVerdict] = useState<LocationVerdict | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const refresh = useCallback(async () => {
    try {
      // Render immediately, then fill the size in — walking a big gallery is not free.
      setInfo(await locationApi.get(false));
      setInfo(await locationApi.get(true));
    } catch (err) {
      setStatus((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const inspect = useCallback(async (path: string) => {
    // Re-checking disarms the confirm. Leaving it armed across a change would carry a click
    // meant for one folder over to another, and would leave a disabled button still styled
    // as though it were one press from acting.
    setConfirming(false);

    const trimmed = path.trim();
    if (!trimmed) {
      setVerdict(null);
      return;
    }
    try {
      setVerdict(await locationApi.inspect(trimmed));
    } catch (err) {
      setStatus((err as Error).message);
    }
  }, []);

  async function handleBrowse() {
    setStatus('A folder chooser has opened — it may be behind this window.');
    try {
      const result = await locationApi.browse();
      setStatus(result.timedOut ? 'The folder chooser timed out.' : '');
      if (result.path) {
        setDraft(result.path);
        await inspect(result.path);
      }
    } catch (err) {
      setStatus((err as Error).message);
    }
  }

  async function handleMove() {
    if (!verdict?.ok || verdict.kind === 'same') return;

    setBusy(true);
    setConfirming(false);
    setStatus('Moving your library — don’t close this tab.');
    try {
      const result = await locationApi.move(verdict.path, verdict.kind);
      const notes = [...result.warnings];
      if (result.oldPathKept) notes.push(`Your old folder is still at ${result.oldPathKept}.`);
      setStatus(`Done. ${notes.join(' ')} Reloading…`.trim());

      /*
       * A full reload rather than invalidating caches. Character lists, presets, personas,
       * lorebooks, background URLs, the open chat and its messages all now point at a
       * different library, and any one of them missed would be a silent wrong-data bug.
       * This happens once in the app's life; one line that is provably correct beats a
       * large invalidation surface that is probably correct.
       */
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      setBusy(false);
      setStatus((err as Error).message);
      await refresh();
      await inspect(draft);
    }
  }

  if (!info) return null;

  const description = verdict ? describeVerdict(verdict, info, { busy, unsavedPreset }) : null;
  const canMove = Boolean(description && !description.disabledReason);

  return (
    <Section title="Data location">
      <div className="data-location__current">
        <code className="data-location__path">{info.root}</code>
        <p className="wc-hint">{describeCurrent(info).join(' · ')}</p>
      </div>

      {info.needsRestart ? (
        <p className="data-location__note" data-tone="danger">
          {info.needsRestart}
        </p>
      ) : null}

      {info.unreachable ? (
        <p className="data-location__note" data-tone="warn">
          Your chosen folder {info.unreachable} could not be used, so this one is in use instead.
          The setting has not been changed — reconnect the folder and restart.
        </p>
      ) : null}

      {info.warnings.map((warning) => (
        <p key={warning.kind} className="data-location__note" data-tone="warn">
          {warning.message}
        </p>
      ))}

      <div className="data-location__pick">
        <TextField
          label="Move to"
          value={draft}
          onChange={setDraft}
          onCommit={() => void inspect(draft)}
          placeholder={info.defaultRoot}
          hint={
            info.envLocked
              ? 'WC_DATA_DIR pins the folder. Unset it and restart to change it here.'
              : info.canBrowse
                ? 'Pick a folder, or type a full path.'
                : 'Type a full path. No folder chooser is installed — on Linux, zenity or kdialog provides one.'
          }
        />
        {info.canBrowse && !info.envLocked ? (
          <button
            type="button"
            className="wc-button wc-button--ghost data-location__browse"
            onClick={() => void handleBrowse()}
            disabled={busy}
          >
            Browse…
          </button>
        ) : null}
      </div>

      {description ? (
        <div className="data-location__verdict" data-tone={description.tone}>
          {description.detail.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}

      <div className="data-location__actions">
        {/* Two-click confirm in place. A move is destructive enough to confirm and far too
            slow to interrupt the chat with a dialog. */}
        <button
          type="button"
          className="wc-button wc-button--danger"
          disabled={!canMove}
          title={description?.disabledReason ?? undefined}
          aria-label={
            confirming ? `Click again to ${description?.label.toLowerCase()}` : description?.label
          }
          data-confirming={confirming || undefined}
          onBlur={() => setConfirming(false)}
          onClick={() => (confirming ? void handleMove() : setConfirming(true))}
        >
          {busy
            ? 'Moving…'
            : confirming
              ? 'Click again to confirm'
              : (description?.label ?? 'Move here')}
        </button>

        {info.source !== 'default' && !info.envLocked ? (
          <button
            type="button"
            className="wc-button wc-button--ghost"
            disabled={busy}
            onClick={() => {
              setDraft(info.defaultRoot);
              void inspect(info.defaultRoot);
            }}
          >
            Use the default folder
          </button>
        ) : null}
      </div>

      {status ? <p className="wc-hint">{status}</p> : null}
    </Section>
  );
}
