/**
 * One Preset Co-Creator session: the Co-Creator, the preset and the bench as one loop, the
 * island carrying the preset, both models and what the session has cost, and saving at the
 * top right.
 */

import type { ModelRef } from '@shared/models/slots.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { MacroVariableMap, Persona } from '@shared/types/chat.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import type {
  PresetCocreatorSession,
  PresetComparisonSource,
  ReferencePresetSummary,
} from '@shared/types/preset-cocreator.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { DialogueColorSettings } from '@shared/types/settings.ts';
import type { LorebookSummary, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Popover } from '../components/Popover.tsx';
import { modelCatalogueEntry } from '../features/models/modelContext.ts';
import { usePresetCocreator } from '../features/preset-cocreator/usePresetCocreator.ts';
import { usePresetTesting } from '../features/preset-cocreator/usePresetTesting.ts';
import { ApiError } from '../lib/api.ts';
import type { PersistenceControls } from '../lib/autosave.ts';
import { Island, type IslandMode, type IslandNotice } from './Island.tsx';
import { Icon } from './icons.tsx';
import { ModelPane } from './ModelPane.tsx';
import { PresetBench } from './PresetBench.tsx';
import { PresetRail, type PromptSheet } from './PresetRail.tsx';
import { PresetTalk } from './PresetTalk.tsx';
import { formatUsd, type Price, sessionSpend, spendCost } from './presetcc.ts';

/** A model id as a short name: the part after the vendor. */
export function modelLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.split('/').pop() ?? id;
}

const priceKey = (connectionId: string, model: string) => `${connectionId}\u0000${model}`;

export interface PresetSessionProps {
  initial: PresetCocreatorSession;
  connections: readonly Connection[];
  presets: readonly PresetSummary[];
  references: readonly ReferencePresetSummary[];
  characters: readonly CharacterSummary[];
  personas: readonly Persona[];
  personaAvatarVersions: Record<string, string | number>;
  dialogueColors: DialogueColorSettings;
  books: readonly LorebookSummary[];
  activeCharacterId: string | null;
  activePersonaId: string | null;
  globalLorebookIds: readonly string[];
  worldInfoSettings: WorldInfoSettings;
  globalVariables: MacroVariableMap;
  regexScripts: readonly RegexScript[];
  tokenizerEncoding?: string;
  streamingFps: number;
  notice: IslandNotice | null;
  onDismissNotice: () => void;
  onFail: (err: unknown) => void;
  onSay: (notice: Omit<IslandNotice, 'id'>) => void;
  onBack: () => void;
  onPublished: (presetId: string, version: string) => void;
  onAddReference: (file: File) => Promise<ReferencePresetSummary>;
  registerPersistence: (controls: PersistenceControls | null) => void;
}

