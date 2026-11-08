/**
 * The pool, on the island: the models the Arena draws from.
 *
 * A model is added through the same picker as everywhere else in 3.0. Switching one off
 * sits it out of the next rounds; removing it takes it out of the pool and nothing more —
 * its rounds keep their id, so its rating and record stay on the leaderboard under
 * "Removed". Erasing a removed model's results is the one thing here that loses data, and
 * it takes two clicks.
 */

import type { ArenaSettings } from '@shared/types/arena.ts';
import type { LeaderboardRow } from '../features/arena/elo.ts';
import { canonicalId } from '../features/arena/merges.ts';
import type { ArenaController } from '../features/arena/useArena.ts';
import { Switch, useArm } from './controls.tsx';
import { Icon } from './icons.tsx';
import { modelLabel } from './PresetSession.tsx';

export function ArenaPool({
  arena,
  rows,
  nameOf,
  colourOf,
  onAdd,
  onChange,
}: {
  arena: ArenaController;
  rows: readonly LeaderboardRow[];
  nameOf: (id: string) => string;
  colourOf: (id: string) => string;
  onAdd: () => void;
  onChange: (change: (current: ArenaSettings) => Partial<ArenaSettings>) => void;
}) {
  const arm = useArm();
  const contenders = arena.resolved.map((entry) => entry.contender);
  const canonical = arena.merged.canonical;
  const rowOf = (id: string) => rows.find((row) => row.contenderId === canonicalId(canonical, id));
  const inPool = new Set(contenders.map((c) => canonicalId(canonical, c.id)));
  const removed = rows.filter(
    (row) => !inPool.has(row.contenderId) && row.rounds + row.rejected > 0,
  );

  return (
    <div className="w3-ar-pool">
      <button type="button" className="w3-ar-pool__add" onClick={onAdd}>
        <Icon name="plus" size="sm" />
        Add a model
      </button>
      <p className="w3-ar-pool__h">
        <span>
          In the pool · {contenders.filter((c) => c.enabled).length} of {contenders.length}
        </span>
        <span>Rating</span>
      </p>
      <div className="w3-ar-pool__list">
        {arena.resolved.length === 0 ? (
          <p className="w3-ar-pool__empty">No models yet. Add two to start.</p>
        ) : null}
        {arena.resolved.map(({ contender, unavailableReason }) => {
          const row = rowOf(contender.id);
          const folded = canonicalId(canonical, contender.id) !== contender.id;
          return (
            <div
              key={contender.id}
              className="w3-ar-pool__row"
              data-off={!contender.enabled || unavailableReason ? '' : undefined}
            >
              <i style={{ background: colourOf(contender.id) }} aria-hidden="true" />
              <span className="w3-ar-pool__who">
                <b>{nameOf(contender.id)}</b>
                <small>
                  {unavailableReason ??
                    (folded
                      ? `Counted as ${nameOf(canonicalId(canonical, contender.id))}`
                      : contender.enabled
                        ? (contender.model?.modelId ?? '')
                        : 'Sitting out')}
                </small>
              </span>
              <span className="w3-ar-pool__r">
                {row && row.rounds > 0 ? `${row.rating}${row.provisional ? '?' : ''}` : '—'}
              </span>
              <Switch
                on={contender.enabled}
                label={`${nameOf(contender.id)} in the next rounds`}
                onChange={(on) =>
                  onChange((current) => ({
                    contenders: current.contenders.map((c) =>
                      c.id === contender.id ? { ...c, enabled: on } : c,
                    ),
                  }))
                }
              />
              <button
                type="button"
                className="w3-ar-pool__x"
                data-armed={arm.armed === contender.id ? '' : undefined}
                title={
                  arm.armed === contender.id
                    ? 'Click again to remove. Its results stay on the leaderboard.'
                    : 'Remove from the pool'
                }
                onClick={() =>
                  arm.press(contender.id, () =>
                    onChange((current) => ({
                      contenders: current.contenders.filter((c) => c.id !== contender.id),
                    })),
                  )
                }
              >
                {arm.armed === contender.id ? 'Remove' : <Icon name="close" size="xs" />}
              </button>
            </div>
          );
        })}
        {removed.length ? (
          <>
            <p className="w3-ar-pool__group">Removed · results kept</p>
            {removed.map((row) => (
              <div key={row.contenderId} className="w3-ar-pool__row" data-off="">
                <i style={{ background: colourOf(row.contenderId) }} aria-hidden="true" />
                <span className="w3-ar-pool__who">
                  <b>{nameOf(row.contenderId)}</b>
                  <small>{modelLabel(row.model) ?? row.model}</small>
                </span>
                <span className="w3-ar-pool__r">{row.rating}</span>
                <span />
                <button
                  type="button"
                  className="w3-ar-pool__x w3-ar-pool__erase"
                  data-armed={arm.armed === `erase:${row.contenderId}` ? '' : undefined}
                  title="Delete every round this model played"
                  onClick={() =>
                    arm.press(`erase:${row.contenderId}`, () =>
                      arena.purgeContender(row.contenderId),
                    )
                  }
                >
                  {arm.armed === `erase:${row.contenderId}` ? 'Erase its rounds' : 'Erase'}
                </button>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}
