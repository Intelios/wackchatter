import { getPromptById, updatePrompt } from '@shared/prompt/preset-io.ts';
import type { GenerationType, Preset, PromptRole } from '@shared/types/preset.ts';
import {
  DEFAULT_INJECTION_DEPTH,
  DEFAULT_INJECTION_ORDER,
  INJECTION_POSITION,
  isBuiltinIdentifier,
  isMarkerIdentifier,
  OVERRIDABLE_IDENTIFIERS,
} from '@shared/types/preset.ts';
import { useState } from 'react';
import { TextField } from '../../components/Field.tsx';
import './PromptEditor.css';

interface PromptEditorProps {
  preset: Preset;
  identifier: string;
  onChange: (preset: Preset) => void;
  onClose: () => void;
  onDelete: (identifier: string) => void;
}

const ROLES: PromptRole[] = ['system', 'user', 'assistant'];
const TRIGGERS: Array<{ value: GenerationType; label: string; unavailable?: boolean }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'continue', label: 'Continue' },
  { value: 'swipe', label: 'Swipe' },
  { value: 'regenerate', label: 'Regenerate' },
  { value: 'impersonate', label: 'Impersonate', unavailable: true },
  { value: 'quiet', label: 'Quiet', unavailable: true },
];

export function PromptEditor({
  preset,
  identifier,
  onChange,
  onClose,
  onDelete,
}: PromptEditorProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const prompt = getPromptById(preset, identifier);
  if (!prompt) return null;

  const isMarker = isMarkerIdentifier(identifier);
  const isAbsolute = prompt.injection_position === INJECTION_POSITION.ABSOLUTE;
  const isOverridable = (OVERRIDABLE_IDENTIFIERS as readonly string[]).includes(identifier);
  const isBuiltin = isBuiltinIdentifier(identifier);

  function set<K extends string>(key: K, value: unknown) {
    onChange(updatePrompt(preset, identifier, { [key]: value }));
  }

  function toggleTrigger(trigger: GenerationType, enabled: boolean) {
    const current = getPromptById(preset, identifier)?.injection_trigger ?? [];
    set(
      'injection_trigger',
      enabled ? [...new Set([...current, trigger])] : current.filter((item) => item !== trigger),
    );
  }

  return (
    <div className="prompt-editor">
      <div className="prompt-editor__head">
        <button type="button" className="wc-button wc-button--ghost" onClick={onClose}>
          ← All prompts
        </button>
        <h3 className="prompt-editor__title">{prompt.name}</h3>
      </div>

      <div className="prompt-editor__body">
        {!prompt.system_prompt ? (
          <TextField label="Name" value={prompt.name} onChange={(v) => set('name', v)} />
        ) : null}

        <div className="prompt-editor__row">
          <div className="field">
            <label className="wc-label" htmlFor={`${identifier}-role`}>
              Role
            </label>
            <select
              id={`${identifier}-role`}
              className="wc-select"
              value={prompt.role ?? 'system'}
              onChange={(e) => set('role', e.target.value)}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="wc-label" htmlFor={`${identifier}-position`}>
              Position
            </label>
            <select
              id={`${identifier}-position`}
              className="wc-select"
              value={isAbsolute ? 'absolute' : 'relative'}
              onChange={(e) =>
                set(
                  'injection_position',
                  e.target.value === 'absolute'
                    ? INJECTION_POSITION.ABSOLUTE
                    : INJECTION_POSITION.RELATIVE,
                )
              }
            >
              <option value="relative">In order</option>
              <option value="absolute">In chat @ depth</option>
            </select>
          </div>
        </div>

        {isAbsolute ? (
          <div className="prompt-editor__row">
            <div className="field">
              <label className="wc-label" htmlFor={`${identifier}-depth`}>
                Depth
              </label>
              <input
                id={`${identifier}-depth`}
                className="wc-input"
                type="number"
                min={0}
                value={prompt.injection_depth ?? DEFAULT_INJECTION_DEPTH}
                onChange={(e) => set('injection_depth', Number(e.target.value))}
              />
              <p className="wc-hint">0 = after the last message.</p>
            </div>

            <div className="field">
              <label className="wc-label" htmlFor={`${identifier}-order`}>
                Order
              </label>
              <input
                id={`${identifier}-order`}
                className="wc-input"
                type="number"
                value={prompt.injection_order ?? DEFAULT_INJECTION_ORDER}
                onChange={(e) => set('injection_order', Number(e.target.value))}
              />
              <p className="wc-hint">Higher goes first at the same depth.</p>
            </div>
          </div>
        ) : null}

        <fieldset className="prompt-editor__triggers">
          <legend className="wc-label">Generation triggers</legend>
          <p className="wc-hint">No selection means the prompt is always active.</p>
          {TRIGGERS.map((trigger) => (
            <label key={trigger.value} className="prompt-editor__check">
              <input
                type="checkbox"
                checked={prompt.injection_trigger?.includes(trigger.value) ?? false}
                onChange={(event) => toggleTrigger(trigger.value, event.target.checked)}
              />
              <span>
                {trigger.label}
                {trigger.unavailable ? (
                  <span className="wc-hint">Preserved for ST; this mode is not available yet.</span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>

        {isMarker ? (
          <p className="prompt-editor__note">
            This is a marker. Its content is generated at send time from the character, chat or
            world info — position and role are yours to change, the text is not.
          </p>
        ) : (
          <TextField
            label="Content"
            value={prompt.content ?? ''}
            onChange={(v) => set('content', v)}
            multiline
            rows={12}
            hint="Supports {{char}}, {{user}}, {{persona}} and the rest of the macro set."
          />
        )}

        {isOverridable ? (
          <label className="prompt-editor__check">
            <input
              type="checkbox"
              checked={Boolean(prompt.forbid_overrides)}
              onChange={(e) => set('forbid_overrides', e.target.checked)}
            />
            <span>
              Forbid character card overrides
              <span className="wc-hint">
                Stops a card's own{' '}
                {identifier === 'main' ? 'system prompt' : 'post-history instructions'} from
                replacing this.
              </span>
            </span>
          </label>
        ) : null}

        {!isBuiltin ? (
          <button
            type="button"
            className="wc-button wc-button--ghost wc-button--danger"
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              onDelete(identifier);
            }}
            onBlur={() => setConfirmDelete(false)}
          >
            {confirmDelete ? 'Click again to delete' : 'Delete custom prompt'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
