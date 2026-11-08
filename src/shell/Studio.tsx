/**
 * The Creator Studio in the 3.0 shell: its own place, apart from the chat.
 *
 * It keeps the island but only for the Studio's own things: the card you are writing and
 * whether it is saved, what you changed since you opened it (each one can be put back),
 * and ⌘K for another card or another part of this one. No wings, no persona, no chat
 * tools. The colour is the card's, as in the chat; on the library it follows the card
 * under the pointer.
 */

import './studio.css';

import type { CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppController } from '../app/useAppController.ts';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import {
  needsPortrait,
  resolveSpeakerColors,
  useAvatarPalette,
} from '../features/chat/avatarColor.ts';
import { characterApi, personaApi } from '../lib/api.ts';
import type { PersistenceControls } from '../lib/autosave.ts';
import { downloadUrl } from '../lib/download.ts';
import { Avatar } from './Avatar.tsx';
import { Island, type IslandMode, type IslandNotice } from './Island.tsx';
import { type SearchItem, SearchPane } from './IslandPanes.tsx';
import { Icon } from './icons.tsx';
import {
  type BenchHandle,
  type BenchReport,
  type OpenedCard,
  StudioBench,
} from './StudioBench.tsx';
import { StudioDesk } from './StudioDesk.tsx';
import type { CardChange } from './studio.ts';
import { STUDIO_SECTIONS } from './studio.ts';
import { initialAuraStyle, useAura } from './useAura.ts';

