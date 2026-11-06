/**
 * The tools the island's wings open into the margin, and what each one shows.
 *
 * For now each tool hosts the 2.x panel that already does the job, so nothing goes missing
 * while the shell is new. Restyling them one by one in the programme style is the sub-app
 * work that follows; the wiring here is what LegacyShell passes the same panels.
 */

import { PROVIDERS } from '@shared/providers/types.ts';
import { useState } from 'react';
import type { UiChoice } from '../app/uiChoice.ts';
import type { AppController } from '../app/useAppController.ts';
import { CharacterList } from '../features/character/CharacterList.tsx';
import { InspectPanel } from '../features/chat/InspectPanel.tsx';
import { ConnectionPanel } from '../features/connection/ConnectionPanel.tsx';
import { LorePanel } from '../features/lore/LorePanel.tsx';
import { MemoryPanel } from '../features/memory/MemoryPanel.tsx';
import { GenerationPanel } from '../features/preset/GenerationPanel.tsx';
import { PresetToolbar } from '../features/preset/PresetToolbar.tsx';
import { PromptsPanel } from '../features/preset/PromptsPanel.tsx';
import { UnsavedBar } from '../features/preset/UnsavedBar.tsx';
import { UserSettingsPanel } from '../features/settings/UserSettingsPanel.tsx';
import { CharacterSheet } from './CharacterSheet.tsx';
import type { IconName } from './icons.tsx';
import { PersonaTool } from './PersonaTool.tsx';

export type ToolId =
  | 'characters'
  | 'lorebooks'
  | 'personas'
  | 'prompts'
  | 'generation'
  | 'memory'
  | 'settings'
  | 'inspect';

export interface ToolSpec {
  title: string;
  icon: IconName;
  /** The library opens on the left, the machinery on the right. */
  side: 'L' | 'R';
}

export const TOOLS: Record<ToolId, ToolSpec> = {
  characters: { title: 'Characters', icon: 'users', side: 'L' },
  lorebooks: { title: 'Lorebooks', icon: 'book', side: 'L' },
  personas: { title: 'Personas', icon: 'persona', side: 'L' },
  prompts: { title: 'Prompts', icon: 'layers', side: 'R' },
  generation: { title: 'Generation', icon: 'sliders', side: 'R' },
  memory: { title: 'Memory', icon: 'memory', side: 'R' },
  settings: { title: 'Settings', icon: 'gear', side: 'R' },
  inspect: { title: 'Inspect', icon: 'inspect', side: 'R' },
};

export const LEFT_TOOLS: ToolId[] = ['characters', 'lorebooks', 'personas'];
export const RIGHT_TOOLS: ToolId[] = ['prompts', 'generation', 'memory', 'settings', 'inspect'];

/** The character whose sheet is open in the Characters tool, if it is still in the library. */
function sheetCharacter(controller: AppController) {
  const avatar = controller.characterSheet;
  return avatar
    ? controller.library.characters.find((entry) => entry.avatar === avatar)
    : undefined;
}

/** A tool's heading: its name, or on a character's sheet, the character's. */
export function toolTitle(id: ToolId, controller: AppController): string {
  if (id === 'characters' && controller.characterSheet) {
    return sheetCharacter(controller)?.name ?? 'Character';
  }
  if (id === 'personas' && controller.personaPage) {
    const page = controller.personaPage;
    if (page.kind === 'from') return 'From a character';
    return controller.library.personas.find((p) => p.id === page.id)?.name || 'Persona';
  }
  return TOOLS[id].title;
}

export function toolSubtitle(id: ToolId, controller: AppController): string {
  const { library, chat, app } = controller;
  switch (id) {
    case 'characters': {
      if (controller.characterSheet) {
        const entry = sheetCharacter(controller);
        return entry?.creator ? `by ${entry.creator}` : (entry?.folder ?? '');
      }
      return `${library.characters.length.toLocaleString()} in your library`;
    }
    case 'lorebooks':
      return 'World info for this chat and every chat';
    case 'personas': {
      const page = controller.personaPage;
      if (page?.kind === 'from') return 'A persona drafted from a card';
      const { personas } = library;
      if (page?.kind === 'edit') {
        const persona = personas.find((p) => p.id === page.id);
        if (persona?.variantOf) return `${persona.variantLabel ?? 'Unlabelled'} · a variant`;
        const variants = personas.filter((p) => p.variantOf === page.id).length;
        return variants ? `${variants} ${variants === 1 ? 'variant' : 'variants'}` : 'Persona';
      }
      const variants = personas.filter((p) => p.variantOf).length;
      const people = personas.length - variants;
      return `${people} ${people === 1 ? 'persona' : 'personas'}${variants ? ` · ${variants} ${variants === 1 ? 'variant' : 'variants'}` : ''}`;
    }
    case 'prompts':
      return library.preset ? `Preset “${library.preset.name ?? library.presetId}”` : 'Loading…';
    case 'generation':
      return app.models.chat.model
        ? `Chat model: ${app.models.chat.model.model}`
        : (app.models.chat.blockedReason ?? 'Choose a chat model');
    case 'memory':
      return chat.state.chatId ? `Story memory for “${chat.state.title}”` : 'Story memory';
    case 'settings':
      return 'How the app looks and behaves';
    case 'inspect':
      return 'What was sent with the last reply';
  }
}

