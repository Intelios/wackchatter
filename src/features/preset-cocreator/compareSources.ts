import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type {
  PresetComparisonSource,
  PresetDraftRevision,
  ReferencePresetSummary,
} from '@shared/types/preset-cocreator.ts';
import { presetApi, referencePresetApi } from '../../lib/api.ts';
import { encodeSource } from './presetCompare.ts';

export interface ComparisonChoice {
  source: PresetComparisonSource;
  key: string;
  label: string;
  detail: string;
  group: 'Reference presets' | 'My presets' | 'Session revisions';
}

export function comparisonChoices(
  references: readonly ReferencePresetSummary[],
  presets: readonly PresetSummary[],
  history: readonly PresetDraftRevision[],
  currentRevision: number,
): ComparisonChoice[] {
  return [
    ...references.map((entry) => ({
      source: { kind: 'reference' as const, id: entry.id },
      key: encodeSource({ kind: 'reference', id: entry.id }),
      label: entry.name,
      detail: 'Reference preset',
      group: 'Reference presets' as const,
    })),
    ...presets.map((entry) => ({
      source: { kind: 'library' as const, id: entry.id },
      key: encodeSource({ kind: 'library', id: entry.id }),
      label: entry.name,
      detail: 'My preset',
      group: 'My presets' as const,
    })),
    ...history
      .filter((entry) => entry.revision < currentRevision)
      .reverse()
      .map((entry) => ({
        source: { kind: 'revision' as const, revision: entry.revision },
        key: encodeSource({ kind: 'revision', revision: entry.revision }),
        label: `Revision ${entry.revision}`,
        detail: entry.summary || entry.source,
        group: 'Session revisions' as const,
      })),
  ];
}

export function filterComparisonChoices(choices: readonly ComparisonChoice[], query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return choices.filter((choice) =>
    words.every((word) =>
      `${choice.label} ${choice.detail} ${choice.group}`.toLocaleLowerCase().includes(word),
    ),
  );
}

export async function loadComparisonPreset(
  source: PresetComparisonSource,
  history: readonly PresetDraftRevision[],
): Promise<Preset> {
  if (source.kind === 'revision') {
    const found = history.find((entry) => entry.revision === source.revision);
    if (!found) throw new Error(`Revision ${source.revision} is no longer in this session.`);
    return structuredClone(found.preset);
  }
  if (source.kind === 'reference') return (await referencePresetApi.get(source.id)).preset;
  return presetApi.get(source.id);
}
