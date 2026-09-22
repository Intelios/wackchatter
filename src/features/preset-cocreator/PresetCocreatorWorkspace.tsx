import type { Connection } from '@shared/providers/types.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { MacroVariableMap, Persona } from '@shared/types/chat.ts';
import type { PresetCocreatorSession } from '@shared/types/preset-cocreator.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { LorebookSummary, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ApiError, presetApi } from '../../lib/api.ts';
import type { PersistenceControls } from '../../lib/autosave.ts';
import { PresetAssistantPanel } from './PresetAssistantPanel.tsx';
import { PresetDraftEditor } from './PresetDraftEditor.tsx';
import { PresetHistoryPanel } from './PresetHistoryPanel.tsx';
import { PresetTestingPanel } from './PresetTestingPanel.tsx';
import { usePresetCocreator } from './usePresetCocreator.ts';
import { usePresetTesting } from './usePresetTesting.ts';

interface PresetCocreatorWorkspaceProps {
  initial: PresetCocreatorSession;
  connections: readonly Connection[];
  characters: readonly CharacterSummary[];
  personas: readonly Persona[];
  books: readonly LorebookSummary[];
  initialCharacterId?: string | null;
  initialPersonaId?: string | null;
  globalLorebookIds: readonly string[];
  worldInfoSettings: WorldInfoSettings;
  globalVariables: MacroVariableMap;
  regexScripts: readonly RegexScript[];
  tokenizerEncoding?: string;
  streamingFps: number;
  registerPersistence: (controls: PersistenceControls | null) => void;
  onBack: () => Promise<void>;
  onPublished: (presetId: string, version: string) => void;
}

