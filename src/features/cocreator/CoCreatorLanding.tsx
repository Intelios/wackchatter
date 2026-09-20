import type { CSSProperties } from 'react';
import { Backdrop } from '../../components/Backdrop.tsx';
import { ChevronLeftIcon, CoCreatorIcon, SlidersIcon } from '../../layout/icons.tsx';
import type { EffectId } from '../backgrounds/effects.ts';
import { ParticleLayer } from '../backgrounds/ParticleLayer.tsx';
import './CoCreatorLanding.css';

interface CoCreatorLandingProps {
  backgroundUrl: string | null;
  backgroundBlur: number;
  backgroundDim: number;
  glass: boolean;
  effect: EffectId | null;
  effectLayer: 'behind' | 'front';
  onCharacter: () => void;
  onPreset: () => void;
  onExit: () => Promise<void>;
}

export function CoCreatorLanding(props: CoCreatorLandingProps) {
  return (
    <div
      className="cocreator-landing"
      data-glass={props.backgroundUrl !== null && props.glass}
      style={
        {
          '--wc-bg-blur': `${props.backgroundBlur}px`,
          '--wc-bg-dim': props.backgroundDim,
        } as CSSProperties
      }
    >
      <Backdrop url={props.backgroundUrl} />
      {props.backgroundUrl ? <div className="shell__scrim" aria-hidden="true" /> : null}
      <header className="cocreator-landing__bar">
        <button
          type="button"
          className="wc-button wc-button--ghost"
          onClick={() => void props.onExit()}
        >
          <ChevronLeftIcon /> Home
        </button>
        <strong>Co-Creator</strong>
        <span />
      </header>
      <main className="cocreator-landing__choices">
        <button type="button" className="cocreator-landing__choice" onClick={props.onCharacter}>
          <CoCreatorIcon />
          <span>
            <strong>Character Co-Creator</strong>
            <small>
              Design a character with an assistant, then hand the finished card to Studio.
            </small>
          </span>
        </button>
        <div className="cocreator-landing__divider" aria-hidden="true" />
        <button type="button" className="cocreator-landing__choice" onClick={props.onPreset}>
          <SlidersIcon />
          <span>
            <strong>Preset Co-Creator</strong>
            <small>
              Edit a guarded preset draft, test it in a private conversation, and publish when
              ready.
            </small>
          </span>
        </button>
      </main>
      <ParticleLayer effect={props.effect} layer={props.effectLayer} />
    </div>
  );
}
