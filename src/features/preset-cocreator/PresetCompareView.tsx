import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type {
  PresetDraftRevision,
  ReferencePresetSummary,
} from '@shared/types/preset-cocreator.ts';
import { memo, useEffect, useId, useMemo, useState } from 'react';
import { Select, type SelectChoice } from '../../components/Select.tsx';
import { presetApi, referencePresetApi } from '../../lib/api.ts';
import { DiffParts } from './PresetChanges.tsx';
import { formatValue } from './presetChanges.ts';
import {
  buildSideBySide,
  type CompareSource,
  type CompareStatus,
  decodeSource,
  encodeSource,
  type PromptRow,
  type PromptSide,
  type SettingRow,
  splitSides,
} from './presetCompare.ts';
import { type DiffPart, diffText } from './textDiff.ts';

export interface CompareSources {
  left: CompareSource;
  right: CompareSource;
}

interface PresetCompareViewProps {
  current: PresetDraftRevision;
  history: readonly PresetDraftRevision[];
  targetPresetId: string | null;
  /** Changes when the linked library preset is published to, so its side reloads. */
  targetPresetVersion: string | null;
  presets: readonly PresetSummary[];
  references: readonly ReferencePresetSummary[];
  sources: CompareSources;
  onSourcesChange: (sources: CompareSources) => void;
}

type Loaded = { preset: Preset | null; loading: boolean; error: string };

/**
 * One side's preset. The draft and its revisions are already in the session; library and
 * reference presets load on pick, and are not cached — a library preset can change under
 * the tab (publishing does exactly that), and a stale copy would compare the wrong text.
 */
