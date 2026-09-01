/**
 * Persistent guides — standing instructions that sit in every prompt for this chat.
 *
 * Lives in the composer rather than a settings panel because that is where it is used: a
 * guide is written mid-scene, in reaction to a reply that missed, and a trip to another
 * column to fix it is a trip most people will not make.
 *
 * The list edits are in `guides.ts`, so what remains here is markup and one confirm.
 */

import type { PersistentGuide } from '@shared/types/chat.ts';
import { DEFAULT_GUIDANCE, type GuidanceSettings } from '@shared/types/settings.ts';
import { useState } from 'react';
import { NumberField, SelectField, TextField } from '../../components/Field.tsx';
import { Popover } from '../../components/Popover.tsx';
import { Section } from '../../components/Section.tsx';
import { BookIcon, PlusIcon, TrashIcon } from '../../layout/icons.tsx';
import { addGuide, countEnabledGuides, removeGuide, updateGuide } from './guides.ts';
import './GuidesPopover.css';

const ROLE_OPTIONS = [
  { label: 'System', value: 'system' as const },
  { label: 'User', value: 'user' as const },
  { label: 'Assistant', value: 'assistant' as const },
];

interface GuidesPopoverProps {
  guides: PersistentGuide[];
  onGuidesChange: (guides: PersistentGuide[]) => void;
  guidance: GuidanceSettings;
  onGuidanceChange: (patch: Partial<GuidanceSettings>) => void;
  /** No open chat means nowhere to store a guide. */
  disabled?: boolean;
}

export function GuidesPopover({
  guides,
  onGuidesChange,
  guidance,
  onGuidanceChange,
  disabled,
}: GuidesPopoverProps) {
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const active = countEnabledGuides(guides);

  return (
    <Popover
      label={active > 0 ? `Persistent guides — ${active} shaping every reply` : 'Persistent guides'}
      icon={<BookIcon />}
      // The only signal that something invisible is steering every reply. Without it a
      // guide written an hour ago silently explains a character who stopped sounding right.
      badge={active > 0 ? <span className="popover__badge">{active}</span> : undefined}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfirmingDelete(null);
      }}
      popupClassName="guides"
      placement="top-start"
      disabled={disabled}
      disabledReason="Open a chat first — guides are stored with the chat."
    >
      <div className="guides__head">
        <h2 className="guides__title">Persistent guides</h2>
        <p className="guides__hint">
          Standing instructions the model sees on every reply in this chat. Not a message — nobody
          has to read them back.
        </p>
      </div>

      {guides.length === 0 ? (
        <p className="guides__empty">
          No guides yet. Try “{'{{char}}'} is rude and selfish — show it in their dialogue.”
        </p>
      ) : (
        <ul className="guides__list">
          {guides.map((guide) => (
            <li className="guide" key={guide.id} data-off={!guide.enabled || undefined}>
              <div className="guide__row">
                <label className="guide__toggle">
                  <input
                    type="checkbox"
                    checked={guide.enabled}
                    onChange={(event) =>
                      onGuidesChange(
                        updateGuide(guides, guide.id, { enabled: event.target.checked }),
                      )
                    }
                  />
                  <span className="wc-visually-hidden">Enable {guide.name}</span>
                </label>

                <input
                  className="wc-input guide__name"
                  value={guide.name}
                  aria-label="Guide name"
                  onChange={(event) =>
                    onGuidesChange(updateGuide(guides, guide.id, { name: event.target.value }))
                  }
                />

                {/* Two-click confirm in place, not a dialog: the chat stays live. */}
                <button
                  type="button"
                  className="wc-button wc-button--ghost guide__delete"
                  data-confirming={confirmingDelete === guide.id || undefined}
                  onClick={() => {
                    if (confirmingDelete === guide.id) {
                      onGuidesChange(removeGuide(guides, guide.id));
                      setConfirmingDelete(null);
                    } else {
                      setConfirmingDelete(guide.id);
                    }
                  }}
                  onBlur={() => setConfirmingDelete((id) => (id === guide.id ? null : id))}
                  title={confirmingDelete === guide.id ? 'Click again to delete' : 'Delete guide'}
                >
                  {confirmingDelete === guide.id ? 'Sure?' : <TrashIcon />}
                </button>
              </div>

              <textarea
                className="wc-input guide__text"
                value={guide.text}
                rows={3}
                aria-label={`${guide.name} text`}
                placeholder="What should always be true of the replies?"
                onChange={(event) =>
                  onGuidesChange(updateGuide(guides, guide.id, { text: event.target.value }))
                }
              />
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="wc-button guides__add"
        onClick={() => onGuidesChange(addGuide(guides, crypto.randomUUID()))}
      >
        <PlusIcon />
        Add guide
      </button>

      {/*
       * The app-wide knobs live here, with the feature, rather than in a settings panel —
       * the same call LorePanel makes for the global World Info settings.
       */}
      <Section title="Guidance settings">
        <TextField
          label="Guidance template"
          value={guidance.template}
          multiline
          rows={3}
          onChange={(template) => onGuidanceChange({ template })}
          macros
          hint="{{input}} is replaced with what you typed. Type {{ for the rest of the macros."
        />
        <div className="guides__row">
          <NumberField
            label="Guidance depth"
            value={guidance.depth}
            min={0}
            onChange={(depth) => onGuidanceChange({ depth })}
            hint="0 places it after the last message."
          />
          <SelectField
            label="Guidance role"
            value={guidance.role}
            options={ROLE_OPTIONS}
            onChange={(role) => onGuidanceChange({ role })}
          />
        </div>
        <div className="guides__row">
          <NumberField
            label="Guide depth"
            value={guidance.guideDepth}
            min={0}
            onChange={(guideDepth) => onGuidanceChange({ guideDepth })}
            hint="Shared by every guide."
          />
          <SelectField
            label="Guide role"
            value={guidance.guideRole}
            options={ROLE_OPTIONS}
            onChange={(guideRole) => onGuidanceChange({ guideRole })}
          />
        </div>
        <button
          type="button"
          className="wc-button guides__reset"
          onClick={() => onGuidanceChange({ ...DEFAULT_GUIDANCE })}
        >
          Reset to defaults
        </button>
      </Section>
    </Popover>
  );
}