export function MarginTool({
  id,
  controller,
  onUiChoice,
}: {
  id: ToolId;
  controller: AppController;
  onUiChoice: (choice: UiChoice) => void;
}) {
  const { app, library, backups, chat, lore, preview, presetDraft } = controller;
  const { settings, view: prefs, models, patchSettings } = app;
  const { characters, personas, books, presets, presetId, preset } = library;
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
  const connection = models.chat.model;
  const presetChrome = (
    <div className="w3-margin__chrome">
      <PresetToolbar
        presets={presets}
        presetId={presetId}
        onSelectPreset={library.selectPreset}
        draft={presetDraft}
      />
      <UnsavedBar draft={presetDraft} />
    </div>
  );

  switch (id) {
    case 'characters': {
      const sheet = controller.characterSheet;
      if (sheet) {
        return (
          <CharacterSheet
            key={sheet}
            avatar={sheet}
            summary={characters.find((entry) => entry.avatar === sheet)}
            avatarVersion={library.characterAvatarVersions[sheet]}
            userName={personas.find((entry) => entry.id === settings?.personaId)?.name ?? 'you'}
            rating={prefs.characterRatings[sheet]}
            onRating={(value) => app.patchCharacterRating(sheet, value)}
            crop={prefs.characterCrops[sheet]}
            onCrop={(value) => app.patchCharacterCrop(sheet, value)}
            dialogueColor={prefs.dialogueColors.characters[sheet]}
            dialogueColorsEnabled={prefs.dialogueColors.enabled}
            onDialogueColor={(value) => app.patchCharacterDialogueColor(sheet, value)}
            countTokens={app.countTokens}
            onBack={() => controller.setCharacterSheet(null)}
            onOpenStudio={() => void controller.enterStudioOn(sheet)}
          />
        );
      }
      return (
        <CharacterList
          look="strips"
          crops={prefs.characterCrops}
          characters={characters}
          folders={library.folders}
          collapsedFolders={prefs.collapsedCharacterFolders}
          hiddenTags={prefs.hiddenTags}
          ratings={prefs.characterRatings}
          sort={prefs.characterListSort}
          onSortChange={(sort) => void patchSettings({ characterListSort: sort })}
          selected={controller.selected}
          scrollMemory={controller.characterListScroll}
          loading={library.loading}
          error={controller.error}
          onSelect={controller.selectCharacter}
          onRefresh={library.refresh}
          onEdit={controller.setCharacterSheet}
          onCollapsedFoldersChange={(next) =>
            void patchSettings({ collapsedCharacterFolders: next })
          }
        />
      );
    }
    case 'lorebooks':
      return (
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
      );
    case 'personas':
      return (
        <PersonaTool
          page={controller.personaPage}
          setPage={controller.setPersonaPage}
          personas={personas}
          books={books}
          characters={characters}
          hiddenTags={prefs.hiddenTags}
          connection={connection}
          preset={preset}
          globalVariables={settings?.variables ?? {}}
          activeId={settings?.personaId ?? null}
          recentIds={settings?.recentPersonaIds ?? []}
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
      );
    case 'prompts':
      return (
        <>
          {presetChrome}
          {preset ? (
            <PromptsPanel
              preset={preset}
              draft={presetDraft}
              selected={selectedPrompt}
              onSelect={setSelectedPrompt}
              tokenCounts={preview?.tokenCounts}
              macroWarnings={preview?.macroWarnings}
            />
          ) : (
            <div className="wc-empty">Loading presets…</div>
          )}
        </>
      );
    case 'generation':
      return (
        <>
          {presetChrome}
          <ConnectionPanel settings={settings} onChange={app.setSettings} />
          {preset ? (
            <GenerationPanel
              preset={preset}
              draft={presetDraft}
              extraSamplersSent={
                connection ? PROVIDERS[connection.provider].supportsExtraSamplers : false
              }
              connection={connection}
              onConnectionPatch={app.patchChatConnection}
            />
          ) : (
            <div className="wc-empty">Loading presets…</div>
          )}
        </>
      );
    case 'memory':
      return (
        <MemoryPanel
          chat={chat}
          mode={chat.memoryMode}
          onModeChange={chat.nexus.setMode}
          defaultMode={prefs.memoryMode}
          onDefaultChange={(memoryMode) => void patchSettings({ memoryMode })}
          settings={prefs.nexus}
          onSettingsChange={(patch) => void patchSettings({ nexus: { ...prefs.nexus, ...patch } })}
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
      );
    case 'settings':
      return (
        <>
          <div className="w3-margin__note">
            <span>
              WackChatter 3.0 is being rebuilt. The 2.x interface is one keypress away
              (Ctrl+Shift+U) while the new one catches up.
            </span>
            <button type="button" className="w3-pill" onClick={() => onUiChoice('legacy')}>
              Use the 2.x interface
            </button>
          </div>
          <UserSettingsPanel
            settings={settings}
            onPatch={app.patchUserSettings}
            unsavedPreset={presetDraft.dirty}
            backups={backups.backups}
            characters={characters}
            onRestoreBackup={(backupId) => void backups.restoreBackup(backupId)}
            onPurgeBackup={(backupId) => void backups.purgeBackup(backupId)}
            onPurgeAllBackups={() => void backups.purgeAllBackups()}
          />
        </>
      );
    case 'inspect':
      return (
        <InspectPanel
          nexusRecall={chat.inspection?.nexusRecall ?? chat.nexus.recall}
          nexusPreview={preview?.nexusRecall}
          worldInfo={chat.worldInfo ?? preview?.worldInfo ?? null}
          inspection={chat.inspection}
        />
      );
  }
}