export function PresetCocreatorWorkspace(props: PresetCocreatorWorkspaceProps) {
  const controller = usePresetCocreator({
    initial: props.initial,
    connections: props.connections,
    streamingFps: props.streamingFps,
  });
  const testing = usePresetTesting({
    controller,
    connections: props.connections,
    tokenizerEncoding: props.tokenizerEncoding,
  });
  const [tab, setTab] = useState<'conversation' | 'preset' | 'history'>('conversation');
  const [split, setSplit] = useState(50);
  const [title, setTitle] = useState(controller.session.title);
  const [publishError, setPublishError] = useState('');
  const [conflictVersion, setConflictVersion] = useState<string | null>(null);
  const [conflictPresetJson, setConflictPresetJson] = useState('');
  const [conflictCanOverwrite, setConflictCanOverwrite] = useState(false);
  const [newName, setNewName] = useState('');
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // Reported by the model picker in the Conversation tab, but the testing panel needs it
  // too: a report starts a Co-Creator turn, so it is blocked by whatever blocks sending.
  const [toolCapability, setToolCapability] = useState<boolean | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    props.registerPersistence(controller.persistence);
    return () => props.registerPersistence(null);
  }, [controller.persistence, props.registerPersistence]);
  useEffect(() => setTitle(controller.session.title), [controller.session.title]);

  const assistantConnection = controller.assistantConnection;
  const coCreatorBlockedReason = controller.busy
    ? 'The Co-Creator is still replying.'
    : !assistantConnection
      ? 'Choose a Co-Creator model first, under "Assistant model and instructions".'
      : toolCapability === false
        ? 'The Co-Creator model does not support tools.'
        : null;
  // One rule for both places a proposal can run from: the tray and the Co-Creator's card.
  const proposalBlockedReason = !testing.activeTest
    ? 'Start a test scenario first.'
    : testing.busy
      ? 'Wait for the test reply to finish.'
      : null;

  const publish = async (
    mode: 'update' | 'new' | 'overwrite',
    name?: string,
    expectedPresetVersion?: string | null,
  ) => {
    setPublishing(true);
    setPublishError('');
    setConflictVersion(null);
    setConflictPresetJson('');
    setConflictCanOverwrite(false);
    try {
      const result = await controller.publish({ mode, name, expectedPresetVersion });
      props.onPublished(result.presetId, result.version);
      setShowSaveAs(false);
      setNewName('');
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        const body = failure.body as { currentVersion?: unknown } | null;
        if (typeof body?.currentVersion === 'string') {
          setConflictVersion(body.currentVersion);
          if (mode !== 'new' && controller.session.targetPresetId) {
            setConflictCanOverwrite(true);
            try {
              const current = await presetApi.getVersioned(controller.session.targetPresetId);
              setConflictPresetJson(JSON.stringify(current.preset, null, 4));
            } catch {
              setConflictPresetJson('The newer library preset could not be loaded for inspection.');
            }
          }
        }
      }
      setPublishError((failure as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const root = splitRef.current;
    if (!root) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      const value = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setSplit(Math.max(30, Math.min(70, value)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="preset-cc-workspace">
      <header className="preset-cc-workspace__header">
        <button
          type="button"
          className="wc-button wc-button--ghost"
          onClick={() => void props.onBack()}
        >
          Back to sessions
        </button>
        <input
          className="wc-input preset-cc-workspace__title"
          value={title}
          aria-label="Session name"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            if (title.trim() && title.trim() !== controller.session.title) {
              void controller
                .rename(title.trim())
                .catch((failure) => controller.setError((failure as Error).message));
            }
          }}
        />
        <span className="preset-cc-workspace__status">
          Revision {controller.session.draftRevision} ·{' '}
          {controller.saving ? 'Saving session…' : 'Session saved'}
        </span>
        <button
          type="button"
          className="wc-button wc-button--primary"
          disabled={publishing || !controller.session.targetPresetId}
          title={
            controller.session.targetPresetId
              ? 'Publish this committed draft revision to the linked library preset.'
              : 'The source is not linked to a library preset. Use Save as new.'
          }
          onClick={() => void publish('update')}
        >
          Save to preset
        </button>
        <button
          type="button"
          className="wc-button wc-button--ghost"
          disabled={publishing}
          onClick={() => setShowSaveAs((open) => !open)}
        >
          Save as new
        </button>
      </header>

      {showSaveAs ? (
        <div className="preset-cc-save-as">
          <label className="wc-label" htmlFor="preset-cc-new-name">
            New preset name
          </label>
          <input
            id="preset-cc-new-name"
            className="wc-input"
            value={newName}
            // biome-ignore lint/a11y/noAutofocus: the field only exists once Save as new is clicked
            autoFocus
            onChange={(event) => setNewName(event.target.value)}
          />
          <button
            type="button"
            className="wc-button wc-button--primary"
            disabled={!newName.trim() || publishing}
            onClick={() => void publish('new', newName.trim())}
          >
            Create and link
          </button>
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => setShowSaveAs(false)}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {publishError ? (
        <div className="preset-cc-publish-error" role="alert">
          <span>{publishError} The session draft is unchanged.</span>
          {conflictPresetJson ? (
            <details className="preset-cc-conflict-inspection">
              <summary>Inspect the current library preset</summary>
              <pre>{conflictPresetJson}</pre>
            </details>
          ) : null}
          {conflictVersion && conflictCanOverwrite ? (
            <button
              type="button"
              className="wc-button wc-button--danger"
              disabled={publishing}
              title="Publish after reviewing that the library preset changed outside this session."
              onClick={() => void publish('overwrite', undefined, conflictVersion)}
            >
              Overwrite reviewed version
            </button>
          ) : null}
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => setShowSaveAs(true)}
          >
            Save as new instead
          </button>
        </div>
      ) : null}
      {controller.error ? <p className="preset-cc-global-error">{controller.error}</p> : null}

      <div
        ref={splitRef}
        className="preset-cc-workspace__split"
        style={{ '--preset-cc-split': `${split}%` } as CSSProperties}
      >
        <section className="preset-cc-left">
          <nav className="preset-cc-tabs" aria-label="Preset Co-Creator workspace">
            {(['conversation', 'preset', 'history'] as const).map((entry) => (
              <button
                type="button"
                className="wc-button wc-button--ghost"
                data-active={tab === entry || undefined}
                key={entry}
                onClick={() => setTab(entry)}
              >
                {entry[0]!.toUpperCase() + entry.slice(1)}
              </button>
            ))}
          </nav>
          {/* All three stay mounted and share one grid cell; the inactive two are hidden,
              not unmounted. Unmounting threw away everything a panel held locally — the
              composer draft, a half-written message edit, unapplied preset edits, the
              scroll position — every time a tab was clicked. `visibility` rather than
              `display: none`, because a display-none scroller forgets where it was. */}
          <div className="preset-cc-left__content">
            <div
              className="preset-cc-left__panel"
              data-active={tab === 'conversation' || undefined}
              inert={tab !== 'conversation'}
            >
              <PresetAssistantPanel
                controller={controller}
                connections={props.connections}
                toolCapability={toolCapability}
                onToolCapabilityChange={setToolCapability}
                proposalActions={{
                  blockedReason: proposalBlockedReason,
                  onRun: (proposal) => void testing.runProposal(proposal, proposal.message),
                  onDismiss: testing.dismissProposal,
                }}
              />
            </div>
            <div
              className="preset-cc-left__panel"
              data-active={tab === 'preset' || undefined}
              inert={tab !== 'preset'}
            >
              <PresetDraftEditor
                current={controller.session.current}
                busy={controller.busy}
                connection={assistantConnection}
                replaceDraft={controller.replaceDraft}
              />
            </div>
            <div
              className="preset-cc-left__panel"
              data-active={tab === 'history' || undefined}
              inert={tab !== 'history'}
            >
              <PresetHistoryPanel
                history={controller.session.history}
                draftRevision={controller.session.draftRevision}
                busy={controller.busy}
                onRestore={controller.restoreDraft}
                onUndoTurn={controller.undoTurn}
              />
            </div>
          </div>
        </section>
        {/* A real <hr> rather than a div: it is the separator role, and biome is right that
            inventing the role on a div is the weaker markup. Pointer handlers stay because a
            resize grip is exactly the interactive exception the element otherwise lacks. */}
        <hr
          className="preset-cc-resizer"
          aria-label="Resize assistant and testing panels"
          aria-orientation="vertical"
          aria-valuenow={Math.round(split)}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setSplit((value) => Math.max(30, value - 2));
            if (event.key === 'ArrowRight') setSplit((value) => Math.min(70, value + 2));
          }}
        />
        <section className="preset-cc-right">
          <PresetTestingPanel
            controller={controller}
            testing={testing}
            connections={props.connections}
            characters={props.characters}
            personas={props.personas}
            books={props.books}
            initialCharacterId={props.initialCharacterId}
            initialPersonaId={props.initialPersonaId}
            globalLorebookIds={props.globalLorebookIds}
            worldInfoSettings={props.worldInfoSettings}
            globalVariables={props.globalVariables}
            regexScripts={props.regexScripts}
            coCreatorBlockedReason={coCreatorBlockedReason}
            onReportSent={() => setTab('conversation')}
            proposalBlockedReason={proposalBlockedReason}
          />
        </section>
      </div>
    </div>
  );
}