export function Studio({ controller }: { controller: AppController }) {
  const { app, library } = controller;
  const { settings, view: prefs } = app;

  const [cards, setCards] = useState<CharacterSummary[]>(library.characters);
  const [folders, setFolders] = useState<string[]>(library.folders);
  const [detail, setDetail] = useState<CharacterDetail | null>(null);
  const [opened, setOpened] = useState<OpenedCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [mode, setMode] = useState<IslandMode | null>(null);
  const [report, setReport] = useState<BenchReport | null>(null);
  const [notice, setNotice] = useState<IslandNotice | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const noticeId = useRef(0);
  const benchRef = useRef<BenchHandle | null>(null);
  const persistence = useRef<PersistenceControls | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLDivElement>(null);

  useEffect(() => setCards(library.characters), [library.characters]);
  useEffect(() => setFolders(library.folders), [library.folders]);

  const say = useCallback((next: Omit<IslandNotice, 'id'>) => {
    noticeId.current += 1;
    setNotice({ ...next, id: noticeId.current });
  }, []);
  const fail = useCallback(
    (err: unknown) =>
      say({
        icon: 'alert',
        title: 'Studio',
        text: (err as Error).message,
        tone: 'bad',
        sticky: true,
      }),
    [say],
  );

  const refreshCards = useCallback(async () => {
    const [nextCards, nextFolders] = await Promise.all([
      characterApi.list(),
      characterApi.folders.list(),
    ]);
    setCards(nextCards);
    setFolders(nextFolders);
  }, []);

  const open = useCallback(
    async (avatar: string) => {
      setMode(null);
      try {
        await persistence.current?.flush();
        const next = await characterApi.get(avatar);
        setReport(null);
        setDetail(next);
        setOpened({ data: next.card.data, folder: next.folder });
      } catch (err) {
        fail(err);
      }
    },
    [fail],
  );

  // The Co-Creator's handoff, and "Open in Studio" from the chat: arrive on that card, once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the handed-off card
  useEffect(() => {
    if (controller.studioInitialAvatar) void open(controller.studioInitialAvatar);
  }, [controller.studioInitialAvatar]);

  const toLibrary = useCallback(async () => {
    setMode(null);
    try {
      await persistence.current?.flush();
    } catch (err) {
      fail(err);
      return;
    }
    setDetail(null);
    setOpened(null);
    setReport(null);
    void refreshCards().catch(fail);
  }, [fail, refreshCards]);

  const registerPersistence = useMemo(() => controller.registerPersistence('studio'), [controller]);
  const register = useCallback(
    (controls: PersistenceControls | null) => {
      persistence.current = controls;
      registerPersistence(controls);
    },
    [registerPersistence],
  );

  // --- The card's file ---

  const exportCard = useCallback(
    async (avatar: string, format: 'png' | 'json', flush?: () => Promise<void>) => {
      try {
        await flush?.();
      } catch (err) {
        fail(err);
        return;
      }
      downloadUrl(characterApi.exportUrl(avatar, format));
    },
    [fail],
  );

  const duplicate = useCallback(
    async (card: { avatar: string; name: string; folder: string }, flush?: () => Promise<void>) => {
      setBusy(true);
      try {
        await flush?.();
        const response = await fetch(characterApi.exportUrl(card.avatar, 'png'));
        if (!response.ok) throw new Error(`Could not copy ${card.name}.`);
        const file = new File([await response.blob()], `${card.name || 'Character'} copy.png`, {
          type: 'image/png',
        });
        const copied = await characterApi.import(file, card.folder);
        await refreshCards();
        say({ icon: 'copy', title: 'Duplicated', text: copied.name });
        await open(copied.avatar);
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    [fail, open, refreshCards, say],
  );

  const create = useCallback(async () => {
    setBusy(true);
    try {
      const created = await characterApi.create('Untitled Character', 'Drafts');
      await refreshCards();
      await open(created.avatar);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }, [fail, open, refreshCards]);

  const importFiles = useCallback(
    async (files: File[], folder: string) => {
      setBusy(true);
      const failures: string[] = [];
      let last: string | null = null;
      for (const file of files) {
        try {
          last = (await characterApi.import(file, folder)).name;
        } catch (err) {
          failures.push(`${file.name}: ${(err as Error).message}`);
        }
      }
      await refreshCards().catch(fail);
      setBusy(false);
      if (failures.length) fail(new Error(failures.join(' · ')));
      else if (last) {
        say({
          icon: 'upload',
          title: 'Imported',
          text: files.length === 1 ? last : `${files.length} cards`,
        });
      }
    },
    [fail, refreshCards, say],
  );

  // --- Colour ---

  const focus =
    detail?.avatar ??
    hover ??
    cards.reduce<CharacterSummary | null>(
      (latest, card) => (!latest || card.modified > latest.modified ? card : latest),
      null,
    )?.avatar ??
    null;
  const focusCard = cards.find((card) => card.avatar === focus);
  const focusUrl = focus
    ? characterApi.imageUrl(
        focus,
        library.characterAvatarVersions[focus] ??
          (detail?.avatar === focus ? detail.modified : (focusCard?.modified ?? 0)),
      )
    : null;
  const autoColor = useAvatarPalette(focusUrl);
  const override = focus ? prefs.dialogueColors.characters[focus] : undefined;
  const cardColor = resolveSpeakerColors(true, override, autoColor).aura;

  const persona = library.personas.find((entry) => entry.id === settings?.personaId) ?? null;
  const personaUrl = persona?.avatar
    ? personaApi.avatarUrl(persona.id, library.personaAvatarVersions[persona.id] ?? persona.avatar)
    : null;
  const personaOverride = persona ? prefs.dialogueColors.personas[persona.id] : undefined;
  const personaAuto = useAvatarPalette(needsPortrait(personaOverride) ? personaUrl : null);
  const personaColor = resolveSpeakerColors(true, personaOverride, personaAuto).aura;

  useAura(rootRef, washRef, cardColor, personaColor, detail?.avatar ?? 'studio');
  const [firstAura] = useState(() => initialAuraStyle(cardColor, personaColor));

  // --- Island ---

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMode((current) => (current === 'search' ? null : 'search'));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const searchItems = useMemo<SearchItem[]>(() => {
    const cardItems: SearchItem[] = [...cards]
      .filter((card) => card.avatar !== detail?.avatar)
      .sort((a, b) => b.modified - a.modified)
      .map((card) => ({
        key: `card:${card.avatar}`,
        kind: 'Card',
        label: card.name || 'Untitled',
        sub: card.folder || undefined,
        terms: card.tags.join(' '),
        face: {
          name: card.name,
          url: characterApi.imageUrl(
            card.avatar,
            library.characterAvatarVersions[card.avatar] ?? card.modified,
          ),
        },
        run: () => void open(card.avatar),
      }));
    if (!detail) return cardItems;
    const sections: SearchItem[] = STUDIO_SECTIONS.map((section) => ({
      key: `section:${section.id}`,
      kind: 'Section',
      label: section.label,
      icon: 'chevronRight',
      run: () => benchRef.current?.goTo(section.id),
    }));
    // The last few cards first, then this card's sections, then every other card.
    return [...cardItems.slice(0, 3), ...sections, ...cardItems.slice(3)];
  }, [cards, detail, library.characterAvatarVersions, open]);

  const changes = report?.changes ?? [];
  const saveWord =
    report?.saveState === 'saving'
      ? 'Saving'
      : report?.saveState === 'error'
        ? 'Not saved'
        : 'Saved';

  const revert = (change: CardChange | 'all') => {
    const id = change === 'all' ? '*' : change.id;
    if (armed !== id) return setArmed(id);
    setArmed(null);
    benchRef.current?.revert(change);
    if (change === 'all') setMode(null);
  };

  const restPane = detail ? (
    <>
      <span className="w3-isl-btn w3-st-isl-card">
        <Avatar
          url={characterApi.imageUrl(detail.avatar, detail.modified)}
          name={detail.card.data.name}
          size="sm"
        />
        <span className="w3-isl-stack">
          <span className="w3-who-name">{detail.card.data.name || 'Untitled'}</span>
          <span
            className="w3-st-save"
            data-state={report?.saveState ?? 'idle'}
            title={report?.saveState === 'error' ? (report.saveError ?? undefined) : undefined}
          >
            {saveWord}
          </span>
        </span>
      </span>
      <span className="w3-isl-sep" aria-hidden="true" />
      <button
        type="button"
        className="w3-isl-search w3-st-isl-changes"
        aria-label={`Changes since you opened the card: ${changes.length}`}
        onClick={() => {
          setArmed(null);
          setMode('changes');
        }}
      >
        <Icon name="restore" size="sm" />
        Changes
        <b data-zero={changes.length === 0 || undefined}>{changes.length}</b>
      </button>
      <button
        type="button"
        className="w3-isl-search"
        aria-label="Find a card or a section"
        onClick={() => setMode('search')}
      >
        <Icon name="search" />
        <kbd className="w3-kbd">⌘K</kbd>
      </button>
    </>
  ) : (
    <>
      <span className="w3-st-mark">
        <Icon name="studio" size="sm" />
        Studio
      </span>
      <span className="w3-isl-sep" aria-hidden="true" />
      <button
        type="button"
        className="w3-isl-search"
        aria-label="Find a card"
        onClick={() => setMode('search')}
      >
        <Icon name="search" />
        Find a card
        <kbd className="w3-kbd">⌘K</kbd>
      </button>
    </>
  );

  const changesPane = (
    <>
      <div className="w3-st-changes__head">
        <span>Since you opened {opened?.data.name || 'the card'}</span>
        <span>{changes.length}</span>
      </div>
      {changes.length ? (
        <>
          <div className="w3-st-changes">
            {changes.map((change) => (
              <div key={change.id} className="w3-st-change">
                <b>{change.label}</b>
                <small>
                  {change.diff ? (
                    <>
                      {change.diff.lead}
                      {change.diff.gone ? <del>{change.diff.gone}</del> : null}
                      {change.diff.added ? <ins>{change.diff.added}</ins> : null}
                      {change.diff.tail}
                    </>
                  ) : change.after ? (
                    <>
                      <del>{change.before}</del>
                      <span className="w3-st-change__to">→</span>
                      <ins>{change.after}</ins>
                    </>
                  ) : (
                    change.before
                  )}
                </small>
                <button
                  type="button"
                  className="w3-st-ghost w3-st-ghost--sm"
                  data-armed={armed === change.id || undefined}
                  onClick={() => revert(change)}
                >
                  {armed === change.id ? 'Click again' : 'Put back'}
                </button>
              </div>
            ))}
          </div>
          <div className="w3-st-changes__all">
            <button
              type="button"
              className="w3-st-ghost w3-st-ghost--sm"
              data-armed={armed === '*' || undefined}
              onClick={() => revert('all')}
            >
              {armed === '*' ? 'Click again to put everything back' : 'Put everything back'}
            </button>
          </div>
        </>
      ) : (
        <p className="w3-st-changes__none">Nothing changed yet.</p>
      )}
    </>
  );

  const backLabel = controller.active ? 'Back to chat' : 'Home';
  const islandMode: IslandMode = mode ?? 'rest';

  return (
    <div
      ref={rootRef}
      className="wc3 w3-studio"
      data-overlay-root
      data-screen={detail ? 'card' : 'library'}
      style={firstAura as CSSProperties}
    >
      <div className="w3-aura" aria-hidden="true" />
      <div className="w3-wash" ref={washRef} aria-hidden="true" />

      <header className="w3-studio__top">
        <div className="w3-studio__side">
          {detail ? (
            <button type="button" className="w3-st-topbtn" onClick={() => void toLibrary()}>
              <Icon name="chevronLeft" size="sm" />
              Library
            </button>
          ) : (
            <button
              type="button"
              className="w3-st-topbtn"
              onClick={() => void controller.exitStudio()}
            >
              <Icon name="chevronLeft" size="sm" />
              {backLabel}
            </button>
          )}
        </div>
        <div className="w3-studio__side w3-studio__side--right">
          {detail ? (
            <button
              type="button"
              className="w3-st-topbtn"
              onClick={() => void controller.exitStudio()}
            >
              <Icon name="home" size="sm" />
              {backLabel}
            </button>
          ) : null}
        </div>
      </header>

      <Island
        mode={islandMode}
        generating={false}
        onCollapse={() => setMode(null)}
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        wingsPinned={false}
        wingLeft={null}
        wingRight={null}
        panes={{
          rest: restPane,
          search: (
            <SearchPane
              active={islandMode === 'search'}
              items={searchItems}
              placeholder={detail ? 'Another card, or a section of this one' : 'Find a card'}
              onRun={(item) => {
                setMode(null);
                item.run();
              }}
            />
          ),
          changes: changesPane,
        }}
      />

      <div className="w3-studio__body">
        <ErrorBoundary where="Studio" resetKeys={[detail?.avatar ?? null]}>
          {detail && opened ? (
            <StudioBench
              key={detail.avatar}
              detail={detail}
              opened={opened}
              folders={folders}
              books={library.books}
              countTokens={app.countTokens}
              loreSettings={prefs.worldInfo}
              preset={library.preset}
              persona={persona}
              personaUrl={personaUrl}
              handle={benchRef}
              onReport={setReport}
              onSaved={(saved) => {
                setDetail(saved);
                setCards((current) =>
                  current.map((card) =>
                    card.avatar === saved.avatar ? { ...card, ...saved } : card,
                  ),
                );
              }}
              onRenamed={(saved) => {
                setDetail(saved);
                void refreshCards().catch(fail);
              }}
              onDeleted={() => {
                const name = detail.card.data.name;
                setDetail(null);
                setOpened(null);
                setReport(null);
                say({ icon: 'trash', title: 'Deleted', text: name });
                void refreshCards().catch(fail);
              }}
              onCoCreator={(avatar) => void controller.enterCoCreatorFromStudio(avatar)}
              onExport={(avatar, format, flush) => void exportCard(avatar, format, flush)}
              onDuplicate={(avatar, flush) =>
                void duplicate(
                  { avatar, name: detail.card.data.name, folder: detail.folder },
                  flush,
                )
              }
              registerPersistence={register}
            />
          ) : (
            <StudioDesk
              characters={cards}
              folders={folders}
              versions={library.characterAvatarVersions}
              countTokens={app.countTokens}
              busy={busy}
              actions={{
                onOpen: (avatar) => void open(avatar),
                onNew: () => void create(),
                onImport: (files, folder) => void importFiles(files, folder),
                onCoCreator: () => void controller.enterCoCreator(),
                onDuplicate: (card) => void duplicate(card),
                onExport: (card) => void exportCard(card.avatar, 'png'),
                onHover: setHover,
              }}
            />
          )}
        </ErrorBoundary>
      </div>
    </div>
  );
}
