import type { StoryMemoryPlacement, SummaryPosition } from '@shared/types/settings.ts';
import { NumberField, SelectField, TextField } from './Field.tsx';

type Macro = 'summary' | 'memories';
const MACRO_NOUN: Record<Macro, string> = {
  summary: 'the current summary',
  memories: 'the recalled story knowledge',
};

interface StoryMemoryPlacementFieldsProps {
  settings: StoryMemoryPlacement;
  onSettingsChange: (patch: Partial<StoryMemoryPlacement>) => void;
  /** The template stays a parent-owned draft committed on blur: the summary
   * panel feeds the uncommitted text to its own "Summarize now" call. */
  templateDraft: string;
  onTemplateDraftChange: (value: string) => void;
  onTemplateCommit: () => void;
  macro: Macro;
  disabled?: boolean;
}

/**
 * The placement block shared by the Summary and Nexus panels: how a story
 * memory is wrapped and where it lands in the request. The values are resolved
 * by assemble's story-memory slot for whichever feature supplied them.
 */
export function StoryMemoryPlacementFields({
  settings,
  onSettingsChange,
  templateDraft,
  onTemplateDraftChange,
  onTemplateCommit,
  macro,
  disabled,
}: StoryMemoryPlacementFieldsProps) {
  return (
    <>
      <TextField
        label="Injection template"
        value={templateDraft}
        onChange={onTemplateDraftChange}
        onCommit={onTemplateCommit}
        multiline
        expandable
        rows={3}
        hint={`{{${macro}}} resolves to ${MACRO_NOUN[macro]} without re-running macros inside it.`}
        disabled={disabled}
      />
      <SelectField<SummaryPosition>
        label="Position"
        value={settings.position}
        options={[
          { label: 'None (not injected)', value: 'none' },
          { label: 'Before main prompt', value: 'beforeMain' },
          { label: 'After main prompt', value: 'afterMain' },
          { label: 'In chat at depth', value: 'atDepth' },
        ]}
        onChange={(position) => onSettingsChange({ position })}
        disabled={disabled}
      />
      {settings.position === 'atDepth' ? (
        <NumberField
          label="Depth"
          value={settings.depth}
          min={0}
          step={1}
          onChange={(depth) => onSettingsChange({ depth: Math.max(0, Math.floor(depth)) })}
          hint="Messages back from the end; 0 places it after the latest message."
          disabled={disabled}
        />
      ) : null}
      <SelectField<'system' | 'user' | 'assistant'>
        label="Role"
        value={settings.role}
        options={[
          { label: 'System', value: 'system' },
          { label: 'User', value: 'user' },
          { label: 'Assistant', value: 'assistant' },
        ]}
        onChange={(role) => onSettingsChange({ role })}
        disabled={disabled}
      />
    </>
  );
}
