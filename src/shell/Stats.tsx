/**
 * Stats: a hand-off, not a screen of numbers. The stats live in TokenTrail, a separate app;
 * this opens it on this library (and the open character) and says what to do when nothing
 * opens. Opening it never stops a reply or switches library.
 */

import './stats.css';

import { type CSSProperties, useRef, useState } from 'react';
import type { AppController } from '../app/useAppController.ts';
import {
  TOKENTRAIL_RELEASES,
  useTokenTrailLink,
} from '../features/integrations/TokenTrailPanel.tsx';
import { Island } from './Island.tsx';
import { Icon } from './icons.tsx';
import { initialAuraStyle, useAura } from './useAura.ts';

export function Stats({ controller }: { controller: AppController }) {
  const { url, error, open } = useTokenTrailLink(controller.selected ?? null);
  const rootRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLDivElement>(null);
  useAura(rootRef, washRef, null, null, 'stats');
  const [firstAura] = useState(() => initialAuraStyle(null, null));
  const backLabel = controller.active ? 'Back to chat' : 'Home';

  return (
    <div
      ref={rootRef}
      className="wc3 w3-studio w3-stats"
      data-overlay-root
      style={firstAura as CSSProperties}
    >
      <div className="w3-aura" aria-hidden="true" />
      <div className="w3-wash" ref={washRef} aria-hidden="true" />

      <header className="w3-studio__top">
        <div className="w3-studio__side">
          <button type="button" className="w3-st-topbtn" onClick={controller.exitStats}>
            <Icon name="chevronLeft" size="sm" />
            {backLabel}
          </button>
        </div>
        <div className="w3-studio__side w3-studio__side--right" />
      </header>

      <Island
        mode="rest"
        generating={false}
        onCollapse={() => {}}
        notice={null}
        onDismissNotice={() => {}}
        wingsPinned={false}
        wingLeft={null}
        wingRight={null}
        panes={{
          rest: (
            <span className="w3-st-mark">
              <Icon name="stats" size="sm" />
              Stats
            </span>
          ),
        }}
      />

      <div className="w3-studio__body">
        <main className="w3-stats__page">
          <p className="w3-stats__kicker">The Wack ecosystem</p>
          <h1 className="w3-stats__title">
            Your stats live in <span>TokenTrail</span>
          </h1>
          <p className="w3-stats__lede">
            Characters, conversations, models and the generations behind your stories, together with
            WackCode and your other AI tools. Everything stays on this computer, and TokenTrail can
            read your library even when WackChatter is closed.
          </p>
          {error ? (
            <p className="w3-stats__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="w3-stats__acts">
            {url ? (
              <a className="w3-stats__open" href={url}>
                Open TokenTrail
                <Icon name="forward" size="sm" />
              </a>
            ) : null}
            <button type="button" className="w3-st-ghost" onClick={open}>
              <Icon name="refresh" size="sm" />
              Retry
            </button>
            <a className="w3-st-ghost" href={TOKENTRAIL_RELEASES} target="_blank" rel="noreferrer">
              <Icon name="download" size="sm" />
              Get TokenTrail
            </a>
          </div>
          <p className="w3-stats__note">
            Accept your browser’s open-app prompt. If nothing opens, install or update TokenTrail,
            then retry.
          </p>
        </main>
      </div>
    </div>
  );
}
