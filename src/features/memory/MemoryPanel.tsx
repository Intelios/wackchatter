import type { Connection } from '@shared/providers/types.ts';
import type { Memory } from '@shared/types/chat.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import {
  DEFAULT_MEMORY_PROMPT,
  type MemoryMode,
  type MemorySettings,
  type SummaryPosition,
  type SummarySettings,
} from '@shared/types/settings.ts';
import { useEffect, useState } from 'react';
import { CheckField, NumberField, SelectField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { PlusIcon, RefreshIcon, StopIcon } from '../../layout/icons.tsx';
import type { UseChat } from '../chat/useChat.ts';
import { SummaryPanel } from '../summary/SummaryPanel.tsx';
import { MemoryCard } from './MemoryCard.tsx';
import './MemoryPanel.css';

interface MemoryPanelProps {
  chat: UseChat;
  mode: MemoryMode;
  onModeChange: (mode: MemoryMode) => void;
  settings: MemorySettings;
  onSettingsChange: (patch: Partial<MemorySettings>) => void;
  summarySettings: SummarySettings;
  onSummarySettingsChange: (patch: Partial<SummarySettings>) => void;
  connections: Connection[];
  activeConnection: Connection | null;
  summaryConnection: Connection | null;
  memoryConnection: Connection | null;
  presets: PresetSummary[];
  activePresetId: string | null;
}

const MODES: { id: MemoryMode; label: string; hint: string }[] = [
  { id: 'classic', label: 'Summary', hint: 'One rolling block of prose, as before.' },
  { id: 'memories', label: 'Memories', hint: 'Individual scenes, recalled by keyword.' },
  { id: 'off', label: 'Off', hint: 'Neither reaches the model.' },
];

export function MemoryPanel(props: MemoryPanelProps) {
  const { chat, mode, onModeChange, settings, onSettingsChange, presets, activePresetId } = props;

  return (
    <div className="memory-panel">
      <fieldset className="memory-panel__modes">
        <legend className="wc-visually-hidden">Story memory</legend>
        {MODES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="memory-panel__mode"
            data-active={mode === entry.id || undefined}
            onClick={() => onModeChange(entry.id)}
            title={entry.hint}
          >
            {entry.label}
          </button>
        ))}
      </fieldset>

      {mode === 'classic' ? (
        <SummaryPanel
          chat={chat}
          settings={props.summarySettings}
          connections={props.connections}
          activeConnection={props.activeConnection}
          summaryConnection={props.summaryConnection}
          onSettingsChange={props.onSummarySettingsChange}
        />
      ) : (
        <MemoriesBody
          chat={chat}
          mode={mode}
          settings={settings}
          onSettingsChange={onSettingsChange}
          connections={props.connections}
          activeConnection={props.activeConnection}
          memoryConnection={props.memoryConnection}
          presets={presets}
          activePresetId={activePresetId}
        />
      )}
    </div>
  );
}

interface MemoriesBodyProps {
  chat: UseChat;
  mode: MemoryMode;
  settings: MemorySettings;
  onSettingsChange: (patch: Partial<MemorySettings>) => void;
  connections: Connection[];
  activeConnection: Connection | null;
  memoryConnection: Connection | null;
  presets: PresetSummary[];
  activePresetId: string | null;
}

