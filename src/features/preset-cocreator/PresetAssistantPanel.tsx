import type { Connection } from '@shared/providers/types.ts';
import { useState } from 'react';
import { Markdown } from '../chat/Markdown.tsx';
import { PresetModelSettings } from './PresetModelSettings.tsx';
import type { PresetCocreatorController } from './usePresetCocreator.ts';

interface PresetAssistantPanelProps {
  controller: PresetCocreatorController;
  connections: readonly Connection[];
}

export function PresetAssistantPanel({ controller, connections }: PresetAssistantPanelProps) {
  const [draft, setDraft] = useState('');
  const [toolCapability, setToolCapability] = useState<boolean | null>(null);
  const settings = controller.session.document.settings;

  const patchSettings = (patch: Partial<typeof settings>) =>
    controller.updateDocument((document) => ({
      ...document,
      settings: { ...document.settings, ...patch },
    }));

  const submit = () => {
    const text = draft.trim();
    if (!text || controller.busy || toolCapability === false) return;
    setDraft('');
    void controller.send(text);
  };

  return (
    <div className="preset-cc-assistant">
      <details className="preset-cc-setup">
        <summary>Assistant model and instructions</summary>
        <div className="preset-cc-setup__body">
          <PresetModelSettings
            label="Co-Creator model"
            value={settings.assistant}
            connections={connections}
            requireTools
            onCapabilityChange={setToolCapability}
            onChange={(assistant) => patchSettings({ assistant })}
          />
          <label className="field">
            <span className="wc-label">Additional instructions</span>
            <textarea
              className="wc-textarea"
              rows={4}
              value={settings.assistantInstructions}
              placeholder="Preferences for this design session…"
              onChange={(event) => patchSettings({ assistantInstructions: event.target.value })}
            />
          </label>
        </div>
      </details>

      <div className="preset-cc-assistant__conversation" aria-live="polite">
        {settings.assistant.connectionId === null ? (
          <div className="wc-empty">
            Choose a native tool-capable model, then describe what you want to improve.
          </div>
        ) : null}
        {controller.session.document.messages.map((message) =>
          message.role === 'tool' ? (
            <details className="preset-cc-tool" key={message.id}>
              <summary>{message.toolName ?? 'Tool result'}</summary>
              <pre>{message.content}</pre>
            </details>
          ) : (
            <article className="preset-cc-message" data-role={message.role} key={message.id}>
              <div className="preset-cc-message__meta">
                {message.role === 'user'
                  ? 'You'
                  : message.role === 'report'
                    ? 'Shared test report'
                    : 'Co-Creator'}
              </div>
              <Markdown text={message.content} className="preset-cc-message__text" />
              {message.reasoning ? (
                <details>
                  <summary>Reasoning</summary>
                  <Markdown text={message.reasoning} className="preset-cc-message__reasoning" />
                </details>
              ) : null}
            </article>
          ),
        )}
        {controller.streamingText || controller.streamingReasoning ? (
          <article className="preset-cc-message" data-role="assistant">
            <div className="preset-cc-message__meta">Co-Creator · responding</div>
            {controller.streamingReasoning ? (
              <details open={!controller.streamingText}>
                <summary>Reasoning</summary>
                <Markdown
                  text={controller.streamingReasoning}
                  className="preset-cc-message__reasoning"
                />
              </details>
            ) : null}
            <Markdown text={controller.streamingText} className="preset-cc-message__text" />
          </article>
        ) : null}
      </div>

      <div className="preset-cc-composer">
        <textarea
          className="wc-textarea"
          rows={3}
          value={draft}
          disabled={controller.busy}
          placeholder="Ask for an improvement, explain a problem, or discuss a shared test…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {controller.busy ? (
          <button type="button" className="wc-button wc-button--danger" onClick={controller.stop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="wc-button wc-button--primary"
            disabled={!draft.trim() || toolCapability === false}
            title={
              toolCapability === false
                ? 'The selected provider reports that this model does not support tools.'
                : undefined
            }
            onClick={submit}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
