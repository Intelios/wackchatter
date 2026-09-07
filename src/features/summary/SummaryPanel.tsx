import type { Connection } from '@shared/providers/types.ts';
import { DEFAULT_SUMMARY_PROMPT, type SummarySettings } from '@shared/types/settings.ts';
import { useEffect, useState } from 'react';
import { SelectField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { Slider } from '../../components/Slider.tsx';
import { StoryMemoryPlacementFields } from '../../components/StoryMemoryPlacementFields.tsx';
import { RefreshIcon, StopIcon } from '../../layout/icons.tsx';
import type { UseChat } from '../chat/useChat.ts';
import './SummaryPanel.css';

interface SummaryPanelProps {
  chat: UseChat;
  settings: SummarySettings;
  connections: Connection[];
  activeConnection: Connection | null;
  summaryConnection: Connection | null;
  onSettingsChange: (patch: Partial<SummarySettings>) => void;
}

export function SummaryPanel({
  chat,
  settings,
  connections,
  activeConnection,
  summaryConnection,
  onSettingsChange,
}: SummaryPanelProps) {
  const [promptDraft, setPromptDraft] = useState(settings.prompt);
  const [templateDraft, setTemplateDraft] = useState(settings.template);
  const { summaryStatus } = chat;
  const summaryText = chat.state.metadata.summary?.text ?? '';

  useEffect(() => setPromptDraft(settings.prompt), [settings.prompt]);
  useEffect(() => setTemplateDraft(settings.template), [settings.template]);

  const disabledReason = !chat.state.chatId
    ? 'Open a chat first.'
    : chat.busy
      ? 'Stop the current reply before summarizing.'
      : !summaryConnection
        ? 'Add a connection first.'
        : !summaryConnection.baseUrl || !summaryConnection.model
          ? 'Configure an endpoint and model for the selected connection.'
          : !promptDraft.trim()
            ? 'Enter a summary prompt first.'
            : chat.summaryPending === 0
              ? 'No new chat messages need summarizing.'
              : undefined;

  return (
    <div className="summary-panel">
      <Section
        title="Current summary"
        badge={chat.summaryPending > 0 ? `${chat.summaryPending} new` : 'up to date'}
        defaultOpen
      >
        <TextField
          label="Story so far"
          value={summaryText}
          onChange={chat.editSummary}
          multiline
          expandable
          rows={10}
          placeholder="The generated summary will appear here. You can also write one yourself."
          hint="Edits become the base for the next update. Clearing this starts again from the full transcript."
          disabled={summaryStatus.running}
        />

        <div className="summary-panel__actions">
          {summaryStatus.running ? (
            <button
              type="button"
              className="wc-button wc-button--danger"
              onClick={chat.cancelSummary}
            >
              <StopIcon />
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="wc-button wc-button--primary"
              onClick={() =>
                void chat.summarize({
                  ...settings,
                  prompt: promptDraft,
                  template: templateDraft,
                })
              }
              disabled={Boolean(disabledReason)}
              title={disabledReason ?? 'Update the rolling story summary'}
            >
              Summarize now
            </button>
          )}
          {summaryStatus.running ? (
            <span className="summary-panel__progress" role="status">
              Summarizing {summaryStatus.processed} of {summaryStatus.total} messages…
            </span>
          ) : summaryStatus.total > 0 && summaryStatus.processed === summaryStatus.total ? (
            <span className="summary-panel__progress" role="status">
              Summary updated through {summaryStatus.total} messages.
            </span>
          ) : null}
        </div>

        {summaryStatus.error ? (
          <p className="summary-panel__error" role="alert">
            {summaryStatus.error}
          </p>
        ) : null}
      </Section>

      <Section title="Generation" defaultOpen>
        <SelectField<string | null>
          label="Summarize with"
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
          disabled={summaryStatus.running}
        />

        <TextField
          label="Summary prompt"
          value={promptDraft}
          onChange={setPromptDraft}
          onCommit={() => onSettingsChange({ prompt: promptDraft })}
          multiline
          expandable
          rows={8}
          hint="Every {{words}} occurrence is replaced with the target length."
          disabled={summaryStatus.running}
        />
        <button
          type="button"
          className="wc-button wc-button--ghost summary-panel__reset"
          disabled={summaryStatus.running || promptDraft === DEFAULT_SUMMARY_PROMPT}
          onClick={() => {
            setPromptDraft(DEFAULT_SUMMARY_PROMPT);
            onSettingsChange({ prompt: DEFAULT_SUMMARY_PROMPT });
          }}
        >
          <RefreshIcon />
          Restore default prompt
        </button>

        <Slider
          label="Target summary length (words)"
          value={settings.targetWords}
          min={25}
          max={1000}
          step={25}
          onChange={(targetWords) => onSettingsChange({ targetWords })}
          disabled={summaryStatus.running}
        />
      </Section>

      <Section title="Injection" defaultOpen>
        <StoryMemoryPlacementFields
          settings={settings}
          onSettingsChange={onSettingsChange}
          templateDraft={templateDraft}
          onTemplateDraftChange={setTemplateDraft}
          onTemplateCommit={() => onSettingsChange({ template: templateDraft })}
          macro="summary"
          disabled={summaryStatus.running}
        />
      </Section>
    </div>
  );
}
