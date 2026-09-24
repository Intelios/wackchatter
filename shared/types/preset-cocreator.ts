import type { JsonPatchOperation, PresetDiffEntry } from '../preset-cocreator/patch.ts';
import type { ChatCompletionBody, ProviderToolCall } from '../providers/types.ts';
import type { WorldInfoSource } from '../worldinfo/activate.ts';
import type { CardDataV2 } from './card.ts';
import type { ApiMessage, ChatMessage, MacroVariableMap, Persona } from './chat.ts';
import type { Preset } from './preset.ts';
import type { RegexScript } from './regex.ts';
import type { WorldInfoSettings } from './worldinfo.ts';

/** One visible design-conversation item, including the provider's tool loop. */
export interface PresetCocreatorMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'report';
  content: string;
  created: number;
  reasoning?: string;
  reasoningDetails?: unknown[];
  toolCalls?: ProviderToolCall[];
  toolCallId?: string;
  toolName?: string;
  report?: PresetTestReport;
}

export interface PresetCocreatorModelSettings {
  connectionId: string | null;
  model: string;
  maxTokens: number;
  temperature: number;
  reasoningEffort: 'auto' | 'min' | 'low' | 'medium' | 'high' | 'max';
}

export interface PresetCocreatorSettings {
  assistant: PresetCocreatorModelSettings;
  testing: PresetCocreatorModelSettings;
  assistantInstructions: string;
}

export interface ProposedPresetTest {
  id: string;
  message: string;
  restart: boolean;
  rationale: string;
  created: number;
  status: 'pending' | 'dismissed' | 'run';
}

export interface PresetTestScenario {
  /** The card's filename; null for a test with no character card (`character` is blank). */
  characterId: string | null;
  character: CardDataV2;
  greetingIndex: number;
  persona: Persona | null;
  worldInfoSources: WorldInfoSource[];
  worldInfoSettings: WorldInfoSettings;
  regexScripts: RegexScript[];
  /** Frozen variable state at the moment this scenario was created. */
  variables: {
    local: MacroVariableMap;
    global: MacroVariableMap;
  };
}

export interface PresetTestEvidence {
  id: string;
  created: number;
  messageId: string;
  swipeIndex: number;
  draftRevision: number;
  connectionId: string;
  model: string;
  generationId: string;
  kind: 'send' | 'regenerate' | 'swipe';
  status: 'complete' | 'failed' | 'aborted';
  responseText: string;
  responseReasoning?: string;
  /** The selected response displaced by regenerate, retained as immutable evidence. */
  replacedResponse?: string;
  messages: ApiMessage[];
  body: ChatCompletionBody | null;
  tokenCounts: Record<string, number>;
  totalTokens: number;
  droppedMessages: number;
  macroWarnings: { macro: string; source: string }[];
  worldInfo?: unknown;
  finishReason?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

export interface PresetTest {
  id: string;
  title: string;
  created: number;
  modified: number;
  scenario: PresetTestScenario;
  /** Private working copies. They never write back to application settings. */
  localVariables: MacroVariableMap;
  globalVariables: MacroVariableMap;
  messages: ChatMessage[];
  evidence: PresetTestEvidence[];
}

export interface PresetTestReport {
  id: string;
  created: number;
  testId: string;
  throughMessageId: string;
  note: string;
  includeTranscript: boolean;
  includePrompt: boolean;
  includeDiagnostics: boolean;
  transcript?: ChatMessage[];
  evidence?: PresetTestEvidence;
}

/** Autosaved independently from the immutable preset revision history. */
export interface PresetCocreatorDocument {
  settings: PresetCocreatorSettings;
  messages: PresetCocreatorMessage[];
  tests: PresetTest[];
  activeTestId: string | null;
  proposedTests: ProposedPresetTest[];
}

export interface PresetDraftRevision {
  revision: number;
  created: number;
  source: 'initial' | 'assistant' | 'manual' | 'restore';
  summary: string;
  turnId: string | null;
  operationId: string;
  preset: Preset;
  diff: PresetDiffEntry[];
  restoredFrom?: number;
}

export interface PresetCocreatorSessionSummary {
  id: string;
  title: string;
  created: number;
  modified: number;
  sourcePresetId: string | null;
  targetPresetId: string | null;
  draftRevision: number;
  testCount: number;
  lastMessage: string;
}

export interface PresetCocreatorSession extends PresetCocreatorSessionSummary {
  documentRevision: number;
  targetPresetVersion: string | null;
  document: PresetCocreatorDocument;
  current: PresetDraftRevision;
  history: PresetDraftRevision[];
}

export interface CreatePresetCocreatorSession {
  /** Null/absent starts from WackChatter's built-in default and has no publication target. */
  presetId?: string | null;
  title?: string;
  settings?: Partial<PresetCocreatorSettings>;
}

export interface SavePresetCocreatorDocument {
  expectedRevision: number;
  operationId: string;
  document: PresetCocreatorDocument;
}

export interface RenamePresetCocreatorSessionRequest {
  title: string;
}

export interface PatchPresetDraftRequest {
  expectedRevision: number;
  operationId: string;
  source: 'assistant' | 'manual';
  summary: string;
  turnId?: string | null;
  operations: JsonPatchOperation[];
}

export interface ReplacePresetDraftRequest {
  expectedRevision: number;
  operationId: string;
  summary: string;
  preset: Preset;
}

export interface RestorePresetDraftRequest {
  expectedRevision: number;
  operationId: string;
  revision: number;
  summary?: string;
}

export interface PublishPresetDraftRequest {
  revision: number;
  operationId: string;
  mode: 'update' | 'new' | 'overwrite';
  name?: string;
  expectedPresetVersion?: string | null;
}

export interface PublishPresetDraftResult {
  presetId: string;
  version: string;
  revision: number;
  created: boolean;
}

/**
 * A read-only example preset from `data/reference-presets` — SillyTavern-format JSONs kept
 * out of the live preset list so the Co-Creator assistant can study them without cluttering
 * the user's own presets. The filename is the identity, same as a library preset.
 */
export interface ReferencePresetSummary {
  id: string;
  name: string;
  modified: number;
}

export interface ReferencePresetRecord extends ReferencePresetSummary {
  /** sha256 of the raw file — the read-side analogue of a preset's content version. */
  version: string;
  /** The file normalised for the app/assistant. */
  preset: Preset;
  /** The file exactly as stored — reference files are kept verbatim. */
  raw: string;
}
