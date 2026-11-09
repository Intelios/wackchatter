import {
  activeCheckpoint,
  type CompactionMessage,
  type CompactionRecord,
  type CompactionState,
  makeCompactionPlan,
  normalizeCompaction,
} from '@shared/cocreator/compaction.ts';

export interface CocreatorContext {
  label: string;
  model: string | null;
  total: number;
  assumed: boolean;
  used: number;
  fixed: number;
  summary: number;
  reserved: number;
  promptBudget: number;
  automatic: boolean;
  compacting: boolean;
  disabledReason: string | null;
  checkpoint: CompactionRecord | null;
}
export function contextView(options: {
  label: string;
  model: string | null;
  total: number;
  assumed: boolean;
  used: number;
  fixed: number;
  summary: number;
  reserved: number;
  promptBudget: number;
  messages: readonly CompactionMessage[];
  state?: CompactionState;
  busy: boolean;
  compacting: boolean;
  countText(text: string): number;
  kind: 'character' | 'side' | 'preset';
  blocked?: string | null;
}): CocreatorContext {
  const state = normalizeCompaction(options.state);
  const active = activeCheckpoint(state, options.messages);
  const plan =
    options.model && !options.busy
      ? makeCompactionPlan({
          messages: options.messages,
          state,
          countText: options.countText,
          maxPromptTokens: options.promptBudget,
          kind: options.kind,
        })
      : null;
  return {
    label: options.label,
    model: options.model,
    total: options.total,
    assumed: options.assumed,
    used: options.used,
    fixed: options.fixed,
    summary: options.summary,
    reserved: options.reserved,
    promptBudget: options.promptBudget,
    automatic: state.automatic,
    compacting: options.compacting,
    disabledReason:
      options.blocked ??
      (!options.model
        ? 'Choose a model first.'
        : options.busy
          ? 'Wait for the current request or stop it first.'
          : options.fixed > options.promptBudget
            ? 'The instructions, card or preset and examples already fill this model. Reduce those or choose a larger model.'
            : !plan
              ? 'There is not enough earlier conversation to compact yet.'
              : null),
    checkpoint: active
      ? (state.history.findLast((record) => record.checkpoint === active) ?? null)
      : null,
  };
}