export function PresetSession(props: PresetSessionProps) {
  const { connections, registerPersistence, onFail } = props;
  const controller = usePresetCocreator({
    initial: props.initial,
    connections,
    streamingFps: props.streamingFps,
  });
  const testing = usePresetTesting({
    controller,
    connections,
    tokenizerEncoding: props.tokenizerEncoding,
    streamingFps: props.streamingFps,
  });
  const { session } = controller;
  const document = session.document;

  useEffect(() => {
    registerPersistence(controller.persistence);
  }, [controller.persistence, registerPersistence]);

  const [mode, setMode] = useState<IslandMode | null>(null);
  const [modelFor, setModelFor] = useState<'ai' | 'bench'>('ai');
  // The revision the rail shows; null follows the draft.
  const [viewing, setViewing] = useState<number | null>(null);
  const [lens, setLens] = useState<{ source: PresetComparisonSource; label: string } | null>(null);
  const [sheet, setSheet] = useState<PromptSheet | null>(null);

  // --- Models ---
  const benchSettings = testing.activeTest?.testingSettings ?? document.settings.testing;
  const aiRef = document.settings.assistant.model;
  const benchRef = benchSettings.model;
  const nameOf = (ref: ModelRef | null) => (ref ? (modelLabel(ref.modelId) ?? ref.modelId) : null);
  const pickModel = (ref: ModelRef | null) => {
    if (modelFor === 'ai') {
      controller.updateDocument((current) => ({
        ...current,
        settings: { ...current.settings, assistant: { ...current.settings.assistant, model: ref } },
      }));
    } else {
      testing.setTestingSettings({ ...benchSettings, model: ref });
      // New tests start on it too.
      controller.updateDocument((current) => ({
        ...current,
        settings: { ...current.settings, testing: { ...current.settings.testing, model: ref } },
      }));
    }
    setMode(null);
  };

  // --- What it cost: recorded tokens at the catalogue's prices ---
  const spend = useMemo(() => sessionSpend(document), [document]);
  const [prices, setPrices] = useState<Record<string, Price | null>>({});
  useEffect(() => {
    let cancelled = false;
    for (const entry of spend) {
      const key = priceKey(entry.connectionId, entry.model);
      if (key in prices) continue;
      const connection = connections.find((c) => c.id === entry.connectionId);
      if (!connection) {
        setPrices((current) => ({ ...current, [key]: null }));
        continue;
      }
      void modelCatalogueEntry({
        id: connection.id,
        provider: connection.provider,
        baseUrl: connection.baseUrl,
        model: entry.model,
      }).then((found) => {
        if (cancelled) return;
        const price =
          found &&
          typeof found.promptPrice === 'number' &&
          typeof found.completionPrice === 'number'
            ? { prompt: found.promptPrice, completion: found.completionPrice }
            : null;
        setPrices((current) => ({ ...current, [key]: price }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [spend, connections, prices]);
  const cost = spendCost(
    spend,
    (entry) => prices[priceKey(entry.connectionId, entry.model)] ?? null,
  );
  const priceOf = useCallback(
    (connectionId: string, model: string) => prices[priceKey(connectionId, model)] ?? null,
    [prices],
  );

  // --- Saving ---
  const targetName = session.targetPresetId
    ? (props.presets.find((p) => p.id === session.targetPresetId)?.name ??
      session.targetPresetId.replace(/\.json$/i, ''))
    : null;
  const [publishing, setPublishing] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [newName, setNewName] = useState('');

  const publish = async (mode: 'update' | 'new' | 'overwrite', name?: string) => {
    setPublishing(true);
    try {
      const result = await controller.publish({
        mode,
        name,
        expectedPresetVersion: mode === 'overwrite' ? conflict : undefined,
      });
      props.onPublished(result.presetId, result.version);
      setConflict(null);
      setSavedRevision(result.revision);
      setSaveAsOpen(false);
      setNewName('');
      props.onSay({
        icon: 'check',
        title: 'Saved',
        text: mode === 'new' ? `as ${name}` : `to ${targetName ?? 'the preset'}`,
      });
    } catch (failure) {
      const body =
        failure instanceof ApiError ? (failure.body as { currentVersion?: unknown }) : null;
      if (
        failure instanceof ApiError &&
        failure.status === 409 &&
        typeof body?.currentVersion === 'string'
      ) {
        // The library copy changed outside this session: the next click overwrites it.
        setConflict(body.currentVersion);
      } else onFail(failure);
    } finally {
      setPublishing(false);
    }
  };

  const draftRevision = session.draftRevision;
  const shown = viewing ?? draftRevision;
  const busy = controller.busy || testing.busy;

  const askCompare = useCallback(
    (source: PresetComparisonSource, label: string, focus = '') =>
      void controller.compare(source, label, focus).catch(() => {}),
    [controller],
  );

  const islandMode: IslandMode = mode ?? 'rest';
  const restPane = (
    <>
      <span className="w3-isl-btn w3-pc-isl-preset">
        <span className="w3-pc-isl-glyph">
          <Icon name="sliders" size="sm" />
        </span>
        <span className="w3-isl-stack">
          <span className="w3-who-name">{targetName ?? session.title}</span>
          <span className="w3-who-sub">
            Revision {draftRevision}
            {controller.saving ? ' · saving' : savedRevision === draftRevision ? ' · saved' : ''}
          </span>
        </span>
      </span>
      <span className="w3-isl-sep" aria-hidden="true" />
      <button
        type="button"
        className="w3-isl-btn w3-pc-isl-model"
        title="The model that edits the preset"
        onClick={() => {
          setModelFor('ai');
          setMode('model');
        }}
      >
        <span className="w3-isl-stack">
          <span className="w3-who-sub">Co-Creator</span>
          <span className="w3-pc-isl-model__name">{nameOf(aiRef) ?? 'Choose a model'}</span>
        </span>
      </button>
      <button
        type="button"
        className="w3-isl-btn w3-pc-isl-model"
        title="The model the bench tests the preset on"
        onClick={() => {
          setModelFor('bench');
          setMode('model');
        }}
      >
        <span className="w3-isl-stack">
          <span className="w3-who-sub">Bench</span>
          <span className="w3-pc-isl-model__name">{nameOf(benchRef) ?? 'Choose a model'}</span>
        </span>
      </button>
      {cost ? (
        <>
          <span className="w3-isl-sep" aria-hidden="true" />
          <span
            className="w3-pc-isl-cost"
            title={
              cost.complete
                ? 'What this session has cost so far, at the providers’ listed prices'
                : 'What this session has cost so far. Some models list no price and are left out.'
            }
          >
            <b>
              {formatUsd(cost.usd)}
              {cost.complete ? '' : '+'}
            </b>
            <small>so far</small>
          </span>
        </>
      ) : null}
    </>
  );

  return (
    <>
      <header className="w3-studio__top">
        <div className="w3-studio__side">
          <button type="button" className="w3-st-topbtn" onClick={props.onBack}>
            <Icon name="chevronLeft" size="sm" />
            Sessions
          </button>
        </div>
        <div className="w3-studio__side w3-studio__side--right">
          <Popover
            label="Save as a new preset"
            icon={null}
            open={saveAsOpen}
            onOpenChange={setSaveAsOpen}
            placement="bottom-end"
            role="dialog"
            popupClassName="w3-pc-saveas"
            renderTrigger={(trigger) => (
              <button
                {...trigger}
                type="button"
                className="w3-st-ghost w3-st-ghost--sm"
                disabled={publishing}
                onClick={() => setSaveAsOpen(!saveAsOpen)}
              >
                Save as new
              </button>
            )}
          >
            <form
              className="w3-pc-saveas__body"
              onSubmit={(event) => {
                event.preventDefault();
                if (newName.trim()) void publish('new', newName.trim());
              }}
            >
              <input
                value={newName}
                placeholder="Name the new preset"
                aria-label="New preset name"
                // biome-ignore lint/a11y/noAutofocus: the field is the whole popover
                autoFocus
                onChange={(event) => setNewName(event.target.value)}
              />
              <button
                type="submit"
                className="w3-st-pill w3-co-pill"
                disabled={!newName.trim() || publishing}
              >
                Save
              </button>
            </form>
          </Popover>
          {targetName ? (
            <button
              type="button"
              className={conflict ? 'w3-st-ghost w3-pc-overwrite' : 'w3-st-pill w3-co-pill'}
              disabled={publishing}
              title={
                conflict
                  ? 'Your library copy changed outside this session. Click to replace it with this draft.'
                  : `Save revision ${draftRevision} to ${targetName}`
              }
              onClick={() => void publish(conflict ? 'overwrite' : 'update')}
            >
              <Icon name={conflict ? 'alert' : 'check'} size="sm" />
              {conflict ? `${targetName} changed · Overwrite?` : `Save to ${targetName}`}
            </button>
          ) : null}
        </div>
      </header>

      <Island
        mode={islandMode}
        generating={false}
        onCollapse={() => setMode(null)}
        notice={props.notice}
        onDismissNotice={props.onDismissNotice}
        wingsPinned={false}
        wingLeft={null}
        wingRight={null}
        panes={{
          rest: restPane,
          model: (
            <ModelPane
              active={islandMode === 'model'}
              value={modelFor === 'ai' ? aiRef : benchRef}
              head={
                <div className="w3-co-mpfor">
                  <button
                    type="button"
                    aria-pressed={modelFor === 'ai'}
                    onClick={() => setModelFor('ai')}
                  >
                    The Co-Creator
                    <small>{nameOf(aiRef) ?? 'None'}</small>
                  </button>
                  <button
                    type="button"
                    aria-pressed={modelFor === 'bench'}
                    onClick={() => setModelFor('bench')}
                  >
                    The bench
                    <small>{nameOf(benchRef) ?? 'None'}</small>
                  </button>
                </div>
              }
              onPick={pickModel}
            />
          ),
        }}
      />

      <div className="w3-studio__body">
        <div className="w3-pc-work">
          <PresetTalk
            controller={controller}
            testing={testing}
            presets={props.presets}
            references={props.references}
            characters={props.characters}
            modelName={nameOf(aiRef)}
            onShowRevision={(revision) => {
              setLens(null);
              setViewing(revision === draftRevision ? null : revision);
            }}
          />
          <PresetRail
            session={session}
            viewing={shown}
            onView={(revision) => setViewing(revision === draftRevision ? null : revision)}
            busy={busy}
            onRestore={async (revision) => {
              try {
                await controller.restoreDraft(revision);
                setViewing(null);
              } catch (err) {
                onFail(err);
              }
            }}
            lens={lens}
            onLens={setLens}
            presets={props.presets}
            references={props.references}
            onAddReference={props.onAddReference}
            onAsk={askCompare}
            askBlocked={
              controller.busy
                ? 'The Co-Creator is still replying.'
                : !aiRef
                  ? 'Choose the Co-Creator’s model on the island.'
                  : null
            }
            onOpen={setSheet}
            onFail={onFail}
            tokenizerModel={testing.connection?.model ?? ''}
            tokenizerEncoding={props.tokenizerEncoding}
          />
          <PresetBench
            controller={controller}
            testing={testing}
            sheet={sheet}
            onOpenSheet={setSheet}
            onCloseSheet={() => setSheet(null)}
            presets={props.presets}
            references={props.references}
            characters={props.characters}
            personas={props.personas}
            personaAvatarVersions={props.personaAvatarVersions}
            dialogueColors={props.dialogueColors}
            books={props.books}
            activeCharacterId={props.activeCharacterId}
            activePersonaId={props.activePersonaId}
            globalLorebookIds={props.globalLorebookIds}
            worldInfoSettings={props.worldInfoSettings}
            globalVariables={props.globalVariables}
            regexScripts={props.regexScripts}
            modelName={nameOf(benchRef)}
            priceOf={priceOf}
            coCreatorBlocked={
              controller.busy || controller.batchSending
                ? 'The Co-Creator is still replying.'
                : !controller.assistantConnection
                  ? 'Choose the Co-Creator’s model on the island first.'
                  : null
            }
          />
        </div>
      </div>
    </>
  );
}
