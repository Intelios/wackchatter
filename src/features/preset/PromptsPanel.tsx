import { deleteCustomPrompt, getPromptById } from '@shared/prompt/preset-io.ts';
import type { MacroWarning } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import { PromptEditor } from './PromptEditor.tsx';
import { PromptManager } from './PromptManager.tsx';
import type { PresetDraft } from './usePresetDraft.ts';
import './PromptsPanel.css';

interface PromptsPanelProps {
  preset: Preset;
  draft: PresetDraft;
  /** Held by the panel router, so switching away and back keeps your place. */
  selected: string | null;
  onSelect: (identifier: string | null) => void;
  tokenCounts?: Record<string, number>;
  macroWarnings?: MacroWarning[];
}

export function PromptsPanel({
  preset,
  draft,
  selected,
  onSelect,
  tokenCounts,
  macroWarnings = [],
}: PromptsPanelProps) {
  // Resolved rather than trusted: a selection can outlive its prompt (deleted here, or
  // gone after switching preset), and PromptEditor renders nothing for a missing one —
  // which would leave an empty panel with no way back.
  const editing = selected ? getPromptById(preset, selected) : null;

  if (selected && editing) {
    return (
      <PromptEditor
        preset={preset}
        identifier={selected}
        onChange={draft.change}
        onClose={() => onSelect(null)}
        onDelete={(identifier) => {
          draft.change(deleteCustomPrompt(preset, identifier));
          onSelect(null);
        }}
      />
    );
  }

  return (
    <div className="prompts-panel">
      {macroWarnings.length > 0 ? (
        <details className="prompts-panel__warnings">
          <summary>
            {macroWarnings.length} unresolved macro{macroWarnings.length === 1 ? '' : 's'}
          </summary>
          <ul>
            {macroWarnings.map((warning) => (
              <li key={`${warning.source}:${warning.macro}`}>
                <code>{warning.macro}</code> in {warning.source}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <PromptManager
        preset={preset}
        onChange={draft.change}
        selected={selected}
        onSelect={onSelect}
        tokenCounts={tokenCounts}
      />
    </div>
  );
}
