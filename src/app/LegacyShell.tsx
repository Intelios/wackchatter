/**
 * The 2.x interface, rendered from the app controller.
 *
 * Markup only: every piece of state and every action comes from `useAppController`, so the
 * 3.0 shell can take this one's place without touching how the app behaves. It is deleted
 * once the new shell reaches parity.
 */

import { greetingTexts } from '@shared/chat/message.ts';
import type { ComposerLayout } from '@shared/composer/layout.ts';
import { PROVIDERS } from '@shared/providers/types.ts';
import type { ReactNode } from 'react';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import { ArenaShell } from '../features/arena/ArenaShell.tsx';
import { CharacterEditor } from '../features/character/CharacterEditor.tsx';
import { CharacterList } from '../features/character/CharacterList.tsx';
import { ChatView } from '../features/chat/ChatView.tsx';
import { CoCreatorLanding } from '../features/cocreator/CoCreatorLanding.tsx';
import { CocreatorShell } from '../features/cocreator/CocreatorShell.tsx';
import { TokenTrailPanel } from '../features/integrations/TokenTrailPanel.tsx';
import { LorePanel } from '../features/lore/LorePanel.tsx';
import { MemoryPanel } from '../features/memory/MemoryPanel.tsx';
import { ModelsProvider } from '../features/models/ModelsContext.tsx';
import { NexusExplorer } from '../features/nexus/NexusExplorer.tsx';
import { PersonaPanel } from '../features/persona/PersonaPanel.tsx';
import { PresetCocreatorShell } from '../features/preset-cocreator/PresetCocreatorShell.tsx';
import { UserSettingsPanel } from '../features/settings/UserSettingsPanel.tsx';
import { StartScreen } from '../features/start/StartScreen.tsx';
import { StudioShell } from '../features/studio/StudioShell.tsx';
import { AppShell, Panel } from '../layout/AppShell.tsx';
import { LeftPanel } from '../layout/LeftPanel.tsx';
import { LEFT_PANELS, RIGHT_PANELS } from '../layout/panels.tsx';
import type { AppController } from './useAppController.ts';