function useSourcePreset(
  source: CompareSource,
  current: PresetDraftRevision,
  history: readonly PresetDraftRevision[],
  reloadKey: string | null,
): Loaded {
  const remoteKey =
    source.kind === 'library' || source.kind === 'reference' ? encodeSource(source) : null;
  const [remote, setRemote] = useState<{ key: string; preset?: Preset; error?: string } | null>(
    null,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the re-fetch trigger
  useEffect(() => {
    const decoded = remoteKey ? decodeSource(remoteKey) : null;
    if (!remoteKey || !decoded || (decoded.kind !== 'library' && decoded.kind !== 'reference')) {
      return;
    }
    let cancelled = false;
    setRemote({ key: remoteKey });
    const load =
      decoded.kind === 'library'
        ? presetApi.get(decoded.id)
        : referencePresetApi.get(decoded.id).then((record) => record.preset);
    load
      .then((preset) => {
        if (!cancelled) setRemote({ key: remoteKey, preset });
      })
      .catch((failure) => {
        if (!cancelled) setRemote({ key: remoteKey, error: (failure as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [remoteKey, reloadKey]);

  if (source.kind === 'draft') return { preset: current.preset, loading: false, error: '' };
  if (source.kind === 'revision') {
    const found = history.find((revision) => revision.revision === source.revision);
    return found
      ? { preset: found.preset, loading: false, error: '' }
      : {
          preset: null,
          loading: false,
          error: `Revision ${source.revision} is not in this session.`,
        };
  }
  if (!remote || remote.key !== remoteKey) return { preset: null, loading: true, error: '' };
  return {
    preset: remote.preset ?? null,
    loading: !remote.preset && !remote.error,
    error: remote.error ?? '',
  };
}

const STATUS_LABEL: Record<CompareStatus, string> = {
  same: 'unchanged',
  changed: 'changed',
  added: 'only in new',
  removed: 'only in old',
};

function Missing() {
  return <div className="preset-cc-compare__missing">Not in this preset</div>;
}

function enabledLabel(enabled: boolean | null): string {
  return enabled === null ? 'not in the order' : enabled ? 'on' : 'off';
}

/** The two text columns of a row: a split word diff when both sides have text. */
function TextColumns({
  left,
  right,
  status,
}: {
  left: string | null;
  right: string | null;
  status: CompareStatus;
}) {
  const sides = useMemo((): { left: DiffPart[]; right: DiffPart[] } | null => {
    // Identical text (a row that changed only its switch or placement) has nothing to diff.
    if (left === null || right === null || left === right) return null;
    return splitSides(diffText(left, right));
  }, [left, right]);

  const column = (
    text: string | null,
    parts: DiffPart[] | undefined,
    kind: 'removed' | 'added',
  ) => {
    if (text === null) return <Missing />;
    if (!text) return <div className="preset-cc-compare__empty">(empty)</div>;
    // Folding is for context around a change. Text with no change in it is shown whole,
    // and a side the other lacks is wholly its change.
    const whole = status === 'added' || status === 'removed';
    return (
      <div className="preset-cc-diff preset-cc-compare__text">
        {parts ? (
          <DiffParts parts={parts} />
        ) : whole ? (
          <DiffParts parts={[{ kind, text }]} />
        ) : (
          text
        )}
      </div>
    );
  };

  return (
    <>
      {column(left, sides?.left, 'removed')}
      {column(right, sides?.right, 'added')}
    </>
  );
}

function PromptMeta({ side, other }: { side: PromptSide | null; other: PromptSide | null }) {
  if (!side) return <span />;
  const differs = Boolean(other) && (other!.enabled !== side.enabled || other!.meta !== side.meta);
  return (
    <span className="preset-cc-compare__meta" data-differs={differs || undefined}>
      {enabledLabel(side.enabled)} · {side.meta}
    </span>
  );
}

const PromptCompareRow = memo(function PromptCompareRow({ row }: { row: PromptRow }) {
  const marker = Boolean(row.left?.marker || row.right?.marker);
  const body = (
    <div className="preset-cc-compare__grid">
      <PromptMeta side={row.left} other={row.right} />
      <PromptMeta side={row.right} other={row.left} />
      {marker ? (
        <p className="wc-hint preset-cc-compare__span">
          A marker — the app fills it in when the prompt is assembled, so it has no text here.
        </p>
      ) : (
        <TextColumns
          left={row.left ? row.left.content : null}
          right={row.right ? row.right.content : null}
          status={row.status}
        />
      )}
    </div>
  );
  return <CompareRowShell label={row.label} status={row.status} body={body} />;
});

const SettingCompareRow = memo(function SettingCompareRow({ row }: { row: SettingRow }) {
  if (row.kind === 'value') {
    const cell = (value: unknown, present: boolean, kind: 'removed' | 'added') => {
      if (!present) return <Missing />;
      const Tag = row.status === 'same' ? 'span' : kind === 'removed' ? 'del' : 'ins';
      return (
        <div className="preset-cc-compare__value">
          <Tag>{formatValue(value)}</Tag>
        </div>
      );
    };
    return (
      <article
        className="preset-cc-compare__row preset-cc-compare__row--value"
        data-status={row.status}
      >
        <span className="preset-cc-compare__label">{row.label}</span>
        {cell(row.left, row.status !== 'added', 'removed')}
        {cell(row.right, row.status !== 'removed', 'added')}
      </article>
    );
  }
  const body = (
    <div className="preset-cc-compare__grid">
      <TextColumns left={row.left} right={row.right} status={row.status} />
    </div>
  );
  return <CompareRowShell label={row.label} status={row.status} body={body} />;
});

/** An unchanged row collapses to its name; anything else is open. */
function CompareRowShell({
  label,
  status,
  body,
}: {
  label: string;
  status: CompareStatus;
  body: React.ReactNode;
}) {
  const [open, setOpen] = useState(status !== 'same');
  return (
    <details
      className="preset-cc-compare__row"
      data-status={status}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="preset-cc-compare__label">{label}</span>
        <span className="preset-cc-compare__status">{STATUS_LABEL[status]}</span>
      </summary>
      {open ? body : null}
    </details>
  );
}

/**
 * Any two presets, side by side: old on the left, new on the right. Memoised on narrow
 * props — the tab stays mounted behind the others while replies stream.
 */
export const PresetCompareView = memo(function PresetCompareView({
  current,
  history,
  targetPresetId,
  targetPresetVersion,
  presets,
  references,
  sources,
  onSourcesChange,
}: PresetCompareViewProps) {
  const fieldId = useId();
  const [onlyDifferences, setOnlyDifferences] = useState(true);
  const left = useSourcePreset(sources.left, current, history, targetPresetVersion);
  const right = useSourcePreset(sources.right, current, history, targetPresetVersion);
  const view = useMemo(
    () => (left.preset && right.preset ? buildSideBySide(left.preset, right.preset) : null),
    [left.preset, right.preset],
  );

  const options = useMemo((): SelectChoice<string>[] => {
    const revisions = [...history].reverse().map((revision) => ({
      value: encodeSource({ kind: 'revision', revision: revision.revision }),
      label: `Revision ${revision.revision}${revision.revision === current.revision ? ' (current)' : ''}`,
      description: revision.summary || revision.source,
    }));
    return [
      { value: 'draft', label: 'Current draft', description: `Revision ${current.revision}` },
      ...revisions,
      ...presets.map((preset) => ({
        value: encodeSource({ kind: 'library', id: preset.id }),
        label: preset.name,
        description:
          preset.id === targetPresetId ? 'My preset · this session saves here' : 'My preset',
      })),
      ...references.map((reference) => ({
        value: encodeSource({ kind: 'reference', id: reference.id }),
        label: reference.name,
        description: 'Reference preset',
      })),
    ];
  }, [history, current.revision, presets, references, targetPresetId]);

  const pick = (side: 'left' | 'right') => (value: string) => {
    const decoded = decodeSource(value);
    if (decoded) onSourcesChange({ ...sources, [side]: decoded });
  };
  const sameSource = encodeSource(sources.left) === encodeSource(sources.right);
  const visible = <T extends { status: CompareStatus }>(rows: readonly T[]) =>
    onlyDifferences ? rows.filter((row) => row.status !== 'same') : rows;
  const prompts = view ? visible(view.prompts) : [];
  const settings = view ? visible(view.settings) : [];
  const error = left.error || right.error;

  return (
    <div className="preset-cc-compare">
      <div className="preset-cc-compare__pickers">
        <div className="field">
          <label className="wc-label" htmlFor={`${fieldId}-old`}>
            Old
          </label>
          <Select
            id={`${fieldId}-old`}
            label="Old preset"
            value={encodeSource(sources.left)}
            options={options}
            onChange={pick('left')}
          />
        </div>
        <button
          type="button"
          className="wc-button wc-button--ghost preset-cc-compare__swap"
          title="Swap old and new"
          aria-label="Swap old and new"
          onClick={() => onSourcesChange({ left: sources.right, right: sources.left })}
        >
          ⇄
        </button>
        <div className="field">
          <label className="wc-label" htmlFor={`${fieldId}-new`}>
            New
          </label>
          <Select
            id={`${fieldId}-new`}
            label="New preset"
            value={encodeSource(sources.right)}
            options={options}
            placement="bottom-end"
            onChange={pick('right')}
          />
        </div>
      </div>

      <div className="preset-cc-compare__bar">
        <span className="wc-hint">
          {error
            ? error
            : !view
              ? 'Loading…'
              : sameSource
                ? 'Both sides are the same preset.'
                : view.differences
                  ? `${view.differences} difference${view.differences === 1 ? '' : 's'}`
                  : 'No differences — these presets read the same.'}
        </span>
        <label className="preset-cc-check">
          <input
            type="checkbox"
            checked={onlyDifferences}
            onChange={(event) => setOnlyDifferences(event.target.checked)}
          />
          Only differences
        </label>
      </div>

      {view ? (
        <>
          {view.order.length ? (
            <section className="preset-cc-compare__section">
              <h3>Prompt order</h3>
              <ul className="preset-cc-change__lines">
                {view.order.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {prompts.length ? (
            <section className="preset-cc-compare__section">
              <h3>Prompts</h3>
              {prompts.map((row) => (
                <PromptCompareRow row={row} key={row.key} />
              ))}
            </section>
          ) : null}
          {settings.length ? (
            <section className="preset-cc-compare__section">
              <h3>Settings</h3>
              {settings.map((row) => (
                <SettingCompareRow row={row} key={row.key} />
              ))}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
});