function MemoriesBody({
  chat,
  mode,
  settings,
  onSettingsChange,
  connections,
  activeConnection,
  memoryConnection,
  presets,
  activePresetId,
}: MemoriesBodyProps) {
  const [promptDraft, setPromptDraft] = useState(settings.extractPrompt);
  const [templateDraft, setTemplateDraft] = useState(settings.template);
  useEffect(() => setPromptDraft(settings.extractPrompt), [settings.extractPrompt]);
  useEffect(() => setTemplateDraft(settings.template), [settings.template]);

  const { memoryStatus, memoryPending } = chat;
  const memories = chat.state.metadata.memories ?? [];
  const running = memoryStatus.running;

  const disabledReason = !chat.state.chatId
    ? 'Open a chat first.'
    : chat.busy
      ? 'Stop the current reply before extracting memories.'
      : !memoryConnection
        ? 'Add a connection first.'
        : !memoryConnection.baseUrl || !memoryConnection.model
          ? 'Configure an endpoint and model for the selected connection.'
          : !promptDraft.trim()
            ? 'Enter an extraction prompt first.'
            : memoryPending === 0
              ? 'No new chat messages need remembering.'
              : undefined;

  function updateMemory(id: string, patch: Partial<Memory>) {
    chat.setMemories(
      memories.map((memory) => (memory.id === id ? { ...memory, ...patch } : memory)),
    );
  }

  function addManualMemory() {
    chat.setMemories([
      ...memories,
      {
        id: crypto.randomUUID(),
        title: 'New memory',
        text: '',
        keywords: [],
        pinned: true,
        enabled: true,
        source: 'manual',
        edited: false,
        generatedAt: Date.now(),
      },
    ]);
  }

  return (
    <>
      <Section
        title="Memories"
        badge={memories.length ? `${memories.length}` : 'none yet'}
        defaultOpen
      >
        {mode === 'off' ? (
          <p className="memory-panel__notice">
            Memories are switched off, so none of these reach the model. They are kept, and
            switching back to Memories restores them.
          </p>
        ) : null}

        {memories.length === 0 ? (
          <p className="memory-panel__empty">
            No memories yet. Extract them from the transcript below, or write one yourself.
          </p>
        ) : (
          <ul className="memory-panel__list">
            {memories.map((memory) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                hiddenCount={chat.memoryHiddenCount(memory.id)}
                coveredCount={coveredNow(chat, memory)}
                onChange={(patch) => updateMemory(memory.id, patch)}
                onDelete={() => chat.deleteMemory(memory.id)}
                onSetHidden={(hidden) => chat.setMemoryHidden(memory.id, hidden)}
                disabled={running}
              />
            ))}
          </ul>
        )}

        <div className="memory-panel__actions">
          {running ? (
            <button
              type="button"
              className="wc-button wc-button--danger"
              onClick={chat.cancelMemoryRun}
            >
              <StopIcon />
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="wc-button wc-button--primary"
              onClick={() => void chat.extractMemories({ extractPrompt: promptDraft })}
              disabled={Boolean(disabledReason)}
              title={disabledReason ?? 'Write memories for everything not yet remembered'}
            >
              Extract memories
            </button>
          )}
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={addManualMemory}
            disabled={running || !chat.state.chatId}
            title="Add a memory in your own words. It covers no messages, so it hides nothing."
          >
            <PlusIcon />
            Write one
          </button>
        </div>

        {running ? (
          <span className="memory-panel__progress" role="status">
            Reading {memoryStatus.processed} of {memoryStatus.total} messages…
          </span>
        ) : memoryPending > 0 ? (
          <span className="memory-panel__progress" role="status">
            {memoryPending} message{memoryPending === 1 ? '' : 's'} not yet remembered.
            {mode === 'memories' && settings.autoInterval > 0
              ? ` Auto-extracts at ${settings.autoInterval}.`
              : ''}
          </span>
        ) : null}

        {memoryStatus.error ? (
          <p className="memory-panel__error" role="alert">
            {memoryStatus.error}
          </p>
        ) : null}
      </Section>

      <Section title="Extraction">
        <SelectField<string | null>
          label="Write memories with"
          value={settings.connectionId}
          options={[
            {
              label: activeConnection
                ? `Same as chat connection (${activeConnection.name})`
                : 'Same as chat connection',
              value: null,
            },
            ...connections.map((connection) => ({ label: connection.name, value: connection.id })),
          ]}
          onChange={(connectionId) => onSettingsChange({ connectionId })}
          disabled={running}
        />
        <SelectField<string | null>
          label="Samplers from"
          value={settings.presetId}
          options={[
            { label: 'Same as chat preset', value: null },
            ...presets.map((entry) => ({
              label: entry.id === activePresetId ? `${entry.name} (active)` : entry.name,
              value: entry.id,
            })),
          ]}
          onChange={(presetId) => onSettingsChange({ presetId })}
          disabled={running}
        />
        <p className="memory-panel__note">
          Only temperature and the other samplers are taken from that preset. Its prompts, main or
          jailbreak, are never sent — the extractor sees the transcript, the character, your persona
          and the memories already written, and nothing else.
        </p>

        <TextField
          label="Extraction prompt"
          value={promptDraft}
          onChange={setPromptDraft}
          onCommit={() => onSettingsChange({ extractPrompt: promptDraft })}
          multiline
          expandable
          rows={8}
          hint="Style guidance only. The JSON the model has to reply with is added automatically and cannot be broken from here."
          disabled={running}
        />
        <button
          type="button"
          className="wc-button wc-button--ghost memory-panel__reset"
          disabled={running || promptDraft === DEFAULT_MEMORY_PROMPT}
          onClick={() => {
            setPromptDraft(DEFAULT_MEMORY_PROMPT);
            onSettingsChange({ extractPrompt: DEFAULT_MEMORY_PROMPT });
          }}
        >
          <RefreshIcon />
          Restore default prompt
        </button>

        <NumberField
          label="Messages per pass"
          value={settings.windowSize}
          min={5}
          max={200}
          step={5}
          onChange={(windowSize) => onSettingsChange({ windowSize })}
          hint="How much transcript the model reads at once. Larger passes see whole scenes; smaller ones cost less per request."
          disabled={running}
        />
        <NumberField
          label="Auto-extract every"
          value={settings.autoInterval}
          min={0}
          max={2000}
          step={10}
          onChange={(autoInterval) => onSettingsChange({ autoInterval })}
          hint="Runs extraction automatically once this many messages are waiting, after a reply settles. 0 turns it off. Only runs while the mode is Memories."
          disabled={running || mode !== 'memories'}
        />
        <NumberField
          label="Reply budget (tokens)"
          value={settings.maxMemoryTokens}
          min={100}
          max={4000}
          step={100}
          onChange={(maxMemoryTokens) => onSettingsChange({ maxMemoryTokens })}
          hint="Several memories have to fit in this."
          disabled={running}
        />
      </Section>

      <Section title="Hiding">
        <CheckField
          label="Hide messages a memory covers"
          checked={settings.autoHide}
          onChange={(autoHide) => onSettingsChange({ autoHide })}
          hint="Off by default. Hidden messages stay readable here and come back if you delete the memory."
          disabled={running}
        />
        <NumberField
          label="Always keep the last"
          value={settings.verbatimTail}
          min={0}
          max={200}
          step={5}
          onChange={(verbatimTail) => onSettingsChange({ verbatimTail })}
          hint="Messages at the live end of the chat that are never hidden, whatever a memory covers."
          disabled={running || !settings.autoHide}
        />
      </Section>

      <Section title="Injection">
        <TextField
          label="Injection template"
          value={templateDraft}
          onChange={setTemplateDraft}
          onCommit={() => onSettingsChange({ template: templateDraft })}
          multiline
          expandable
          rows={3}
          hint="{{memories}} resolves to the recalled memories without re-running macros inside them."
          disabled={running}
        />
        <NumberField
          label="Recall budget (tokens)"
          value={settings.budgetTokens}
          min={0}
          max={32000}
          step={100}
          onChange={(budgetTokens) => onSettingsChange({ budgetTokens })}
          hint="Separate from the World Info budget, so memories cannot crowd out your lorebooks."
          disabled={running}
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
          disabled={running}
        />
        {settings.position === 'atDepth' ? (
          <NumberField
            label="Depth"
            value={settings.depth}
            min={0}
            step={1}
            onChange={(depth) => onSettingsChange({ depth: Math.max(0, Math.floor(depth)) })}
            hint="Messages back from the end; 0 places it after the latest message."
            disabled={running}
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
          disabled={running}
        />
      </Section>
    </>
  );
}

/** Messages this memory covers that it is not already hiding. */
function coveredNow(chat: UseChat, memory: Memory): number {
  if (!memory.range) return 0;
  const start = chat.messages.findIndex((message) => message.id === memory.range!.startId);
  const end = chat.messages.findIndex((message) => message.id === memory.range!.endId);
  if (start === -1 || end === -1 || end < start) return 0;
  return chat.messages.slice(start, end + 1).filter((message) => message.hiddenBy !== memory.id)
    .length;
}
