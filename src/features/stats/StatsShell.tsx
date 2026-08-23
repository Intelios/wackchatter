import type { CharacterSummary } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type {
  CharacterStats as CardStats,
  StatsOverview as Overview,
} from '@shared/types/stats.ts';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Backdrop } from '../../components/Backdrop.tsx';
import { ChevronLeftIcon, RefreshIcon } from '../../layout/icons.tsx';
import { characterApi, statsApi } from '../../lib/api.ts';
import type { EffectId } from '../backgrounds/effects.ts';
import { ParticleLayer } from '../backgrounds/ParticleLayer.tsx';
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
  effect: EffectId | null;
  effectLayer: 'behind' | 'front';
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
  effect,
  effectLayer,
  onExit,
}: StatsShellProps) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [card, setCard] = useState<CardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const loadOverview = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const data = await statsApi.overview();
      if (requestSeq.current !== seq) return;
      setOverview(data);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError((err as Error).message);
    } finally {
      if (requestSeq.current === seq) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    return () => {
      requestSeq.current += 1;
    };
  }, [loadOverview]);

  const openCharacter = useCallback(async (avatar: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const data = await statsApi.character(avatar);
      if (requestSeq.current !== seq) return;
      setCard(data);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError((err as Error).message);
    } finally {
      if (requestSeq.current === seq) {
        setLoading(false);
      }
    }
  }, []);

  const backToOverview = useCallback(() => {
    requestSeq.current += 1;
    setCard(null);
    setError(null);
    setLoading(false);
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

      {/* The shell's last static child; see the AppShell comment for the stacking rule. */}
      <ParticleLayer effect={effect} layer={effectLayer} />
    </div>
  );
}
