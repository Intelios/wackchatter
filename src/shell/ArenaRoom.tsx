/**
 * The Benchmark: one room for both ways of comparing models.
 *
 * Blind (the default) draws a character, a cue and two models, hides who is who, and scores
 * your vote; it is the only thing the leaderboard hears from. With Blind off you pick the
 * character, the cue and two to four models yourself, see every name, and nothing is scored.
 * The room does not scroll as a page: the replies scroll inside their halves, so the seam
 * and the keys never leave the screen.
 */

import type { Verdict } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import { type ReactNode, useState, useSyncExternalStore } from 'react';
import { Popover } from '../components/Popover.tsx';
import { viewSeries } from '../features/arena/series.ts';
import { isRunSettled, type RunEntry } from '../features/arena/state/arenaReducer.ts';
import type { ArenaController } from '../features/arena/useArena.ts';
import { Markdown } from '../features/chat/Markdown.tsx';
import type { StreamStore } from '../features/chat/state/streamStore.ts';
import { characterApi } from '../lib/api.ts';
import { Duel, entryCost, type SideReveal, useDuelKeys } from './ArenaDuel.tsx';
import { formatSeconds, type PriceOf, wordCount } from './arenaStats.ts';
import { Switch } from './controls.tsx';
import { Icon } from './icons.tsx';
import { formatUsd } from './presetcc.ts';

function cardName(characters: readonly CharacterSummary[], id: string): string {
  return characters.find((c) => c.avatar === id)?.name ?? id.replace(/\.png$/i, '');
}

