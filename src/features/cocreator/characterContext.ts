import type { MessageState } from '@shared/chat/message.ts';
import {
  activeCheckpoint,
  type CompactionState,
  renderCheckpoint,
} from '@shared/cocreator/compaction.ts';
import { cocreatorBudget } from '@shared/cocreator/generation.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { ResolvedModel } from '@shared/providers/types.ts';
import type { SessionModelSettings, SideChatSnapshot } from '@shared/types/cocreator.ts';
import type { Preset } from '@shared/types/preset.ts';
import { characterCompactionSources } from './compactionSources.ts';
import { buildDesignPrompt } from './prompt.ts';
import { buildSidePrompt } from './sidePrompt.ts';

export function measureCharacterContext(input: {
  messages: readonly MessageState[];
  snapshot?: SideChatSnapshot;
  compaction?: CompactionState;
  preset: Preset;
  model: ResolvedModel;
  contextTokens: number;
  settings: SessionModelSettings;
  systemPrompt: string;
  exampleBlock: string;
  draftBlock: string;
  countTokens: TokenCounter;
}) {
  const budget = cocreatorBudget({
    preset: input.preset,
    connection: input.model,
    outputTokens: input.settings.outputTokens,
    contextTokens: input.contextTokens,
  });
  const common = { countTokens: input.countTokens, maxPromptTokens: Number.MAX_SAFE_INTEGER };
  const main = {
    ...common,
    systemPrompt: input.systemPrompt,
    exampleBlock: input.exampleBlock,
    draftBlock: input.draftBlock,
  };
  const measured = input.snapshot
    ? buildSidePrompt({
        ...common,
        snapshot: input.snapshot,
        messages: input.messages,
        compaction: input.compaction,
      })
    : buildDesignPrompt({ ...main, messages: input.messages, compaction: input.compaction });
  const fixed = input.snapshot
    ? buildSidePrompt({ ...common, snapshot: { ...input.snapshot, messages: [] }, messages: [] })
        .totalTokens
    : buildDesignPrompt({ ...main, messages: [] }).totalTokens;
  const sources = characterCompactionSources(input.messages, input.snapshot);
  const checkpoint = activeCheckpoint(input.compaction, sources);
  return {
    budget,
    sources,
    used: measured.totalTokens,
    fixed,
    summary: checkpoint ? input.countTokens.countText(renderCheckpoint(checkpoint)) : 0,
  };
}
