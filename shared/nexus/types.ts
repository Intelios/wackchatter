import type { ReasoningEffort } from '../types/preset.ts';
import type { StoryMemoryPlacement } from '../types/settings.ts';

export type NexusNodeKind = 'person' | 'place' | 'object' | 'event' | 'group' | 'concept';
export type NexusKind = 'fact' | 'event' | 'situation' | 'thread';
export interface NexusEvidence {
  messageId: string;
  fingerprint: string;
  excerpt: string;
  legacyHiddenBy?: string;
}
export interface NexusNodeVersion {
  name: string;
  aliases: string[];
  kind: NexusNodeKind;
  anchorId?: string;
  evidence: NexusEvidence[];
  manual: boolean;
  deleted?: boolean;
  mergedInto?: string;
}
export interface NexusNode {
  id: string;
  versions: NexusNodeVersion[];
}
export interface NexusRevision {
  text: string;
  kind: NexusKind;
  assertion: 'fact' | 'claim' | 'intention' | 'event';
  status: 'active' | 'resolved' | 'historical' | 'conflict';
  nodeIds: string[];
  relation?: { from: string; to: string; label: string };
  evidence: NexusEvidence[];
  anchorId?: string;
  created: number;
  enabled: boolean;
  pinned: boolean;
  deleted: boolean;
  manual: boolean;
  cues: string[];
  conflicts?: string[];
  legacy?: boolean;
  needsReview?: boolean;
  model?: string;
}
export interface NexusRecord {
  id: string;
  revisions: NexusRevision[];
}
export interface NexusState {
  version: 1;
  nodes: NexusNode[];
  records: NexusRecord[];
  processed: Record<string, string>;
  initialized: boolean;
  paused: boolean;
}
export interface NexusSettings extends StoryMemoryPlacement {
  connectionId: string | null;
  model: string;
  extractPrompt: string;
  autoInterval: number;
  inputTokens: number;
  outputTokens: number;
  budgetTokens: number;
  temperature: number;
  /**
   * Extraction is structured output, not a task that benefits from long chains of thought —
   * and a reasoning model will happily spend the whole output allowance thinking and never
   * emit the JSON. Low by default; Auto sends nothing for endpoints that reject the field.
   */
  reasoningEffort: ReasoningEffort;
  motion: boolean;
}
export interface NexusDocument {
  id: string;
  text: string;
  fingerprint: string;
  nodeIds: string[];
  cues: string[];
  evidence: NexusEvidence[];
  recordId?: string;
  historical?: boolean;
}
export interface NexusEmbedding {
  documentId: string;
  fingerprint: string;
  vector: number[];
}
export interface NexusHit {
  id: string;
  text: string;
  recordId?: string;
  nodeIds: string[];
  evidence: NexusEvidence[];
  reasons: string[];
  score: number;
  tokens: number;
  included: boolean;
}
export interface NexusRecall {
  text: string;
  hits: NexusHit[];
  tokens: number;
  semantic: boolean;
  label: 'Preview' | 'Request';
  warning?: string;
}
export interface NexusFinding {
  id: string;
  text: string;
  evidence: NexusEvidence[];
  nodeIds: string[];
  selected: boolean;
}

export const NEXUS_PROMPT = `You maintain a faithful memory of an ongoing story. Extract short, standalone facts, meaningful events, current situations, promises and unresolved goals. A small fact usually needs one sentence. Preserve who said or believed something: a suspicion, intention or reported claim is not established truth. Never infer unstated facts. Profiles, the scenario and the existing records are context for interpretation, never evidence; only the transcript excerpt may be cited. Record private knowledge as private, not as something everyone knows.
Use the supplied existing IDs when the evidence clearly identifies the same entity. Equal names alone do not prove identity. Add aliases only when explicitly established. Preserve exact names. Give every fact 2–4 useful search cues — names, places, topics, not words already in its text — and state how entities stand to each other as relations wherever the transcript supports it. Update clear changes by revising an existing generated record, preserving its identity; do not combine different predicates (hometown and current residence differ). Mark unresolved contradictions as conflict and name the conflicting record IDs. Leave manually edited, disabled and deleted records alone. Facts may overlap in source messages. Do not wait for a scene to finish. Never mention this application, extraction, or message numbering in memory text.`;

export const DEFAULT_NEXUS: Readonly<NexusSettings> = {
  connectionId: null,
  model: '',
  extractPrompt: NEXUS_PROMPT,
  autoInterval: 12,
  inputTokens: 8192,
  outputTokens: 2048,
  budgetTokens: 1200,
  temperature: 0.2,
  reasoningEffort: 'low',
  motion: true,
  template:
    '[Story knowledge. Respect chronology, attribution and who knows each fact.\n{{memories}}]',
  position: 'afterMain',
  depth: 2,
  role: 'system',
};
