/**
 * The preset, between the Co-Creator and the bench: what's sent, top to bottom, lit where
 * the last edit changed it. Dots above step through its revisions (two clicks put an old
 * one back), and Compare with… marks it against your saved copy, a revision or a reference.
 */

import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type {
  PresetCocreatorSession,
  PresetComparisonSource,
  ReferencePresetSummary,
} from '@shared/types/preset-cocreator.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Popover } from '../components/Popover.tsx';
import {
  comparisonChoices,
  loadComparisonPreset,
} from '../features/preset-cocreator/compareSources.ts';
import { encodeSource } from '../features/preset-cocreator/presetCompare.ts';
import { useTokenizer } from '../lib/useTokenizer.ts';
import { useArm } from './controls.tsx';
import { Icon } from './icons.tsx';
import { type CompareLens, compareLens, litPrompts, railRows } from './presetcc.ts';
import { kTokens } from './studio.ts';

export type PromptSheet = { kind: 'prompt'; identifier: string } | { kind: 'json' };

type Lens = { source: PresetComparisonSource; label: string };

export function PresetRail({
  session,
  viewing,
  onView,
  busy,
  onRestore,
  lens,
  onLens,
  presets,
  references,
  onAddReference,
  onAsk,
  askBlocked,
  onOpen,
  onFail,
  tokenizerModel,
  tokenizerEncoding,
}: {
  session: PresetCocreatorSession;
  viewing: number;
  onView: (revision: number) => void;
  busy: boolean;
  onRestore: (revision: number) => void;
  lens: Lens | null;
  onLens: (lens: Lens | null) => void;
  presets: readonly PresetSummary[];
  references: readonly ReferencePresetSummary[];
  onAddReference: (file: File) => Promise<ReferencePresetSummary>;
  onAsk: (source: PresetComparisonSource, label: string) => void;
  askBlocked: string | null;
  onOpen: (sheet: PromptSheet) => void;
  onFail: (err: unknown) => void;
  tokenizerModel: string;
  tokenizerEncoding?: string;
}) {
  const history = useMemo(
    () => [...session.history].sort((a, b) => a.revision - b.revision),
    [session.history],
  );
  const draftRevision = session.draftRevision;
  const shown = history.find((entry) => entry.revision === viewing) ?? session.current;
  const preset = shown.preset;
  const current = viewing === draftRevision;
  const rows = useMemo(() => railRows(preset), [preset]);
  const lit = useMemo(() => litPrompts(history, viewing), [history, viewing]);
  const counter = useTokenizer(tokenizerModel, tokenizerEncoding);
  const counts = useMemo(
    () =>
      new Map(
        rows.map((row) => [row.identifier, row.marker ? null : counter.countText(row.content)]),
      ),
    [rows, counter],
  );
  const arm = useArm();

  // --- The lens: the other preset, loaded when chosen ---
  const [other, setOther] = useState<Preset | null>(null);
  useEffect(() => {
    setOther(null);
    if (!lens) return;
    let cancelled = false;
    void loadComparisonPreset(lens.source, session.history)
      .then((loaded) => {
        if (!cancelled) setOther(loaded);
      })
      .catch((err) => {
        if (cancelled) return;
        onLens(null);
        onFail(err);
      });
    return () => {
      cancelled = true;
    };
  }, [lens, session.history, onLens, onFail]);
  const marks: CompareLens | null = useMemo(
    () => (lens && other ? compareLens(preset, other) : null),
    [lens, other, preset],
  );

  const [lensOpen, setLensOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const choices = useMemo(
    () => comparisonChoices(references, presets, history, draftRevision),
    [references, presets, history, draftRevision],
  );
  const target = session.targetPresetId;
  const choose = (next: Lens) => {
    onLens(next);
    setLensOpen(false);
  };
  const savedLabel = target
    ? `${presets.find((p) => p.id === target)?.name ?? target.replace(/\.json$/i, '')} as saved`
    : null;

  const who = (source: string) =>
    source === 'assistant' ? 'ai' : source === 'initial' ? 'start' : 'you';
  const caption = shown.summary || (shown.source === 'initial' ? 'Where the session started' : '');

  const temperature = typeof preset.temperature === 'number' ? preset.temperature : null;
  const topP = typeof preset.top_p === 'number' ? preset.top_p : null;
  const context = typeof preset.openai_max_context === 'number' ? preset.openai_max_context : null;
  const capped =
    preset.openai_max_tokens_unlimited === false && typeof preset.openai_max_tokens === 'number';

  return (
    <section className="w3-pc-col w3-pc-rail" aria-label="Preset">
      <div className="w3-pc-col__head">
        <h3>Preset</h3>
        <span className="w3-co-gap" />
        <button
          type="button"
          className="w3-pc-headbtn"
          disabled={!current || busy}
          title={current ? 'The whole preset as JSON' : 'Go back to the draft to edit'}
          onClick={() => onOpen({ kind: 'json' })}
        >
          JSON
        </button>
      </div>
      <div className="w3-pc-railbox">
        <div className="w3-pc-scrub">
          <div className="w3-pc-scrub__row" role="toolbar" aria-label="Revisions">
            {history.map((entry) => (
              <button
                key={entry.revision}
                type="button"
                aria-pressed={entry.revision === viewing}
                data-who={who(entry.source)}
                title={`Revision ${entry.revision}${entry.summary ? `: ${entry.summary}` : ''}`}
                onClick={() => onView(entry.revision)}
              >
                <i />
              </button>
            ))}
          </div>
          <div className="w3-pc-scrub__cap">
            <span>
              <b>Revision {shown.revision}</b>
              {caption ? ` · ${caption}` : ''}
            </span>
            {current ? null : (
              <span className="w3-pc-scrub__acts">
                <button type="button" className="w3-pc-link" onClick={() => onView(draftRevision)}>
                  Back to the draft
                </button>
                <button
                  type="button"
                  className="w3-pc-link"
                  data-armed={arm.armed === 'restore' || undefined}
                  disabled={busy}
                  title={
                    busy
                      ? 'Wait for the reply to finish'
                      : `Make revision ${shown.revision} the draft again`
                  }
                  onClick={() => arm.press('restore', () => onRestore(shown.revision))}
                  onBlur={arm.disarm}
                >
                  {arm.armed === 'restore' ? 'Restore? Click again' : 'Restore'}
                </button>
              </span>
            )}
          </div>
        </div>

        <div className="w3-pc-lens">
          <Popover
            label="Compare with"
            icon={null}
            open={lensOpen}
            onOpenChange={setLensOpen}
            placement="bottom-start"
            role="listbox"
            popupClassName="w3-pc-lenspop"
            renderTrigger={(trigger) => (
              <button
                {...trigger}
                type="button"
                className="w3-pc-lens__btn"
                data-on={lens ? true : undefined}
                onClick={() => setLensOpen(!lensOpen)}
              >
                <Icon name="lines" size="xs" />
                <span>{lens ? lens.label : 'Compare with…'}</span>
              </button>
            )}
          >
            <div className="w3-pc-lenspop__list">
              {target && savedLabel ? (
                <>
                  <p>Yours</p>
                  <button
                    type="button"
                    role="option"
                    aria-selected={lens?.source.kind === 'library' && lens.source.id === target}
                    onClick={() =>
                      choose({ source: { kind: 'library', id: target }, label: savedLabel })
                    }
                  >
                    <b>{savedLabel}</b>
                    <small>Your library copy</small>
                  </button>
                </>
              ) : null}
              {(['Session revisions', 'Reference presets', 'My presets'] as const).map((group) => {
                const members = choices.filter(
                  (choice) =>
                    choice.group === group &&
                    !(choice.source.kind === 'library' && choice.source.id === target),
                );
                if (!members.length) return null;
                return (
                  <div key={group}>
                    <p>
                      {group === 'Session revisions'
                        ? 'Earlier revisions'
                        : group === 'Reference presets'
                          ? 'References'
                          : 'Your other presets'}
                    </p>
                    {members.map((choice) => (
                      <button
                        key={choice.key}
                        type="button"
                        role="option"
                        aria-selected={lens ? encodeSource(lens.source) === choice.key : false}
                        onClick={() => choose({ source: choice.source, label: choice.label })}
                      >
                        <b>{choice.label}</b>
                        {choice.group === 'Session revisions' ? (
                          <small>{choice.detail}</small>
                        ) : null}
                      </button>
                    ))}
                  </div>
                );
              })}
              <button
                type="button"
                className="w3-pc-lenspop__add"
                onClick={() => fileRef.current?.click()}
              >
                <Icon name="plus" size="xs" />
                Add a JSON file…
              </button>
            </div>
          </Popover>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              void onAddReference(file)
                .then((added) =>
                  choose({ source: { kind: 'reference', id: added.id }, label: added.name }),
                )
                .catch(onFail);
            }}
          />
          {lens ? (
            <button
              type="button"
              className="w3-pc-x"
              aria-label="Stop comparing"
              onClick={() => onLens(null)}
            >
              <Icon name="close" size="xs" />
            </button>
          ) : null}
        </div>
        {lens ? (
          <div className="w3-pc-lensbar">
            <span>
              {marks
                ? marks.differences
                  ? `${marks.differences} ${marks.differences === 1 ? 'difference' : 'differences'}`
                  : 'The same'
                : 'Loading…'}
              {marks?.settings.length
                ? ` · settings: ${marks.settings.slice(0, 3).join(', ')}${marks.settings.length > 3 ? '…' : ''}`
                : ''}
            </span>
            <button
              type="button"
              className="w3-pc-link"
              disabled={Boolean(askBlocked)}
              title={askBlocked ?? 'Ask the Co-Creator what the differences do'}
              onClick={() => onAsk(lens.source, lens.label)}
            >
              Ask the Co-Creator
            </button>
          </div>
        ) : null}

        <div className="w3-pc-rows">
          {rows.map((row) => {
            const mark = marks?.marks.get(row.identifier) ?? null;
            const count = counts.get(row.identifier);
            return (
              <button
                key={row.identifier}
                type="button"
                className="w3-pc-prow"
                data-lit={!lens && lit.has(row.identifier) ? true : undefined}
                data-off={row.enabled ? undefined : true}
                data-marker={row.marker || undefined}
                data-cmp={mark ?? undefined}
                disabled={!current || busy || row.marker}
                title={
                  row.marker
                    ? 'Filled in by the app when a reply is written'
                    : !current
                      ? 'Go back to the draft to edit'
                      : `${row.enabled ? '' : 'Switched off. '}Open ${row.name}`
                }
                onClick={() => onOpen({ kind: 'prompt', identifier: row.identifier })}
              >
                <span className="w3-pc-prow__m" />
                <b>{row.name}</b>
                {mark ? (
                  <span className="w3-pc-prow__cmp">
                    {mark === 'changed' ? '~' : mark === 'only-here' ? '+' : ''}
                  </span>
                ) : (
                  <span className="w3-pc-prow__k">{count ? kTokens(count) : ''}</span>
                )}
              </button>
            );
          })}
          {marks?.onlyThere.map((row) => (
            <span
              key={row.identifier}
              className="w3-pc-prow"
              data-cmp="only-there"
              title={`Only in ${lens?.label}`}
            >
              <span className="w3-pc-prow__m" />
              <b>{row.name}</b>
              <span className="w3-pc-prow__cmp">−</span>
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="w3-pc-samplers"
        disabled={!current || busy}
        title="Samplers and the rest, in the preset's JSON"
        onClick={() => onOpen({ kind: 'json' })}
      >
        {temperature !== null ? (
          <span>
            Temp <b>{temperature}</b>
          </span>
        ) : null}
        {topP !== null ? (
          <span>
            Top P <b>{topP}</b>
          </span>
        ) : null}
        {context !== null ? (
          <span>
            Context <b>{kTokens(context)}</b>
          </span>
        ) : null}
        <span>
          Reply <b>{capped ? kTokens(preset.openai_max_tokens as number) : 'no cap'}</b>
        </span>
      </button>
    </section>
  );
}
