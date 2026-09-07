import type { Connection } from '@shared/providers/types.ts';
import type { MemoryMode, SummarySettings } from '@shared/types/settings.ts';
import { Section } from '../../components/Section.tsx';
import type { UseChat } from '../chat/useChat.ts';
import { NexusActivity } from '../nexus/NexusActivity.tsx';
import { NexusSettings, type NexusSettingsProps } from '../nexus/NexusSettings.tsx';
import { SummaryPanel } from '../summary/SummaryPanel.tsx';
import './MemoryPanel.css';

interface Props extends NexusSettingsProps {
  chat: UseChat;
  mode: MemoryMode;
  onModeChange: (mode: 'classic' | 'nexus' | 'off') => void;
  defaultMode: MemoryMode;
  onDefaultChange: (mode: MemoryMode) => void;
  summarySettings: SummarySettings;
  onSummarySettingsChange: (patch: Partial<SummarySettings>) => void;
  activeConnection: Connection | null;
  summaryConnection: Connection | null;
}
export function MemoryPanel(props: Props) {
  const { chat, mode, onModeChange } = props;
  const chatOpen = chat.state.chatId !== null;
  return (
    <div className="memory-panel">
      <fieldset
        className="memory-panel__modes"
        disabled={!chatOpen}
        title={chatOpen ? undefined : 'Open a chat to choose its memory mode'}
      >
        <legend className="wc-visually-hidden">Story memory for this chat</legend>
        {(['classic', 'nexus', 'off'] as const).map((id) => (
          <button
            key={id}
            type="button"
            className="memory-panel__mode"
            data-active={mode === id || undefined}
            onClick={() => onModeChange(id)}
          >
            {id === 'classic' ? 'Summary' : id === 'nexus' ? 'Nexus' : 'Off'}
          </button>
        ))}
      </fieldset>
      {!chatOpen ? (
        <p className="memory-panel__note">Open a chat to choose its memory mode.</p>
      ) : null}
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
        <Section title="Memory Nexus" defaultOpen>
          <p>
            {mode === 'off'
              ? 'Story memory is off. Stored knowledge remains available.'
              : 'Connected story knowledge, with sources you can inspect and correct.'}
          </p>
          <button
            type="button"
            className="wc-button wc-button--primary"
            disabled={!chatOpen}
            title={chatOpen ? undefined : 'Open a chat first — its Nexus is stored with the chat.'}
            onClick={() => chat.nexus.show()}
          >
            Explore Nexus
          </button>
          <NexusActivity
            chat={chat}
            configured={Boolean(
              props.connections.some((c) => c.id === props.settings.connectionId) &&
                props.settings.model,
            )}
          />
        </Section>
      )}
      <Section title="Nexus settings">
        <NexusSettings
          settings={props.settings}
          connections={props.connections}
          onSettingsChange={props.onSettingsChange}
        />
      </Section>
      <Section title="New chats">
        <label>
          Default story memory{' '}
          <select
            className="wc-input"
            value={props.defaultMode === 'memories' ? 'nexus' : props.defaultMode}
            onChange={(e) => props.onDefaultChange(e.target.value as MemoryMode)}
          >
            <option value="classic">Summary</option>
            <option value="nexus">Nexus</option>
            <option value="off">Off</option>
          </select>
        </label>
        <p>Applies when a chat is created. Existing chats keep their own mode.</p>
      </Section>
    </div>
  );
}
