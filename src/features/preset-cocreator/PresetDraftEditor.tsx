import type { Connection } from '@shared/providers/types.ts';
import type { Preset } from '@shared/types/preset.ts';
import type { PresetDraftRevision } from '@shared/types/preset-cocreator.ts';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { GenerationPanel } from '../preset/GenerationPanel.tsx';
import { PromptsPanel } from '../preset/PromptsPanel.tsx';
import type { PresetDraft } from '../preset/usePresetDraft.ts';
import { findJsonProblem, formatJsonProblem } from './jsonProblem.ts';

interface PresetDraftEditorProps {
  current: Pick<PresetDraftRevision, 'revision' | 'preset'>;
  busy: boolean;
  connection: Connection | null;
  replaceDraft: (preset: Preset, summary?: string) => Promise<void>;
}

const noopAsync = async () => {};

/**
 * Memoised on narrow props for the same reason as the History panel: it stays mounted
 * behind the other tabs, and the prompt list is the heaviest thing in the workspace to
 * re-render on every streamed token.
 */
export const PresetDraftEditor = memo(function PresetDraftEditor({
  current,
  busy,
  connection,
  replaceDraft,
}: PresetDraftEditorProps) {
  const revision = current.revision;
  const committed = current.preset;
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

  // Only an edited buffer can be wrong: an untouched one was serialised from the draft.
  const jsonProblem = useMemo(
    () => (mode === 'json' && dirty ? findJsonProblem(json) : null),
    [mode, dirty, json],
  );

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

  /*
   * Visual edits write through to the JSON buffer as they happen, but JSON edits only
   * reach the visual buffer here. Without this, switching views after typing JSON showed
   * the old preset, and applying from the visual view silently dropped the JSON edits.
   */
  const showVisual = () => {
    if (mode === 'visual' || jsonProblem) return;
    if (dirty) setBuffer(JSON.parse(json) as Preset);
    setMode('visual');
  };

  const apply = async () => {
    if (busy || jsonProblem) return;
    setError('');
    try {
      const parsed = mode === 'json' ? (JSON.parse(json) as Preset) : buffer;
      await replaceDraft(parsed, mode === 'json' ? 'Applied JSON changes' : 'Applied visual edits');
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

  const problemText = jsonProblem ? formatJsonProblem(jsonProblem) : '';

  return (
    <div className="preset-cc-editor">
      <div className="preset-cc-editor__toolbar">
        <div className="preset-cc-tabs" role="tablist" aria-label="Preset editing mode">
          <button
            type="button"
            className="wc-button wc-button--ghost"
            data-active={mode === 'visual' || undefined}
            disabled={Boolean(jsonProblem)}
            title={jsonProblem ? `Fix the JSON first: ${problemText}` : undefined}
            onClick={showVisual}
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
        <span
          className="preset-cc-editor__state"
          data-state={jsonProblem ? 'invalid' : dirty ? 'dirty' : undefined}
        >
          {jsonProblem
            ? 'Invalid JSON'
            : dirty
              ? 'Unapplied changes'
              : `Draft revision ${revision}`}
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
          disabled={!dirty || busy || Boolean(jsonProblem)}
          title={
            busy
              ? 'Manual draft changes are locked while the assistant is running.'
              : jsonProblem
                ? `Fix the JSON first: ${problemText}`
                : undefined
          }
          onClick={() => void apply()}
        >
          Apply changes
        </button>
      </div>
      {jsonProblem ? (
        <p className="preset-cc-editor__problem" role="status">
          {problemText}
        </p>
      ) : null}
      {error ? <p className="preset-cc-inline-error">{error}</p> : null}
      {mode === 'json' ? (
        <textarea
          className="wc-textarea preset-cc-editor__json"
          value={json}
          spellCheck={false}
          disabled={busy}
          aria-label="Preset JSON"
          aria-invalid={Boolean(jsonProblem) || undefined}
          onChange={(event) => {
            setJson(event.target.value);
            setDirty(true);
            setError('');
          }}
        />
      ) : (
        <fieldset className="preset-cc-editor__visual" disabled={busy}>
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
});