export function LegacyShell({
  controller,
  onUseNewInterface,
}: {
  controller: AppController;
  /** Set only when the 2.x interface is the chosen one, so Settings offers the way back. */
  onUseNewInterface?: () => void;
}) {
  const { app, library, backups, chat, lore, preview, presetDraft } = controller;
  const { settings, view: prefs, models, patchSettings } = app;
  const { characters, personas, books, presets, presetId, preset } = library;
  const { selected, active, character, showEditor, rightPanel, leftPanel } = controller;

  const backdrop = {
    backgroundUrl: prefs.backdrop.url,
    backgroundBlur: prefs.backdrop.blur,
    backgroundDim: prefs.backdrop.dim,
    glass: prefs.backdrop.glass,
    effect: prefs.backdrop.effect,
    effectLayer: prefs.backdrop.effectLayer,
  };

  const withModels = (node: ReactNode) => (
    <ModelsProvider
      connections={settings?.connections ?? []}
      recentModels={settings?.recentModels ?? []}
      chatModel={models.slots.chat}
      onRecentModels={app.rememberModels}
      favoriteModels={settings?.favoriteModels ?? []}
      onFavoriteModels={app.setFavoriteModels}
      pickerGroups={settings?.modelPickerGroups ?? {}}
      onPickerGroups={app.setModelPickerGroups}
    >
      {node}
    </ModelsProvider>
  );

  const shared = {
    globalLorebookIds: prefs.globalBookIds,
    worldInfoSettings: prefs.worldInfo,
    globalVariables: settings?.variables ?? {},
    regexScripts: prefs.regexScripts,
    tokenizerEncoding: settings?.tokenizerEncoding,
    streamingFps: prefs.streamingFps,
  };

  if (controller.view === 'arena') {
    return withModels(
      <ArenaShell
        settings={prefs.arena}
        onSettingsChange={(patch) => void patchSettings({ arena: { ...prefs.arena, ...patch } })}
        connections={settings?.connections ?? []}
        presets={presets}
        activePresetId={presetId}
        activePreset={preset}
        characters={characters}
        personas={personas}
        books={books}
        hiddenTags={prefs.hiddenTags}
        {...shared}
        {...backdrop}
        onExit={controller.exitArena}
      />,
    );
  }

  if (controller.view === 'tokentrail') {
    return <TokenTrailPanel character={selected} onExit={controller.exitStats} />;
  }

  if (controller.view === 'cocreator') {
    if (controller.coCreatorMode === 'landing') {
      return withModels(
        <CoCreatorLanding
          {...backdrop}
          onCharacter={() => controller.setCoCreatorMode('character')}
          onPreset={() => controller.setCoCreatorMode('preset')}
          onExit={controller.exitCoCreator}
        />,
      );
    }
    if (controller.coCreatorMode === 'preset') {
      return withModels(
        <PresetCocreatorShell
          connections={settings?.connections ?? []}
          chatModel={models.slots.chat}
          presets={presets}
          activePresetId={presetId}
          characters={characters}
          activeCharacterId={selected}
          personas={personas}
          activePersonaId={settings?.personaId ?? null}
          books={books}
          {...shared}
          {...backdrop}
          onExit={controller.leaveCocreatorDesk}
          onPublished={controller.presetPublished}
          registerPersistence={controller.registerPersistence('cocreator')}
        />,
      );
    }
    return withModels(
      <CocreatorShell
        defaults={prefs.coCreator}
        connections={settings?.connections ?? []}
        models={models.slots}
        onModelSlotChange={app.setModelSlot}
        presets={presets}
        activePresetId={presetId}
        activePreset={preset}
        tokenizerEncoding={settings?.tokenizerEncoding}
        onDefaultsChange={(patch) => void patchSettings({ coCreator: patch })}
        characters={characters}
        streamingFps={prefs.streamingFps}
        {...backdrop}
        onExit={controller.leaveCocreatorDesk}
        exitLabel="Back to Co-Creator"
        onFinished={controller.finishCoCreator}
        seedAvatar={controller.cocreatorSeedAvatar}
        registerPersistence={controller.registerPersistence('cocreator')}
      />,
    );
  }

  if (controller.view === 'studio') {
    return withModels(
      <StudioShell
        characters={characters}
        folders={library.folders}
        books={books}
        countTokens={app.countTokens}
        contextLimit={preset?.openai_max_context}
        {...backdrop}
        inspectorCollapsed={prefs.studioInspectorCollapsed}
        onInspectorCollapsedChange={(collapsed) =>
          void patchSettings({ studioInspectorCollapsed: collapsed })
        }
        onExit={controller.exitStudio}
        onOpenCoCreator={(avatar) =>
          avatar
            ? void controller.enterCoCreatorFromStudio(avatar)
            : void controller.enterCoCreator()
        }
        initialAvatar={controller.studioInitialAvatar}
        registerPersistence={controller.registerPersistence('studio')}
      />,
    );
  }

  const connection = models.chat.model;

  return withModels(
    <AppShell
      leftPanel={leftPanel}
      rightPanel={rightPanel}
      leftButtons={LEFT_PANELS}
      rightButtons={RIGHT_PANELS}
      onSelectLeft={controller.selectLeftPanel}
      onSelectRight={(id) => void controller.selectRightPanel(id)}
      {...backdrop}
      /*
       * One boundary per region, under the root one in main.tsx.
       *
       * A crash is usually about what is on screen — a card with an odd field, a message that
       * will not render — so containing it to the region that owns that content leaves the
       * other two working, and `resetKeys` makes navigating away a recovery path: switch
       * panel, switch character, and the dead region comes back by itself rather than waiting
       * for a reload it may well survive.
       */
      left={
        <ErrorBoundary where="the left panel" resetKeys={[leftPanel]}>
          <LeftPanel
            active={leftPanel}
            settings={settings}
            onSettingsChange={app.setSettings}
            presets={presets}
            presetId={presetId}
            preset={preset}
            onSelectPreset={library.selectPreset}
            draft={presetDraft}
            tokenCounts={preview?.tokenCounts}
            macroWarnings={preview?.macroWarnings}
            extraSamplersSent={
              connection ? PROVIDERS[connection.provider].supportsExtraSamplers : false
            }
            connection={connection}
            onConnectionPatch={app.patchChatConnection}
            // The last generation's result when there is one, else the live preview — so the
            // report answers "why didn't it fire?" before you send, too.
            worldInfo={chat.worldInfo ?? preview?.worldInfo ?? null}
            inspection={chat.inspection}
            nexusRecall={chat.inspection?.nexusRecall ?? chat.nexus.recall}
            nexusPreview={preview?.nexusRecall}
          />
        </ErrorBoundary>
      }
      right={
        <ErrorBoundary
          where="the right panel"
          resetKeys={[rightPanel, controller.editing, selected]}
        >
          {showEditor ? (
            <Panel title={showEditor.name || 'Character'}>
              <CharacterEditor
                key={showEditor.avatar}
                detail={showEditor}
                onSaved={controller.characterSaved}
                onRenamed={(saved) => void controller.characterRenamed(saved)}
                onDeleted={controller.characterDeleted}
                onBack={() => controller.setEditing(false)}
                registerPersistence={controller.registerPersistence('character')}
                dialogueColor={prefs.dialogueColors.characters[showEditor.avatar]}
                dialogueColorsEnabled={prefs.dialogueColors.enabled}
                avatarVersion={library.characterAvatarVersions[showEditor.avatar]}
                rating={prefs.characterRatings[showEditor.avatar]}
                onRatingChange={(value) => app.patchCharacterRating(showEditor.avatar, value)}
                onDialogueColorChange={(value) =>
                  app.patchCharacterDialogueColor(showEditor.avatar, value)
                }
                onAvatarChanged={() => library.bumpCharacterAvatar(showEditor.avatar)}
              />
            </Panel>
          ) : (
            <Panel title={RIGHT_PANELS.find((p) => p.id === rightPanel)?.label}>
              {rightPanel === 'characters' ? (
                <CharacterList
                  characters={characters}
                  folders={library.folders}
                  collapsedFolders={prefs.collapsedCharacterFolders}
                  hiddenTags={prefs.hiddenTags}
                  ratings={prefs.characterRatings}
                  sort={prefs.characterListSort}
                  onSortChange={(sort) => void patchSettings({ characterListSort: sort })}
                  selected={selected}
                  scrollMemory={controller.characterListScroll}
                  loading={library.loading}
                  error={controller.error}
                  onSelect={controller.selectCharacter}
                  onRefresh={library.refresh}
                  onEdit={controller.editCharacter}
                  onCollapsedFoldersChange={(next) =>
                    void patchSettings({ collapsedCharacterFolders: next })
                  }
                />
              ) : null}

              {rightPanel === 'lorebooks' ? (
                <LorePanel
                  books={books}
                  settings={prefs.worldInfo}
                  onBooksChanged={() => {
                    void library.refreshBooks();
                    void library.refreshPersonas();
                  }}
                  onSettingsChange={(patch) => void patchSettings({ worldInfo: patch })}
                  activeBooks={lore.activeForPersona(chat.persona?.lorebookId ?? undefined)}
                  onBookEdited={lore.invalidate}
                  registerPersistence={controller.registerPersistence('lore')}
                />
              ) : null}

              {rightPanel === 'summary' ? (
                <MemoryPanel
                  chat={chat}
                  mode={chat.memoryMode}
                  onModeChange={chat.nexus.setMode}
                  defaultMode={prefs.memoryMode}
                  onDefaultChange={(memoryMode) => void patchSettings({ memoryMode })}
                  settings={prefs.nexus}
                  onSettingsChange={(patch) =>
                    void patchSettings({ nexus: { ...prefs.nexus, ...patch } })
                  }
                  summarySettings={prefs.summary}
                  onSummarySettingsChange={(patch) =>
                    void patchSettings({ summary: { ...prefs.summary, ...patch } })
                  }
                  model={models.slots.nexus}
                  onModelChange={(ref) => app.setModelSlot('nexus', ref)}
                  blockedReason={models.nexus.blockedReason}
                  summaryModel={models.slots.summary}
                  onSummaryModelChange={(ref) => app.setModelSlot('summary', ref)}
                  summaryBlockedReason={models.summary.blockedReason}
                />
              ) : null}

              {rightPanel === 'persona' ? (
                <PersonaPanel
                  personas={personas}
                  books={books}
                  characters={characters}
                  hiddenTags={prefs.hiddenTags}
                  connection={connection}
                  preset={preset}
                  globalVariables={settings?.variables ?? {}}
                  activeId={settings?.personaId ?? null}
                  recentIds={settings?.recentPersonaIds ?? []}
                  density={settings?.personaListDensity ?? 'list'}
                  onDensityChange={(personaListDensity) =>
                    void patchSettings({ personaListDensity })
                  }
                  countTokens={app.countTokens}
                  onSelect={controller.selectPersona}
                  onChanged={library.refreshPersonas}
                  registerPersistence={controller.registerPersistence('persona')}
                  dialogueColors={prefs.dialogueColors}
                  avatarVersions={library.personaAvatarVersions}
                  onDialogueColorChange={app.patchPersonaDialogueColor}
                  onAvatarChanged={library.bumpPersonaAvatar}
                  onDeleted={controller.personaDeleted}
                />
              ) : null}

              {rightPanel === 'settings' ? (
                <UserSettingsPanel
                  settings={settings}
                  onPatch={app.patchUserSettings}
                  unsavedPreset={presetDraft.dirty}
                  backups={backups.backups}
                  characters={characters}
                  onRestoreBackup={(backupId) => void backups.restoreBackup(backupId)}
                  onPurgeBackup={(backupId) => void backups.purgeBackup(backupId)}
                  onPurgeAllBackups={() => void backups.purgeAllBackups()}
                  onUseNewInterface={onUseNewInterface}
                />
              ) : null}
            </Panel>
          )}
        </ErrorBoundary>
      }
    >
      <ErrorBoundary where="the chat" resetKeys={[selected, chat.state.chatId]}>
        {active && character ? (
          <ChatView
            chat={chat}
            characterName={character.name || active.name}
            avatar={active.avatar}
            characterAvatarVersion={library.characterAvatarVersions[active.avatar]}
            personaAvatarVersions={library.personaAvatarVersions}
            personas={personas}
            recentPersonaIds={settings?.recentPersonaIds ?? []}
            onSelectPersona={controller.selectPersona}
            creatorNotes={character.creator_notes ?? ''}
            // From the card rather than the message's swipe count: re-rolling the opening
            // message appends swipes the creator never wrote, and counting those would slide
            // a scenario list out of step with the greetings it describes.
            greetingCount={greetingTexts(character).length}
            // The card, for the sheet on the character's avatar. Already loaded, so this is
            // the same object the transcript is rendering from.
            card={character}
            onEditCharacter={() => controller.editCharacter(active.avatar)}
            ready={controller.ready}
            notReadyReason={models.chat.blockedReason}
            onCloseChat={() => void controller.closeChat()}
            onOpenPanel={(id) => void controller.showRightPanel(id)}
            guidance={prefs.guidance}
            onGuidanceChange={(patch) =>
              void patchSettings({ guidance: { ...prefs.guidance, ...patch } })
            }
            dialogueColors={prefs.dialogueColors}
            quickCommands={prefs.quickCommands}
            onQuickCommandsChange={(next) => void patchSettings({ quickCommands: next })}
            composerLayout={prefs.composerLayout}
            onComposerLayoutSave={async (layout: ComposerLayout) => {
              await app.saveSettingsStrict({ composerLayouts: { single: layout } });
            }}
            onImportChat={(file) => void backups.importChat(file)}
            regexScripts={prefs.regexScripts}
            collapsedMenuGroups={prefs.collapsedChatMenuGroups}
            onCollapsedMenuGroupsChange={(next) =>
              void patchSettings({ collapsedChatMenuGroups: next })
            }
          />
        ) : (
          <StartScreen
            characters={characters}
            onOpenChat={controller.openRecentChat}
            onDeleteChat={backups.deleteChat}
            onOpenStudio={() => void controller.enterStudio()}
            onOpenCoCreator={() => void controller.enterCoCreator()}
            onOpenStats={() => void controller.enterStats()}
            onOpenArena={() => void controller.enterArena()}
          />
        )}
      </ErrorBoundary>
      <ErrorBoundary where="Memory Nexus" resetKeys={[chat.state.chatId, chat.nexus.open]}>
        <NexusExplorer
          chat={chat}
          settings={prefs.nexus}
          onSettingsChange={(patch) => void patchSettings({ nexus: { ...prefs.nexus, ...patch } })}
          model={models.slots.nexus}
          onModelChange={(ref) => app.setModelSlot('nexus', ref)}
          blockedReason={models.nexus.blockedReason}
        />
      </ErrorBoundary>
    </AppShell>,
  );
}
