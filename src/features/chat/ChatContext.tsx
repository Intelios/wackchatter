/**
 * What this conversation overrides about its character, and the note pushed back into the
 * prompt as it runs.
 *
 * This used to open with a list of the character's chats, above the character browser it
 * was sharing a panel with. That list is gone rather than moved: the start screen already
 * lists every chat with an avatar, a preview and a timestamp, so the per-character copy
 * was a worse version of a list that already existed, sitting on top of the one thing the
 * panel is actually for. Creator notes went with it — `CreatorNotesPopover` puts them on
 * the greeting swiper, at the moment the question is asked.
 *
 * What is left is the part that lives nowhere else. It stays collapsed, because the
 * character list below it is the reason the panel opens; the badge is how a closed section
 * still says something is in play — a note firing every 3 turns and an overridden scenario
 * make a 2 you can read without opening anything.
 */

import {
  type AuthorNotePosition,
  type ChatMetadata,
  DEFAULT_AUTHOR_NOTE,
} from '@shared/types/chat.ts';
import { CheckField, NumberField, SelectField, TextField } from '../../components/Field.tsx';
import './ChatContext.css';

interface ChatContextProps {
  metadata: ChatMetadata;
  inheritedScenario: string;
  onMetadataChange: (patch: Partial<ChatMetadata>) => void;
}

export function ChatContext({ metadata, inheritedScenario, onMetadataChange }: ChatContextProps) {
  const scenarioOverridden = typeof metadata.scenario === 'string';
  const authorNote = { ...DEFAULT_AUTHOR_NOTE, ...metadata.authorNote };
  // A note with no text, or one set to fire every 0 turns, is switched off — neither
  // counts as context in play.
  const noteActive = authorNote.text.trim().length > 0 && authorNote.interval > 0;
  const activeCount = (scenarioOverridden ? 1 : 0) + (noteActive ? 1 : 0);

  function updateAuthorNote(patch: Partial<typeof authorNote>) {
    onMetadataChange({ authorNote: { ...authorNote, ...patch } });
  }

  return (
    <details className="chat-context">
      <summary className="chat-context__summary">
        <span>Chat context</span>
        {activeCount > 0 ? (
          <span
            className="chat-context__badge"
            title={[
              scenarioOverridden ? 'Scenario overridden' : null,
              noteActive ? `Author’s Note every ${authorNote.interval} turns` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            {activeCount}
          </span>
        ) : null}
      </summary>

      <div className="chat-context__body">
        <CheckField
          label="Override character scenario"
          checked={scenarioOverridden}
          onChange={(checked) =>
            onMetadataChange({ scenario: checked ? inheritedScenario : undefined })
          }
          hint="An enabled but empty override deliberately clears the scenario."
        />
        {scenarioOverridden ? (
          <TextField
            label="Scenario for this chat"
            value={metadata.scenario ?? ''}
            onChange={(scenario) => onMetadataChange({ scenario })}
            multiline
            expandable
            rows={4}
            placeholder="Leave empty to clear the character scenario."
          />
        ) : (
          <p className="wc-hint">Inheriting: {inheritedScenario || 'No character scenario'}</p>
        )}

        <TextField
          label="Author’s Note"
          value={authorNote.text}
          onChange={(text) => updateAuthorNote({ text })}
          multiline
          expandable
          rows={4}
          placeholder="A recurring instruction for this chat."
        />
        <div className="field-row">
          <NumberField
            label="Every N user turns"
            value={authorNote.interval}
            min={0}
            step={1}
            onChange={(interval) => updateAuthorNote({ interval: Math.floor(interval) })}
            hint="0 disables the note."
          />
          <SelectField<AuthorNotePosition>
            label="Position"
            value={authorNote.position}
            options={[
              { label: 'Before scenario', value: 'beforeScenario' },
              { label: 'After scenario', value: 'afterScenario' },
              { label: 'At chat depth', value: 'atDepth' },
            ]}
            onChange={(position) => updateAuthorNote({ position })}
          />
        </div>
        {authorNote.position === 'atDepth' ? (
          <NumberField
            label="Depth"
            value={authorNote.depth}
            min={0}
            step={1}
            onChange={(depth) => updateAuthorNote({ depth: Math.floor(depth) })}
            hint="Messages back from the end."
          />
        ) : null}
        <SelectField<'system' | 'user' | 'assistant'>
          label="Role"
          value={authorNote.role}
          options={[
            { label: 'System', value: 'system' },
            { label: 'User', value: 'user' },
            { label: 'Assistant', value: 'assistant' },
          ]}
          onChange={(role) => updateAuthorNote({ role })}
        />
      </div>
    </details>
  );
}
