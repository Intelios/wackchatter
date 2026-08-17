import { claudeThinkingBudget, isAnthropicModel } from '@shared/providers/request.ts';
import type { Connection } from '@shared/providers/types.ts';
import {
  CHARACTER_NAMES_BEHAVIOR,
  type Preset,
  type ReasoningEffort,
} from '@shared/types/preset.ts';
import { CheckField, NumberField, SelectField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { Slider } from '../../components/Slider.tsx';
import type { PresetDraft } from './usePresetDraft.ts';
import './GenerationPanel.css';

/**
 * Ceiling on simultaneous completions.
 *
 * Not a protocol limit — a guard on a field where a stray keystroke is a real bill, and
 * more alternates than anyone reads before picking one.
 */
const MAX_COMPLETIONS = 8;

interface GenerationPanelProps {
  preset: Preset;
  draft: PresetDraft;
  /** Whether the active provider sends OpenRouter-style extra samplers. */
  extraSamplersSent?: boolean;
  /** The active connection, for the provider-behaviour toggles below. */
  connection?: Connection | null;
  /** Write-through patch of the active connection — not part of the preset draft. */
  onConnectionPatch?: (patch: Partial<Connection>) => void;
}

/**
 * Every knob on the preset that is not a prompt: samplers, formatting, continue, context.
 * Grouped under one button because they are all "how the reply comes out", and four
 * separate buttons for four short forms would be more navigation than content.
 */
export function GenerationPanel({
  preset,
  draft,
  extraSamplersSent = false,
  connection,
  onConnectionPatch,
}: GenerationPanelProps) {
  const setField = draft.setField;

  // Claude on OpenRouter reads the effort selector as an on/off switch for thinking, and pays
  // for it with tokens on top of the reply. Both are worth stating where the knob is, and the
  // number comes from the same helper the request builder uses so it cannot drift.
  const responseTokens = preset.openai_max_tokens ?? 300;
  const claudeOnOpenRouter =
    connection?.provider === 'openrouter' && isAnthropicModel(connection.model);
  const claudeBudget = claudeOnOpenRouter
    ? claudeThinkingBudget(responseTokens, preset, preset.stream_openai !== false)
    : null;

  return (
    <div className="generation-panel">
      <Section title="Generation" defaultOpen>
        <Slider
          label="Temperature"
          value={preset.temperature ?? 1}
          min={0}
          max={2}
          step={0.01}
          onChange={(v) => setField('temperature', v)}
        />
        <Slider
          label="Top P"
          value={preset.top_p ?? 1}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setField('top_p', v)}
        />
        <Slider
          label="Top K"
          value={preset.top_k ?? 0}
          min={0}
          max={200}
          step={1}
          onChange={(v) => setField('top_k', Math.round(v))}
        />
        <Slider
          label="Top A"
          value={preset.top_a ?? 0}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setField('top_a', v)}
        />
        <Slider
          label="Min P"
          value={preset.min_p ?? 0}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setField('min_p', v)}
        />
        <Slider
          label="Frequency penalty"
          value={preset.frequency_penalty ?? 0}
          min={-2}
          max={2}
          step={0.01}
          onChange={(v) => setField('frequency_penalty', v)}
        />
        <Slider
          label="Presence penalty"
          value={preset.presence_penalty ?? 0}
          min={-2}
          max={2}
          step={0.01}
          onChange={(v) => setField('presence_penalty', v)}
        />
        <Slider
          label="Repetition penalty"
          value={preset.repetition_penalty ?? 1}
          min={0}
          max={2}
          step={0.01}
          onChange={(v) => setField('repetition_penalty', v)}
        />
        {!extraSamplersSent ? (
          <p className="wc-hint">
            Top K, Top A, Min P and repetition penalty are preserved but not sent by the active
            provider.
          </p>
        ) : null}
        <div className="field-row">
          <NumberField
            label="Seed"
            value={preset.seed ?? -1}
            min={-1}
            step={1}
            onChange={(value) => setField('seed', Math.round(value))}
            hint="-1 lets the provider choose."
          />
          <NumberField
            label="Completions"
            value={preset.n ?? 1}
            min={1}
            max={MAX_COMPLETIONS}
            step={1}
            onChange={(value) =>
              setField('n', Math.min(MAX_COMPLETIONS, Math.max(1, Math.round(value))))
            }
            hint="Replies to ask for at once. The spares arrive as swipes, and every one of them is billed."
          />
        </div>
        {(preset.n ?? 1) > 1 ? (
          <p className="wc-hint">
            Continue and summaries always ask for one. An endpoint that does not support multiple
            completions simply returns a single reply.
          </p>
        ) : null}
        <SelectField<ReasoningEffort>
          label="Reasoning effort"
          value={preset.reasoning_effort ?? 'auto'}
          options={[
            { label: 'Auto', value: 'auto' },
            { label: 'Min', value: 'min' },
            { label: 'Low', value: 'low' },
            { label: 'Medium', value: 'medium' },
            { label: 'High', value: 'high' },
            { label: 'Max', value: 'max' },
          ]}
          onChange={(value) => setField('reasoning_effort', value)}
          hint="Only reasoning models use this. Auto sends nothing, which suits every other model."
        />
        {claudeOnOpenRouter ? (
          <p className="wc-hint">
            {claudeBudget === null
              ? 'Claude on OpenRouter thinks only when an effort is set — on Auto it does not think at all.'
              : `Claude on OpenRouter gets a ${claudeBudget.toLocaleString()}-token thinking budget on top of the ${responseTokens.toLocaleString()}-token reply, asking for ${(responseTokens + claudeBudget).toLocaleString()} in total. Temperature, Top P and Top K are not sent — Anthropic rejects them while thinking.`}
          </p>
        ) : null}
      </Section>

      {connection && onConnectionPatch ? (
        <Section title="Provider behaviour" defaultOpen>
          {/* Connection settings, not preset fields: they describe how the active
              endpoint is asked, and save immediately rather than with the preset. */}
          <CheckField
            label="Show reasoning"
            checked={connection.showReasoning !== false}
            onChange={(checked) => onConnectionPatch({ showReasoning: checked })}
            hint={`Ask reasoning models for their thinking text. Applies to the active connection, ${connection.name}.`}
          />
          <CheckField
            label="Report real token usage"
            checked={Boolean(connection.reportUsage)}
            onChange={(checked) => onConnectionPatch({ reportUsage: checked })}
            hint="Exact counts from the provider instead of our estimate. Some OpenAI-compatible proxies reject the request, so it is off by default."
          />
        </Section>
      ) : null}

      <Section title="Formatting">
        <SelectField<number>
          label="Names in prompt"
          value={preset.names_behavior ?? CHARACTER_NAMES_BEHAVIOR.DEFAULT}
          options={[
            { label: 'None', value: CHARACTER_NAMES_BEHAVIOR.NONE },
            { label: 'Default', value: CHARACTER_NAMES_BEHAVIOR.DEFAULT },
            { label: 'Completion name field', value: CHARACTER_NAMES_BEHAVIOR.COMPLETION },
            { label: 'Prefix message content', value: CHARACTER_NAMES_BEHAVIOR.CONTENT },
          ]}
          onChange={(value) => setField('names_behavior', value)}
        />
        <TextField
          label="World Info format"
          value={preset.wi_format ?? '{0}'}
          onChange={(value) => setField('wi_format', value)}
          hint="Use {0} for the activated lore text."
        />
        <TextField
          label="Personality format"
          value={preset.personality_format ?? '{{personality}}'}
          onChange={(value) => setField('personality_format', value)}
        />
        <TextField
          label="Scenario format"
          value={preset.scenario_format ?? '{{scenario}}'}
          onChange={(value) => setField('scenario_format', value)}
        />
        <TextField
          label="New chat marker"
          value={preset.new_chat_prompt ?? '[Start a new Chat]'}
          onChange={(value) => setField('new_chat_prompt', value)}
          multiline
          expandable
        />
        <TextField
          label="Example dialogue marker"
          value={preset.new_example_chat_prompt ?? '[Example Chat]'}
          onChange={(value) => setField('new_example_chat_prompt', value)}
        />
        <TextField
          label="Send if history ends on assistant"
          value={preset.send_if_empty ?? ''}
          onChange={(value) => setField('send_if_empty', value)}
          hint="Leave empty to disable the compatibility message."
        />
      </Section>

      <Section title="Continue">
        <TextField
          label="Continue nudge"
          value={
            preset.continue_nudge_prompt ??
            '[Continue your last message without repeating its original content.]'
          }
          onChange={(value) => setField('continue_nudge_prompt', value)}
          multiline
          expandable
        />
        <CheckField
          label="Use assistant prefill"
          checked={Boolean(preset.continue_prefill)}
          onChange={(checked) => setField('continue_prefill', checked)}
          hint="Moves the partial assistant reply to the end instead of adding a nudge."
        />
        <TextField
          label="Continue postfix"
          value={preset.continue_postfix ?? ' '}
          onChange={(value) => setField('continue_postfix', value)}
          hint="Inserted between the existing reply and newly generated text."
        />
      </Section>

      <Section title="Context" defaultOpen>
        <Slider
          label="Max context"
          value={preset.openai_max_context ?? 4095}
          min={512}
          max={1000000}
          step={1}
          onChange={(v) => setField('openai_max_context', Math.round(v))}
        />
        <Slider
          label="Max response"
          value={preset.openai_max_tokens ?? 300}
          min={16}
          max={16384}
          step={1}
          onChange={(v) => setField('openai_max_tokens', Math.round(v))}
        />
        <label className="generation-panel__check">
          <input
            type="checkbox"
            checked={Boolean(preset.squash_system_messages)}
            onChange={(e) => setField('squash_system_messages', e.target.checked)}
          />
          <span>
            Squash system messages
            <span className="wc-hint">Merge consecutive system messages into one.</span>
          </span>
        </label>
        <label className="generation-panel__check">
          <input
            type="checkbox"
            checked={preset.stream_openai !== false}
            onChange={(e) => setField('stream_openai', e.target.checked)}
          />
          <span>Stream responses</span>
        </label>
      </Section>
    </div>
  );
}
