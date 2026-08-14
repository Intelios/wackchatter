import type { CharacterSummary } from '@shared/types/card.ts';
import type { ExampleFields, ExampleSet } from '@shared/types/cocreator.ts';
import { useMemo, useState } from 'react';
import { Popover } from '../../components/Popover.tsx';
import { EditIcon, LayersIcon, PlusIcon, TrashIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { addExampleSet, removeExampleSet, updateExampleSet } from './exampleSets.ts';

interface ExampleSetsPopoverProps {
  sets: readonly ExampleSet[];
  currentCards: readonly string[];
  currentFields: ExampleFields;
  characters: readonly CharacterSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplySet: (set: ExampleSet) => void;
  onSetsChange: (sets: ExampleSet[]) => void;
  disabled?: boolean;
}

export function ExampleSetsPopover({
  sets,
  currentCards,
  currentFields,
  characters,
  open,
  onOpenChange,
  onApplySet,
  onSetsChange,
  disabled = false,
}: ExampleSetsPopoverProps) {
  const [nameDraft, setNameDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNameDraft, setEditNameDraft] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const byAvatar = useMemo(() => {
    const map = new Map<string, CharacterSummary>();
    for (const character of characters) map.set(character.avatar, character);
    return map;
  }, [characters]);

  const handleSaveCurrent = () => {
    if (currentCards.length === 0 || disabled) return;
    const next = addExampleSet(sets, nameDraft, currentCards, currentFields);
    onSetsChange(next);
    setNameDraft('');
  };

  const handleStartRename = (set: ExampleSet) => {
    setEditingId(set.id);
    setEditNameDraft(set.name);
  };

  const handleCommitRename = (id: string) => {
    if (editNameDraft.trim()) {
      onSetsChange(updateExampleSet(sets, id, { name: editNameDraft.trim() }));
    }
    setEditingId(null);
    setEditNameDraft('');
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setConfirmingDelete(null);
          setEditingId(null);
        }
      }}
      label="Example sets"
      placement="bottom-start"
      role="dialog"
      icon={<LayersIcon />}
      className="examples-panel__sets-trigger"
      popupClassName="example-sets__popup"
    >
      <div className="example-sets" onPointerDown={(event) => event.stopPropagation()}>
        <div className="example-sets__header">
          <h3>Example sets</h3>
          <p className="example-sets__hint">
            Save and reuse your favourite benchmark cards and field selections across sessions.
          </p>
        </div>

        <div className="example-sets__save-section">
          <span className="example-sets__section-label">Save current selection</span>
          <div className="example-sets__save-form">
            <input
              type="text"
              className="wc-input example-sets__save-input"
              value={nameDraft}
              placeholder={currentCards.length ? 'Set name (optional)…' : 'Attach cards first…'}
              disabled={disabled || currentCards.length === 0}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleSaveCurrent();
                }
              }}
            />
            <button
              type="button"
              className="wc-button wc-button--primary example-sets__save-btn"
              disabled={disabled || currentCards.length === 0}
              onClick={handleSaveCurrent}
              title={
                currentCards.length === 0
                  ? 'Attach example cards to save them as a set'
                  : 'Save current cards and field toggles'
              }
            >
              <PlusIcon />
              Save set
            </button>
          </div>
          {currentCards.length > 0 ? (
            <p className="example-sets__save-meta">
              {currentCards.length} {currentCards.length === 1 ? 'card' : 'cards'} selected
            </p>
          ) : null}
        </div>

        <div className="example-sets__list-section">
          <span className="example-sets__section-label">Saved sets</span>
          {sets.length === 0 ? (
            <p className="wc-empty example-sets__empty">No saved sets yet.</p>
          ) : (
            <div className="example-sets__list">
              {sets.map((set) => {
                const isEditing = editingId === set.id;
                const isConfirming = confirmingDelete === set.id;
                return (
                  <div key={set.id} className="example-set-item">
                    <div className="example-set-item__head">
                      {isEditing ? (
                        <div className="example-set-item__rename-form">
                          <input
                            // biome-ignore lint/a11y/noAutofocus: user just clicked rename
                            autoFocus
                            type="text"
                            className="wc-input example-set-item__rename-input"
                            value={editNameDraft}
                            onChange={(e) => setEditNameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                handleCommitRename(set.id);
                              } else if (e.key === 'Escape') {
                                setEditingId(null);
                              }
                            }}
                            onBlur={() => handleCommitRename(set.id)}
                          />
                        </div>
                      ) : (
                        <div className="example-set-item__title-row">
                          <strong className="example-set-item__name">{set.name}</strong>
                          <span className="example-set-item__count">
                            {set.cards.length} {set.cards.length === 1 ? 'card' : 'cards'}
                          </span>
                        </div>
                      )}

                      <div className="example-set-item__actions">
                        <button
                          type="button"
                          className="wc-button wc-button--ghost example-set-item__edit"
                          onClick={() =>
                            isEditing ? handleCommitRename(set.id) : handleStartRename(set)
                          }
                          title="Rename set"
                          disabled={disabled}
                        >
                          <EditIcon />
                        </button>
                        <button
                          type="button"
                          className="wc-button wc-button--ghost wc-button--danger example-set-item__delete"
                          data-confirming={isConfirming || undefined}
                          onClick={() => {
                            if (isConfirming) {
                              onSetsChange(removeExampleSet(sets, set.id));
                              setConfirmingDelete(null);
                            } else {
                              setConfirmingDelete(set.id);
                            }
                          }}
                          onBlur={() =>
                            setConfirmingDelete((current) => (current === set.id ? null : current))
                          }
                          title={isConfirming ? 'Click again to delete' : 'Delete set'}
                          disabled={disabled}
                        >
                          {isConfirming ? 'Sure?' : <TrashIcon />}
                        </button>
                      </div>
                    </div>

                    {set.cards.length > 0 ? (
                      <div className="example-set-item__cards-preview">
                        {set.cards.slice(0, 6).map((avatar) => {
                          const summary = byAvatar.get(avatar);
                          return (
                            <img
                              key={avatar}
                              className="example-set-item__thumb"
                              src={characterApi.imageUrl(avatar, summary?.modified)}
                              alt={summary?.name ?? avatar}
                              title={summary?.name ?? avatar}
                            />
                          );
                        })}
                        {set.cards.length > 6 ? (
                          <span className="example-set-item__more-cards">
                            +{set.cards.length - 6}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="example-set-item__no-cards">No cards in set</span>
                    )}

                    <div className="example-set-item__footer">
                      <button
                        type="button"
                        className="wc-button wc-button--secondary example-set-item__apply"
                        onClick={() => {
                          onApplySet(set);
                          onOpenChange(false);
                        }}
                        disabled={disabled}
                        title="Replace current attached examples and fields with this set"
                      >
                        Apply set
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Popover>
  );
}
