import type { Preset } from '@shared/types/preset.ts';
import type { PresetTestPresetUsed, PresetTestSource } from '@shared/types/preset-cocreator.ts';

type VersionedPreset = { preset: Preset; version: string };

export interface PresetTestSourceLoaders {
  library(id: string): Promise<VersionedPreset>;
  reference(id: string): Promise<VersionedPreset>;
}

export interface PresetTestSourceSession {
  current: { revision: number; preset: Preset };
  history: readonly { revision: number; preset: Preset }[];
}

export function presetTestSourceKey(source: PresetTestSource): string {
  if (source.kind === 'draft') return 'draft';
  if (source.kind === 'revision') return `revision:${source.revision}`;
  return `${source.kind}:${source.id}`;
}

export function describePresetUsed(used: PresetTestPresetUsed): string {
  const kind = used.source.kind;
  if (kind === 'draft') return `Working draft · rev ${used.revision ?? '?'}`;
  if (kind === 'revision') return `Revision ${used.revision ?? used.source.revision}`;
  const prefix = kind === 'library' ? 'My preset' : 'Reference';
  const version =
    used.revision !== undefined
      ? `rev ${used.revision}`
      : used.version
        ? `version ${used.version.slice(0, 8)}`
        : '';
  return [prefix, used.label, version].filter(Boolean).join(' · ');
}

/** Fetch external files on every dispatch; the returned preset is the entire turn's snapshot. */
export async function resolvePresetTestSource(
  source: PresetTestSource,
  session: PresetTestSourceSession,
  loaders: PresetTestSourceLoaders,
): Promise<{ preset: Preset; used: PresetTestPresetUsed }> {
  if (source.kind === 'draft') {
    return {
      preset: structuredClone(session.current.preset),
      used: {
        source: { kind: 'draft' },
        label: 'Working draft',
        revision: session.current.revision,
      },
    };
  }
  if (source.kind === 'revision') {
    const revision = session.history.find((item) => item.revision === source.revision);
    if (!revision) throw new Error(`Session revision ${source.revision} is unavailable.`);
    return {
      preset: structuredClone(revision.preset),
      used: {
        source: structuredClone(source),
        label: `Revision ${source.revision}`,
        revision: source.revision,
      },
    };
  }
  const record =
    source.kind === 'library'
      ? await loaders.library(source.id)
      : await loaders.reference(source.id);
  return {
    preset: structuredClone(record.preset),
    used: { source: structuredClone(source), label: source.id, version: record.version },
  };
}
