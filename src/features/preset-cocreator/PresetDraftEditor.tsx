import type { Connection } from '@shared/providers/types.ts';
import type { Preset } from '@shared/types/preset.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GenerationPanel } from '../preset/GenerationPanel.tsx';
import { PromptsPanel } from '../preset/PromptsPanel.tsx';
import type { PresetDraft } from '../preset/usePresetDraft.ts';
import type { PresetCocreatorController } from './usePresetCocreator.ts';

interface PresetDraftEditorProps {
  controller: PresetCocreatorController;
  connection: Connection | null;
}

const noopAsync = async () => {};

export function PresetDraftEditor({ controller, connection }: PresetDraftEditorProps) {
  const revision = controller.session.current.revision;
  const committed = controller.session.current.preset;
  const [buffer, setBuffer] = useState<Preset>(() => structuredClone(committed));
  const [json, setJson] = useState(() => JSON.stringify(committed, null, 4));
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (dirty) return;
    const next = structuredClone(committed);
    setBuffer(next);
    setJson(JSON.stringify(next, null, 4));
  }, [committed, dirty]);

  const change = useCallback((next: Preset) => {
    setBuffer(next);
    setJson(JSON.stringify(next, null, 4));
    setDirty(true);
    setError('');
  }, []);

  const draft = useMemo<PresetDraft>(
    () => ({
      dirty,
      status: '',
      renaming: false,
      nameDraft: '',
      setNameDraft: () => {},
      startRename: () => {},
      cancelRename: () => {},
      change,
      setField: (key, value) => change({ ...buffer, [key]: value }),
      save: noopAsync,
      revert: () => {},
      rename: noopAsync,
      duplicate: noopAsync,
      remove: noopAsync,
      importPreset: noopAsync,
    }),
    [buffer, dirty, change],
  );

  const apply = async () => {
    if (controller.busy) return;
    setError('');
    try {
      const parsed = mode === 'json' ? (JSON.parse(json) as Preset) : buffer;
      await controller.replaceDraft(
        parsed,
        mode === 'json' ? 'Applied JSON changes' : 'Applied visual edits',
      );
      setBuffer(structuredClone(parsed));
      setJson(JSON.stringify(parsed, null, 4));
      setDirty(false);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  const discard = () => {
    const next = structuredClone(committed);
    setBuffer(next);
    setJson(JSON.stringify(next, null, 4));
    setDirty(false);
    setError('');
  };

  return (
    <div className="preset-cc-editor">
      <div className="preset-cc-editor__toolbar">
        <div className="preset-cc-tabs" role="tablist" aria-label="Preset editing mode">
          <button
            type="button"
            className="wc-button wc-button--ghost"
            data-active={mode === 'visual' || undefined}
            onClick={() => setMode('visual')}
          >
            Visual editor
          </button>
          <button
            type="button"
            className="wc-button wc-button--ghost"
            data-active={mode === 'json' || undefined}
            onClick={() => setMode('json')}
          >
            Advanced JSON
          </button>
        </div>
        <span className="preset-cc-editor__state">
          {dirty ? 'Unapplied changes' : `Draft revision ${revision}`}
        </span>
        <button
          type="button"
          className="wc-button wc-button--ghost"
          disabled={!dirty}
          onClick={discard}
        >
          Discard
        </button>
        <button
          type="button"
          className="wc-button wc-button--primary"
          disabled={!dirty || controller.busy}
          title={
            controller.busy
              ? 'Manual draft changes are locked while the assistant is running.'
              : undefined
          }
          onClick={() => void apply()}
        >
          Apply changes
        </button>
      </div>
      {error ? <p className="preset-cc-inline-error">{error}</p> : null}
      {mode === 'json' ? (
        <textarea
          className="wc-textarea preset-cc-editor__json"
          value={json}
          spellCheck={false}
          disabled={controller.busy}
          aria-label="Preset JSON"
          onChange={(event) => {
            setJson(event.target.value);
            setDirty(true);
            setError('');
          }}
        />
      ) : (
        <fieldset className="preset-cc-editor__visual" disabled={controller.busy}>
          <div className="preset-cc-editor__prompts">
            <PromptsPanel
              preset={buffer}
              draft={draft}
              selected={selectedPrompt}
              onSelect={setSelectedPrompt}
            />
          </div>
          <div className="preset-cc-editor__generation">
            <GenerationPanel
              preset={buffer}
              draft={draft}
              connection={connection}
              extraSamplersSent={connection?.provider === 'openrouter'}
            />
          </div>
        </fieldset>
      )}
    </div>
  );
}