/** A cue with its *actions* set apart from its speech, the way the chat reads them. */
export function Cue({ text }: { text: string }) {
  const parts = text.split(/(\*[^*]+\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('*') && part.endsWith('*') ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional
          <em key={i}>{part.slice(1, -1)}</em>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function ArenaRoom({
  arena,
  blind,
  onBlind,
  characters,
  nameOf,
  colourOf,
  priceOf,
  onOpenPool,
  onOpenSetup,
}: {
  arena: ArenaController;
  blind: boolean;
  onBlind: (on: boolean) => void;
  characters: readonly CharacterSummary[];
  nameOf: (id: string) => string;
  colourOf: (id: string) => string;
  priceOf: PriceOf;
  onOpenPool: () => void;
  /** The Setup page: cards, cues and the rest of what rounds draw from. */
  onOpenSetup: () => void;
}) {
  const setupButton = (
    <button type="button" className="w3-st-ghost w3-st-ghost--sm" onClick={onOpenSetup}>
      <Icon name="sliders" size="sm" />
      Setup
    </button>
  );

  const blindSwitch = (
    <span
      className="w3-ar-blind"
      title={blind ? 'Who wrote what stays hidden until you vote' : 'Names show; nothing is scored'}
    >
      <Switch
        on={blind}
        label="Blind"
        onChange={onBlind}
        disabled={arena.blindRun.busy || arena.benchRun.busy}
      />
      Blind
      <small>{blind ? 'scored' : 'labelled, not scored'}</small>
    </span>
  );

  return blind ? (
    <BlindRoom
      arena={arena}
      characters={characters}
      nameOf={nameOf}
      colourOf={colourOf}
      priceOf={priceOf}
      controls={
        <>
          {blindSwitch}
          {setupButton}
        </>
      }
      onOpenPool={onOpenPool}
      onOpenSetup={onOpenSetup}
    />
  ) : (
    <LabelledRoom
      arena={arena}
      characters={characters}
      nameOf={nameOf}
      colourOf={colourOf}
      priceOf={priceOf}
      controls={
        <>
          {blindSwitch}
          {setupButton}
        </>
      }
    />
  );
}

// ---------- Blind ----------

function BlindRoom({
  arena,
  characters,
  nameOf,
  priceOf,
  controls,
  onOpenPool,
  onOpenSetup,
}: {
  arena: ArenaController;
  characters: readonly CharacterSummary[];
  nameOf: (id: string) => string;
  colourOf: (id: string) => string;
  priceOf: PriceOf;
  controls: ReactNode;
  onOpenPool: () => void;
  onOpenSetup: () => void;
}) {
  const run = arena.blindRun;
  const current = run.state.runs[0] ?? null;
  const pending = arena.pendingRun?.target === 'blind';
  const settled = current ? isRunSettled(current) : false;
  const bothDone = current?.entries.every((e) => e.status === 'done') ?? false;
  const canVote = Boolean(current) && settled && bothDone && !arena.revealed;
  const canNext = !arena.blindReason && !pending && !run.busy && (!current || arena.revealed);

  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const vote = (v: Verdict) => {
    if (!canVote) return;
    setVerdict(v);
    arena.vote(v);
  };
  const next = () => {
    if (!canNext) return;
    setVerdict(null);
    arena.nextRound();
  };
  useDuelKeys({
    canVote,
    ties: true,
    onVote: vote,
    canNext,
    onNext: next,
    busy: run.busy,
    onStop: run.abort,
  });

  const draw = arena.draw;
  const colours = draw ? viewSeries([draw.left.id, draw.right.id], arena.preferredSlots) : null;
  const reveals: [SideReveal, SideReveal] | null =
    arena.revealed && current && draw
      ? (([0, 1] as const).map((index) => {
          const entry = current.entries[index]!;
          const move = arena.preview
            ? index === 0
              ? arena.preview.left
              : arena.preview.right
            : null;
          const id = index === 0 ? draw.left.id : draw.right.id;
          return {
            name: nameOf(id),
            sub: entry.model,
            before: move ? move.before : null,
            after: move ? move.after : null,
            colour: colours?.get(id),
          };
        }) as [SideReveal, SideReveal])
      : null;

  const roundNo = arena.sessionVerdicts.length + (arena.revealed ? 0 : 1);

  return (
    <div className="w3-ar-room">
      <div className="w3-ar-scene">
        {current ? (
          <>
            <img
              className="w3-ar-scene__face"
              src={characterApi.imageUrl(current.characterId)}
              alt=""
            />
            <div className="w3-ar-scene__cue">
              <small>
                {cardName(characters, current.characterId)} · round {roundNo} this visit
              </small>
              <p title={current.probe}>
                <Cue
                  text={current.probe.replace(
                    /\{\{char\}\}/gi,
                    cardName(characters, current.characterId),
                  )}
                />
              </p>
            </div>
          </>
        ) : (
          <div className="w3-ar-scene__cue">
            <small>Blind benchmark</small>
            <p>A character, a cue and two models, drawn for you. Sides are a coin flip.</p>
          </div>
        )}
        {controls}
      </div>

      {run.error ? <p className="w3-ar-problem">{run.error}</p> : null}
      {arena.recordError ? <p className="w3-ar-problem">{arena.recordError}</p> : null}

      {current ? (
        <Duel
          entries={current.entries}
          streams={run.streams}
          display={arena.displayFor(current.characterId)}
          masked={!arena.revealed}
          hold={arena.settings.holdBlindUntilComplete}
          canVote={canVote}
          verdict={arena.revealed ? verdict : null}
          reveals={reveals}
          priceOf={priceOf}
          onVote={arena.revealed ? null : vote}
          onRetry={(id) => void run.rerollColumn(current.id, id)}
        />
      ) : (
        <div className="w3-ar-start">
          {arena.blindReason ? (
            <Blocked reason={arena.blindReason} onOpenPool={onOpenPool} onOpenSetup={onOpenSetup} />
          ) : (
            <>
              <h2>Ready when you are</h2>
              <p>Pick the reply you would keep. Names, speed and cost show after you vote.</p>
              <button
                type="button"
                className="w3-st-pill w3-ar-big"
                disabled={!canNext}
                onClick={next}
              >
                {pending ? 'Loading the card…' : 'Start a round'}
                <kbd className="w3-kbd">↵</kbd>
              </button>
            </>
          )}
        </div>
      )}

      <footer className="w3-ar-foot">
        {current && arena.revealed ? (
          <>
            <span className="w3-ar-faint">
              {arena.recording ? 'Recording…' : arena.recordError ? '' : 'Recorded.'}
            </span>
            <button
              type="button"
              className="w3-st-pill w3-ar-big"
              disabled={!canNext}
              onClick={next}
            >
              {pending ? 'Loading…' : 'Next round'}
              <kbd className="w3-kbd">↵</kbd>
            </button>
          </>
        ) : current && run.busy ? (
          <button type="button" className="w3-st-ghost" onClick={run.abort}>
            <Icon name="stop" size="sm" />
            Stop <kbd className="w3-kbd">Esc</kbd>
          </button>
        ) : current ? (
          <span className="w3-ar-keys">
            <span>
              <kbd className="w3-kbd">1</kbd> A
            </span>
            <span>
              <kbd className="w3-kbd">2</kbd> B
            </span>
            <span>
              <kbd className="w3-kbd">3</kbd> Tie
            </span>
            <span>
              <kbd className="w3-kbd">4</kbd> Both bad
            </span>
            {settled && !bothDone ? (
              <span>A reply failed. Try it again, or draw the next round.</span>
            ) : null}
            {settled && !bothDone ? (
              <button
                type="button"
                className="w3-st-ghost w3-st-ghost--sm"
                onClick={() => arena.nextRound()}
              >
                Skip this round
              </button>
            ) : null}
          </span>
        ) : null}
      </footer>
    </div>
  );
}

/**
 * Why no round can be drawn, said where 3.0 keeps the fix: models are in the pool on the
 * island, characters and cues in Setup. The reasons come from the engine (`useArena`).
 */
function Blocked({
  reason,
  onOpenPool,
  onOpenSetup,
}: {
  reason: string;
  onOpenPool: () => void;
  onOpenSetup: () => void;
}) {
  const cards = /no cards/i.test(reason);
  const cuesOff = /switched off/i.test(reason);
  const cues = /no probes/i.test(reason) || cuesOff;
  const models = /contender/i.test(reason);
  const text = cards
    ? 'No characters to draw from.'
    : cuesOff
      ? 'Every cue is switched off.'
      : cues
        ? 'No cues yet. A cue is the line both models answer.'
        : models
          ? 'Switch on at least two models in the pool.'
          : reason;
  return (
    <>
      <p>{text}</p>
      {cards || cues ? (
        <button type="button" className="w3-st-ghost" onClick={onOpenSetup}>
          {cards
            ? 'Pick characters in Setup'
            : cuesOff
              ? 'Switch one on in Setup'
              : 'Add a cue in Setup'}
        </button>
      ) : models ? (
        <button type="button" className="w3-st-ghost" onClick={onOpenPool}>
          Open the pool
        </button>
      ) : null}
    </>
  );
}

// ---------- Labelled ----------

function LabelledRoom({
  arena,
  characters,
  nameOf,
  colourOf,
  priceOf,
  controls,
}: {
  arena: ArenaController;
  characters: readonly CharacterSummary[];
  nameOf: (id: string) => string;
  colourOf: (id: string) => string;
  priceOf: PriceOf;
  controls: ReactNode;
}) {
  const run = arena.benchRun;
  const runs = run.state.runs;
  const [at, setAt] = useState<number | null>(null);
  const shownIndex = at === null ? runs.length - 1 : Math.min(at, runs.length - 1);
  const shown = runs[shownIndex] ?? null;

  const runnable = arena.resolved.filter((r) => r.connection);
  const [picked, setPicked] = useState<string[]>(() =>
    runnable
      .filter((r) => r.contender.enabled)
      .slice(0, 2)
      .map((r) => r.contender.id),
  );
  const [cue, setCue] = useState(() => arena.settings.probes[0]?.text ?? '');
  const characterId = arena.benchCharacterId;

  const reason =
    arena.setupReason ??
    arena.benchReadyReason ??
    (picked.length < 2 ? 'Pick at least two models.' : !cue.trim() ? 'Write a cue.' : null);
  const go = () => {
    if (reason || run.busy || !characterId) return;
    arena.startBench(cue.trim(), picked, characterId);
    setAt(null);
  };

  return (
    <div className="w3-ar-room">
      <div className="w3-ar-scene w3-ar-scene--pick">
        <CardPicker
          characters={characters}
          value={characterId}
          onPick={(avatar) => {
            arena.setBenchCharacterId(avatar);
            arena.setStagedId(avatar);
          }}
        />
        <input
          className="w3-ar-cuefield"
          value={cue}
          placeholder="Write the cue they both answer, e.g. *I say nothing, and wait.*"
          aria-label="Cue"
          onChange={(event) => setCue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') go();
          }}
        />
        {controls}
      </div>

      <div className="w3-ar-pickrow">
        {runnable.map(({ contender }) => {
          const on = picked.includes(contender.id);
          return (
            <button
              key={contender.id}
              type="button"
              className="w3-ar-chip"
              aria-pressed={on}
              disabled={!on && picked.length >= 4}
              title={!on && picked.length >= 4 ? 'Four at a time at most' : undefined}
              onClick={() =>
                setPicked(
                  on ? picked.filter((id) => id !== contender.id) : [...picked, contender.id],
                )
              }
            >
              <i style={{ background: colourOf(contender.id) }} aria-hidden="true" />
              {nameOf(contender.id)}
            </button>
          );
        })}
        <span className="w3-ar-gap" />
        {runs.length > 1 ? (
          <span className="w3-ar-pager">
            <button
              type="button"
              aria-label="Earlier run"
              disabled={shownIndex <= 0}
              onClick={() => setAt(shownIndex - 1)}
            >
              <Icon name="chevronLeft" size="sm" />
            </button>
            Run {shownIndex + 1} of {runs.length}
            <button
              type="button"
              aria-label="Later run"
              disabled={shownIndex >= runs.length - 1}
              onClick={() => setAt(shownIndex + 1)}
            >
              <Icon name="chevronRight" size="sm" />
            </button>
          </span>
        ) : null}
        {run.busy ? (
          <button type="button" className="w3-st-ghost w3-st-ghost--sm" onClick={run.abort}>
            <Icon name="stop" size="sm" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="w3-st-pill w3-co-pill"
            disabled={Boolean(reason)}
            title={reason ?? 'Run the cue on every picked model'}
            onClick={go}
          >
            <Icon name="forward" size="sm" />
            Run
          </button>
        )}
      </div>

      {run.error ? <p className="w3-ar-problem">{run.error}</p> : null}

      {shown ? (
        <div className="w3-ar-cols" style={{ ['--n' as string]: shown.entries.length }}>
          {shown.entries.map((entry, index) => (
            <Column
              key={entry.contenderId}
              entry={entry}
              stream={shownIndex === runs.length - 1 ? (run.streams[index] ?? null) : null}
              name={nameOf(entry.contenderId)}
              colour={colourOf(entry.contenderId)}
              display={arena.displayFor(shown.characterId)}
              priceOf={priceOf}
              onRetry={run.busy ? null : () => void run.rerollColumn(shown.id, entry.contenderId)}
            />
          ))}
        </div>
      ) : (
        <div className="w3-ar-start">
          <h2>Side by side, names showing</h2>
          <p>
            Pick a character and the models, write a cue, and run it. Nothing here is scored: only
            blind rounds move the leaderboard.
          </p>
        </div>
      )}
    </div>
  );
}

function Column({
  entry,
  stream,
  name,
  colour,
  display,
  priceOf,
  onRetry,
}: {
  entry: RunEntry;
  stream: StreamStore | null;
  name: string;
  colour: string;
  display: ReturnType<ArenaController['displayFor']>;
  priceOf: PriceOf;
  onRetry: (() => void) | null;
}) {
  const cost = entryCost(entry, priceOf);
  return (
    <div className="w3-ar-col" style={{ ['--w3-ar-c' as string]: colour }}>
      <header className="w3-ar-col__head">
        <b>{name}</b>
        <small>
          {entry.status === 'done'
            ? [
                `${wordCount(entry.text)} words`,
                entry.elapsedMs !== null ? formatSeconds(entry.elapsedMs) : null,
                cost !== null ? formatUsd(cost) : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : entry.status === 'failed'
              ? 'Failed'
              : entry.status === 'aborted'
                ? 'Stopped'
                : 'Writing…'}
        </small>
        {onRetry && entry.status !== 'pending' && entry.status !== 'streaming' ? (
          <button
            type="button"
            className="w3-ar-iconbtn"
            title="Run this one again"
            onClick={onRetry}
          >
            <Icon name="refresh" size="sm" />
          </button>
        ) : null}
      </header>
      <div className="w3-ar-prose">
        {entry.status === 'streaming' && stream ? (
          <LiveText stream={stream} display={display} />
        ) : entry.text ? (
          <Markdown text={display.output(entry.text)} className="w3-ar-md" />
        ) : null}
        {entry.status === 'failed' ? <p className="w3-ar-failed">{entry.error}</p> : null}
      </div>
    </div>
  );
}

function LiveText({
  stream,
  display,
}: {
  stream: StreamStore;
  display: ReturnType<ArenaController['displayFor']>;
}) {
  const snapshot = useSyncExternalStore(stream.subscribe, stream.getSnapshot);
  return <Markdown text={display.output(snapshot.text)} className="w3-ar-md" />;
}

// ---------- Picking a character ----------

export function CardPicker({
  characters,
  value,
  onPick,
  placeholder = 'Pick a character',
}: {
  characters: readonly CharacterSummary[];
  value: string | null;
  onPick: (avatar: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const list = characters.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Popover
      label={placeholder}
      icon={null}
      open={open}
      onOpenChange={setOpen}
      placement="bottom-start"
      role="dialog"
      popupClassName="w3-ar-cardpop"
      renderTrigger={(trigger) => (
        <button {...trigger} type="button" className="w3-ar-cardbtn" onClick={() => setOpen(!open)}>
          {value ? (
            <img className="w3-ar-scene__face" src={characterApi.imageUrl(value)} alt="" />
          ) : (
            <span className="w3-ar-scene__face w3-ar-scene__face--empty">
              <Icon name="users" size="sm" />
            </span>
          )}
          <span>{value ? cardName(characters, value) : placeholder}</span>
          <Icon name="chevronDown" size="xs" />
        </button>
      )}
    >
      <div className="w3-ar-cardpop__body">
        <input
          value={query}
          placeholder="Find a character"
          aria-label="Find a character"
          // biome-ignore lint/a11y/noAutofocus: the field is the popover's purpose
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="w3-ar-cardpop__list">
          {list.slice(0, 80).map((c) => (
            <button
              key={c.avatar}
              type="button"
              aria-pressed={c.avatar === value}
              onClick={() => {
                onPick(c.avatar);
                setOpen(false);
              }}
            >
              <img src={characterApi.imageUrl(c.avatar)} alt="" />
              {c.name}
            </button>
          ))}
          {list.length === 0 ? <p className="w3-ar-faint">No character by that name.</p> : null}
        </div>
      </div>
    </Popover>
  );
}
