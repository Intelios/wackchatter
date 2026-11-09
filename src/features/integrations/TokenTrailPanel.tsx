import { useCallback, useEffect, useState } from 'react';
import './TokenTrailPanel.css';

/**
 * The `tokentrail:` link for this library (and the open character), opened once on mount.
 */
export function useTokenTrailLink(character: string | null) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const prepare = useCallback(async () => {
    try {
      const response = await fetch('/api/integration');
      if (!response.ok) throw new Error('Could not read library identity.');
      const data = (await response.json()) as { libraryId: string };
      const params = new URLSearchParams({ library: data.libraryId });
      if (character) params.set('character', character);
      const link = `tokentrail://wackchatter?${params}`;
      setUrl(link);
      setError('');
      return link;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }, [character]);
  const open = useCallback(() => {
    void prepare().then((link) => {
      if (link) window.location.href = link;
    });
  }, [prepare]);
  useEffect(() => {
    open();
  }, [open]);
  return { url, error, open };
}

export const TOKENTRAIL_RELEASES = 'https://github.com/Intelios/TokenTrail/releases';

export function TokenTrailPanel({
  onExit,
  character,
}: {
  onExit: () => void;
  character: string | null;
}) {
  const { url, error, open } = useTokenTrailLink(character);
  return (
    <main className="tokentrail-panel">
      <button type="button" className="wc-button wc-button--ghost" onClick={onExit}>
        ← Back to WackChatter
      </button>
      <section>
        <p className="tokentrail-panel__eyebrow">THE WACK ECOSYSTEM</p>
        <h1>Your Stats live in TokenTrail</h1>
        <p>
          Characters, conversations, models, and the generations behind your stories — together with
          WackCode and your other AI tools.
        </p>
        <p>
          Everything stays on this computer. TokenTrail can read your library even when WackChatter
          is closed.
        </p>
        {error ? <p role="alert">{error}</p> : null}
        {url ? (
          <a className="wc-button wc-button--primary" href={url}>
            Open TokenTrail ↗
          </a>
        ) : null}
        <button type="button" className="wc-button" onClick={open}>
          Retry
        </button>
        <a
          className="wc-button wc-button--ghost"
          href={TOKENTRAIL_RELEASES}
          target="_blank"
          rel="noreferrer"
        >
          Get TokenTrail ↗
        </a>
        <p>
          Accept your browser’s open-app prompt. If nothing opens, install or update TokenTrail,
          then retry.
        </p>
      </section>
    </main>
  );
}
