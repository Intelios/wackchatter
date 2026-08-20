import type { CharacterSummary } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type {
  CharacterStats as CardStats,
  StatsOverview as Overview,
} from '@shared/types/stats.ts';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Backdrop } from '../../components/Backdrop.tsx';
import { ChevronLeftIcon, RefreshIcon } from '../../layout/icons.tsx';
import { characterApi, statsApi } from '../../lib/api.ts';
import { CharacterStats } from './CharacterStats.tsx';
import { StatsOverview } from './StatsOverview.tsx';
import './StatsShell.css';

interface StatsShellProps {
  characters: readonly CharacterSummary[];
  personas: readonly Persona[];
  backgroundUrl: string | null;
  backgroundBlur: number;
  backgroundDim: number;
  glass: boolean;
  onExit: () => void;
}

/**
 * A separate destination, not a chat panel — the third of the set, and it shares the
 * Studio's shell structure on purpose. Read-only throughout: there is no persistence to
 * register and nothing to flush on the way out.
 */
export function StatsShell({
  characters,
  personas,
  backgroundUrl,
  backgroundBlur,
  backgroundDim,
  glass,
  onExit,
}: StatsShellProps) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [card, setCard] = useState<CardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await statsApi.overview());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const openCharacter = useCallback(async (avatar: string) => {
    setLoading(true);
    setError(null);
    try {
      setCard(await statsApi.character(avatar));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const backToOverview = useCallback(() => {
    setCard(null);
    setError(null);
  }, []);

  const cardName = card
    ? (characters.find((entry) => entry.avatar === card.characterId)?.name ?? card.characterId)
    : null;

  return (
    <div
      className="stats-shell"
      data-overlay-root
      data-glass={backgroundUrl !== null && glass}
      style={
        {
          '--wc-bg-blur': `${backgroundBlur}px`,
          '--wc-bg-dim': backgroundDim,
        } as CSSProperties
      }
    >
      <Backdrop url={backgroundUrl} />
      {backgroundUrl ? <div className="shell__scrim" aria-hidden="true" /> : null}

      <header className="stats-shell__bar">
        <div className="stats-shell__navigation">
          {card ? (
            <button type="button" className="wc-button wc-button--primary" onClick={backToOverview}>
              <ChevronLeftIcon />
              Back to overview
            </button>
          ) : null}
          <button type="button" className="wc-button wc-button--ghost" onClick={onExit}>
            <ChevronLeftIcon />
            Exit Stats
          </button>
        </div>

        <div className="stats-shell__title">
          {card ? (
            <>
              <img src={characterApi.imageUrl(card.characterId)} alt="" />
              <span>{cardName}</span>
            </>
          ) : (
            <span>Stats</span>
          )}
        </div>

        <div className="stats-shell__actions">
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => void (card ? openCharacter(card.characterId) : loadOverview())}
            disabled={loading}
            title="Recount from the library"
          >
            <RefreshIcon />
            Refresh
          </button>
        </div>
      </header>

      <div className="stats-shell__body">
        {error ? <p className="stats-shell__error">{error}</p> : null}
        {loading ? <div className="wc-empty">Counting…</div> : null}
        {!loading && card ? (
          <CharacterStats
            key={card.characterId}
            stats={card}
            characters={characters}
            personas={personas}
          />
        ) : null}
        {!loading && !card && overview ? (
          <StatsOverview
            stats={overview}
            characters={characters}
            personas={personas}
            onOpenCharacter={(avatar) => void openCharacter(avatar)}
          />
        ) : null}
      </div>
    </div>
  );
}
